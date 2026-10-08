// ── Translation brief: what Betty asks before she translates ──
//
// After an author pays for a translation, Betty reads the book and asks a
// handful of questions a translator would otherwise guess at — keep a name or
// translate it, what to do with "Mr", miles or a book title — and the answers
// bind every stage of the run (see combineTranslationNotes and /queue/add).
//
// The model never reads the whole book for this. The candidates are counted
// here, deterministically, over every word of it, so a name that lives only
// in chapter 30 is still found and the call costs the same for any length.

import { capitalisesNouns, isSentenceInitial } from "./spellcheck.js";

export type CandidateKind = "name" | "invented" | "honorific" | "unit" | "title";

export interface BriefCandidate {
  term: string;
  kind: CandidateKind;
  count: number;
  /** The sentence it first appeared in, trimmed. */
  example: string;
}

/** A name or invented word seen fewer times is not worth a question. */
const MIN_REPEATS = 3;
const MAX_CANDIDATES = 40;
const EXAMPLE_CHARS = 200;
/** How far an example looks for its sentence's ends — a run-on paragraph
 *  with no full stop must not turn into a scan of the whole book. */
const EXAMPLE_REACH = 600;

const WORD_RE = /\p{L}[\p{L}'’-]*\p{L}/gu;
/** *Title* or _Title_: up to six words, starting with a capital. */
const TITLE_RE = /(?<![*_\p{L}])[*_]([^*_\n]{2,60})[*_](?![*_\p{L}])/gu;

const HONORIFICS: Record<string, string[]> = {
  en: ["Mr", "Mrs", "Ms", "Miss", "Dr", "Sir", "Lady", "Lord", "Madam"],
  da: ["Hr", "Fru", "Frøken", "Dr"],
  de: ["Herr", "Frau", "Fräulein", "Dr"],
  es: ["Señor", "Señora", "Señorita", "Don", "Doña", "Sr", "Sra", "Dr"],
  fr: ["Monsieur", "Madame", "Mademoiselle", "Mme", "Mlle", "Dr"],
};

/** Imperial units: the ones a translation into a metric language has to
 *  decide about. Lowercased. "foot" and "stone" are left out — far more
 *  often "on foot" and a stone than a measurement. */
const UNITS = new Set([
  "mile", "miles", "feet", "inch", "inches", "yard", "yards", "pound",
  "pounds", "ounce", "ounces", "gallon", "gallons", "acre", "acres", "pint",
  "pints",
]);

export function baseLang(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0];
}

function exampleAt(text: string, index: number): string {
  const stop = /[.!?\n]/;
  let start = index;
  while (start > 0 && index - start < EXAMPLE_REACH && !stop.test(text[start - 1])) start--;
  let end = index;
  while (end < text.length && end - index < EXAMPLE_REACH && !stop.test(text[end])) end++;
  if (end < text.length && text[end] !== "\n") end++;
  const s = text.slice(start, end).replace(/\s+/g, " ").trim();
  return s.length > EXAMPLE_CHARS ? s.slice(0, EXAMPLE_CHARS - 1) + "…" : s;
}

/**
 * The terms in this manuscript a translator would have to decide about.
 *
 * `isKnownWord` is the manuscript language's dictionary
 * (spellcheck.getWordValidator). Without it there are no invented words —
 * and no German names, because in German every noun is capitalised and
 * capitalisation alone would offer "Zeit" as a name.
 */
export function collectBriefCandidates(
  text: string,
  lang: string,
  isKnownWord?: (word: string) => boolean,
): BriefCandidate[] {
  const base = baseLang(lang);
  const honorifics = new Set(HONORIFICS[base] ?? []);
  const nounsCapitalised = capitalisesNouns(base);
  const tally = new Map<string, BriefCandidate>();
  const bump = (kind: CandidateKind, term: string, index: number) => {
    const key = `${kind}|${term}`;
    const seen = tally.get(key);
    if (seen) seen.count++;
    else tally.set(key, { term, kind, count: 1, example: exampleAt(text, index) });
  };

  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0];
    const i = m.index ?? 0;
    if (honorifics.has(w)) {
      bump("honorific", w, i);
      continue;
    }
    if (UNITS.has(w.toLowerCase())) {
      bump("unit", w.toLowerCase(), i);
      continue;
    }
    const capital = w[0] !== w[0].toLowerCase();
    if (capital) {
      if (isSentenceInitial(text, i)) continue;
      if (nounsCapitalised && (!isKnownWord || isKnownWord(w))) continue;
      bump("name", w, i);
    } else if (isKnownWord && w.length >= 4 && !isKnownWord(w)) {
      bump("invented", w, i);
    }
  }

  for (const m of text.matchAll(TITLE_RE)) {
    const inner = m[1].trim();
    if (!/^\p{Lu}/u.test(inner) || inner.split(/\s+/).length > 6) continue;
    bump("title", inner, m.index ?? 0);
  }

  const kept = [...tally.values()].filter(
    (c) => (c.kind !== "name" && c.kind !== "invented") || c.count >= MIN_REPEATS,
  );
  kept.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  return kept.slice(0, MAX_CANDIDATES);
}

/**
 * `count` passages of about `words` words, spread evenly over the book, for
 * the model to hear its tone. Whole paragraphs; one that runs past twice the
 * budget is cut.
 */
export function sampleExcerpts(text: string, count = 4, words = 300): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  const used = new Set<number>();
  for (let k = 0; k < count && paras.length > 0; k++) {
    let p = Math.floor((k * paras.length) / count);
    const taken: string[] = [];
    let n = 0;
    while (p < paras.length && n < words && !used.has(p)) {
      used.add(p);
      taken.push(paras[p]);
      n += paras[p].split(/\s+/).length;
      p++;
    }
    if (taken.length === 0) continue;
    const joined = taken.join("\n\n");
    const ws = joined.split(/\s+/);
    out.push(ws.length > words * 2 ? ws.slice(0, words * 2).join(" ") + " …" : joined);
  }
  return out;
}
