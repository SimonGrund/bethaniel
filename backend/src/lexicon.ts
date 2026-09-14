// ── Manuscript lexicon — the names and terms the book itself vouches for ──
//
// Every guard against a name being "corrected" used to judge the word by its
// SHAPE: capitalised, not in the dictionary, letters changed. That is how
// "Petran" became "Petra" — the replacement is a real word sharing five
// letters, which is exactly what a genuine typo fix looks like — and why
// "leave proper nouns alone" in the prompt was never enough on its own.
//
// This module judges by EVIDENCE instead. A word the manuscript spells the
// same way, again and again, is a word the author means: a character, a
// place, a spell, a title. Harvested once on upload, deterministically (no
// model — a count over the text and a dictionary lookup), shown to the author
// to confirm, and then enforced two ways: the confirmed terms go into the
// prompt as ground truth, and gateProtectedTerms() drops any correction that
// would still change one. The first is advice; the second is a rule.
//
// Kept pure: the dictionary comes in as a predicate so the harvest is
// testable without Hunspell and degrades to capitalisation-only evidence
// for a language with no dictionary.

import type { Correction } from "./types.js";
import { capitalisesNouns, isSentenceInitial, normalizeApostrophes } from "./spellcheck.js";

export type LexiconKind = "name" | "word" | "phrase";

export interface LexiconTerm {
  /** Canonical form — the casing the manuscript uses most. */
  term: string;
  /** Occurrences of the canonical form. */
  count: number;
  /** name: capitalised mid-sentence; word: lowercase and not in the
   *  dictionary (a spell, a coinage); phrase: a run of capitalised words. */
  kind: LexiconKind;
  source: "harvest" | "manual";
  /** Protected. Harvested terms start on; the author unticks. */
  enabled: boolean;
  /** Other casings seen, if any — "GATA", "gata". Shown as a hint. */
  variants?: string[];
}

/** A rare token one edit away from a frequent term: the typo the author
 *  DOES want fixed. Offered as a hint, never protected. */
export interface LexiconNearMiss {
  term: string;
  of: string;
  count: number;
}

export interface Lexicon {
  version: 1;
  harvestedAt: number;
  terms: LexiconTerm[];
  nearMisses: LexiconNearMiss[];
}

export interface HarvestOptions {
  lang?: string;
  /** Dictionary predicate: true for a real word. Null when no dictionary is
   *  available, in which case lowercase coinages cannot be told from prose
   *  and only capitalised evidence counts. */
  isWord?: ((w: string) => boolean) | null;
  /** Occurrences before a spelling counts as deliberate. */
  minCount?: number;
  /** Cap on the list, by frequency. */
  maxTerms?: number;
}

const DEFAULT_MIN_COUNT = 3;
const DEFAULT_MAX_TERMS = 400;
const MAX_PHRASE_WORDS = 5;

// Same token shape as spellcheck.ts: letters, inner apostrophes and hyphens.
const WORD_RE = /\p{L}[\p{L}'’ʼ-]*\p{L}|\p{L}/gu;

// Words allowed INSIDE a capitalised phrase without breaking it: "Tome of the
// Eternal Vigil", "Order von Rothenfels". Lowercase, so they are never a
// phrase's first or last word.
const PHRASE_CONNECTORS = new Set([
  "of", "the", "and", "de", "del", "della", "di", "da", "du", "des", "la", "le",
  "les", "von", "van", "der", "den", "die", "das", "af", "og", "und", "y", "e",
  "a", "al", "el", "los", "las", "do", "dos", "das", "zu", "zur", "zum", "til",
]);

// Punctuation that ends a phrase run even without ending the sentence.
const PHRASE_BREAK_RE = /[,;:()\[\]"“”«»—–]/;

function isCapitalised(w: string): boolean {
  const first = w[0];
  return first !== undefined && first !== first.toLowerCase() && first === first.toUpperCase();
}

function isAllCaps(w: string): boolean {
  return w.length > 1 && w === w.toUpperCase() && w !== w.toLowerCase();
}

/** Lines that are structure, not prose: headings, scene breaks, page breaks.
 *  A chapter heading is title case by convention, which is not evidence. */
function proseOnly(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (/^#{1,6}\s/.test(t)) return "";
      if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$|^(#\s*){3,}$/.test(t)) return "";
      if (/^<!--.*-->$/.test(t)) return "";
      return line;
    })
    .join("\n");
}

interface TokenStats {
  /** exact form → occurrences */
  forms: Map<string, number>;
  /** capitalised AND not opening a sentence */
  midCap: number;
  total: number;
}

/** Damerau-Levenshtein distance capped at 2 — enough to ask "one edit away?". */
function editDistance1(a: string, b: string): boolean {
  if (a === b) return false;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    // One substitution, or one adjacent transposition.
    let i = 0;
    while (i < la && a[i] === b[i]) i++;
    if (i === la) return false;
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return (
      i + 1 < la &&
      a[i] === b[i + 1] &&
      a[i + 1] === b[i] &&
      a.slice(i + 2) === b.slice(i + 2)
    );
  }
  // One insertion or deletion.
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0;
  while (i < s.length && s[i] === l[i]) i++;
  return s.slice(i) === l.slice(i + 1);
}

/**
 * Harvest the manuscript's own vocabulary.
 *
 * A term is any of:
 *  - name: capitalised somewhere other than a sentence start, spelled that
 *    way at least minCount times, and not a dictionary word. Sentence-initial
 *    occurrences are not evidence — "Thirteen" opens a chapter, it is not a
 *    person — but once a word has earned its place mid-sentence, every
 *    occurrence counts. In a noun-capitalising language (German) the
 *    dictionary is what separates a name from a noun, so without one the
 *    name list is skipped there rather than filled with every noun.
 *  - word: lowercase, not in the dictionary, at least minCount times: a
 *    spell, a coined verb, a made-up drink. Needs a dictionary.
 *  - phrase: a run of two to five capitalised words (connectors allowed in
 *    the middle) recurring at least minCount times, whatever its parts are:
 *    "Flame Thief" is two dictionary words and one title.
 *
 * Near misses are rare tokens one edit from a frequent name: "Silverhnad"
 * beside forty "Silverhand"s is the typo the author wants caught, and the
 * list makes sure a harvest never hides it.
 */
export function harvestLexicon(md: string, opts: HarvestOptions = {}): Lexicon {
  const minCount = opts.minCount ?? DEFAULT_MIN_COUNT;
  const maxTerms = opts.maxTerms ?? DEFAULT_MAX_TERMS;
  const isWord = opts.isWord ?? null;
  const nounCaps = capitalisesNouns(opts.lang);
  const text = proseOnly(md);

  const stats = new Map<string, TokenStats>();
  const phraseCounts = new Map<string, number>();

  // Phrase runs are built as tokens stream past; the gap between two tokens
  // decides whether a run continues.
  let run: string[] = [];
  let runEnd = -1;
  const isConnector = (w: string) => PHRASE_CONNECTORS.has(w.toLowerCase());
  const flushRun = () => {
    // Trim connectors off either end; a phrase starts and ends on a real
    // word, and "The" in front of one is the article, not the title.
    while (run.length && isConnector(run[0])) run.shift();
    while (run.length && isConnector(run[run.length - 1])) run.pop();
    const caps = run.filter((w) => isCapitalised(w) && !isConnector(w)).length;
    if (run.length >= 2 && run.length <= MAX_PHRASE_WORDS && caps >= 2) {
      const p = run.join(" ");
      phraseCounts.set(p, (phraseCounts.get(p) ?? 0) + 1);
    }
    run = [];
  };

  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text)) !== null) {
    const raw = m[0];
    const w = normalizeApostrophes(raw);
    const key = w.toLowerCase();
    const cap = isCapitalised(w);
    const initial = isSentenceInitial(text, m.index);

    let s = stats.get(key);
    if (!s) {
      s = { forms: new Map(), midCap: 0, total: 0 };
      stats.set(key, s);
    }
    s.forms.set(w, (s.forms.get(w) ?? 0) + 1);
    s.total++;
    if (cap && !initial) s.midCap++;

    // Phrase run bookkeeping.
    const gap = runEnd >= 0 ? text.slice(runEnd, m.index) : "";
    const breaks = runEnd < 0 || PHRASE_BREAK_RE.test(gap) || /\n/.test(gap) || initial;
    if (breaks) flushRun();
    // A sentence opener never joins a run: "Then Gata ran" three times is
    // not a title called "Then Gata". A title that happens to open a
    // sentence loses that one count, which it can afford.
    if ((cap && !initial) || (run.length > 0 && PHRASE_CONNECTORS.has(key))) {
      run.push(w);
    } else {
      flushRun();
    }
    runEnd = m.index + raw.length;
  }
  flushRun();

  const terms: LexiconTerm[] = [];
  const nameKeys = new Map<string, LexiconTerm>();

  for (const [key, s] of stats) {
    if (key.length < 3 && !isAllCaps(key)) continue;
    if (/^\d/.test(key)) continue;

    // Dominant form and the rest.
    const forms = [...s.forms.entries()].sort((a, b) => b[1] - a[1]);
    const [canonical, canonicalCount] = forms[0];
    const variants = forms.slice(1).map(([f]) => f);
    const inDictionary = isWord ? isWord(key) || isWord(canonical) : null;

    if (isCapitalised(canonical) && s.midCap >= 1 && canonicalCount >= minCount) {
      // A word the dictionary knows is not what this list is for: nothing
      // will call "Grace" a typo. In German that check is the whole test.
      if (inDictionary === true) continue;
      if (inDictionary === null && nounCaps) continue;
      const t: LexiconTerm = {
        term: canonical,
        count: canonicalCount,
        kind: "name",
        source: "harvest",
        enabled: true,
      };
      if (variants.length) t.variants = variants;
      terms.push(t);
      nameKeys.set(key, t);
      continue;
    }

    if (!isCapitalised(canonical) && inDictionary === false && canonicalCount >= minCount) {
      if (key.length < 4) continue;
      // Hyphenated compounds of real words are spelling, not vocabulary.
      if (key.includes("-") && key.split("-").every((p) => p.length >= 2 && isWord!(p))) continue;
      const t: LexiconTerm = {
        term: canonical,
        count: canonicalCount,
        kind: "word",
        source: "harvest",
        enabled: true,
      };
      if (variants.length) t.variants = variants;
      terms.push(t);
    }
  }

  for (const [phrase, n] of phraseCounts) {
    if (n < minCount) continue;
    terms.push({ term: phrase, count: n, kind: "phrase", source: "harvest", enabled: true });
  }

  // Near misses: rare, name-shaped, one edit from a well-attested name, and
  // not a word in its own right.
  const nearMisses: LexiconNearMiss[] = [];
  for (const [key, s] of stats) {
    if (s.total > 2 || key.length < 4) continue;
    if (nameKeys.has(key)) continue;
    if (isWord && isWord(key)) continue;
    for (const [nameKey, name] of nameKeys) {
      if (name.count < 5) continue;
      if (nameKey[0] !== key[0]) continue;
      if (!editDistance1(key, nameKey)) continue;
      const form = [...s.forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
      nearMisses.push({ term: form, of: name.term, count: s.total });
      break;
    }
  }

  terms.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  nearMisses.sort((a, b) => a.of.localeCompare(b.of) || a.term.localeCompare(b.term));

  return {
    version: 1,
    harvestedAt: Date.now(),
    terms: terms.slice(0, maxTerms),
    nearMisses,
  };
}

// ── Validation of a lexicon sent by the client ──

const MAX_TERM_LENGTH = 80;

/** Accept only the shape the app writes; anything else is a 400. */
export function parseLexicon(input: unknown): Lexicon | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (!Array.isArray(o.terms)) return null;
  const seen = new Set<string>();
  const terms: LexiconTerm[] = [];
  for (const raw of o.terms) {
    if (!raw || typeof raw !== "object") return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.term !== "string") return null;
    const term = t.term.trim().replace(/\s+/g, " ");
    if (!term || term.length > MAX_TERM_LENGTH || seen.has(term)) continue;
    seen.add(term);
    const kind: LexiconKind =
      t.kind === "word" || t.kind === "phrase" ? t.kind : term.includes(" ") ? "phrase" : "name";
    const entry: LexiconTerm = {
      term,
      count: typeof t.count === "number" && Number.isFinite(t.count) ? Math.max(0, Math.floor(t.count)) : 0,
      kind,
      source: t.source === "manual" ? "manual" : "harvest",
      enabled: t.enabled !== false,
    };
    if (Array.isArray(t.variants)) {
      const v = t.variants.filter((x): x is string => typeof x === "string" && x.length <= MAX_TERM_LENGTH);
      if (v.length) entry.variants = v;
    }
    terms.push(entry);
  }
  const nearMisses: LexiconNearMiss[] = Array.isArray(o.nearMisses)
    ? o.nearMisses
        .filter(
          (x): x is LexiconNearMiss =>
            !!x &&
            typeof x === "object" &&
            typeof (x as LexiconNearMiss).term === "string" &&
            typeof (x as LexiconNearMiss).of === "string",
        )
        .map((x) => ({ term: x.term, of: x.of, count: typeof x.count === "number" ? x.count : 1 }))
    : [];
  return {
    version: 1,
    harvestedAt: typeof o.harvestedAt === "number" ? o.harvestedAt : Date.now(),
    terms,
    nearMisses,
  };
}

// ── What a job carries ──

/** The enabled terms, split by how they are matched: single tokens by
 *  token, phrases by substring. */
export interface ProtectedTerms {
  words: string[];
  phrases: string[];
}

export function protectedTermsOf(lexicon: Lexicon | null | undefined): ProtectedTerms | null {
  if (!lexicon) return null;
  const words: string[] = [];
  const phrases: string[] = [];
  for (const t of lexicon.terms) {
    if (!t.enabled) continue;
    if (t.kind === "phrase" || t.term.includes(" ")) phrases.push(t.term);
    else words.push(t.term);
  }
  if (words.length === 0 && phrases.length === 0) return null;
  return { words, phrases };
}

/**
 * The block appended to the style sheet for every prompt that reads one.
 * Rendered through the existing sheet mechanism on purpose: the roles in
 * prompts.ts already give a sheet HIGHEST AUTHORITY for editors and GROUND
 * TRUTH for the reviewer and the analysis, and a name spelled against it is
 * an error to fix — which is the one change to a name that IS wanted.
 */
export function buildLexiconSheetBlock(p: ProtectedTerms | null, maxChars = 6000): string {
  if (!p) return "";
  const all = [...p.words, ...p.phrases];
  let list = all.join(", ");
  if (list.length > maxChars) {
    // Frequency order was set at harvest; keep the head.
    let acc = "";
    for (const term of all) {
      const next = acc ? `${acc}, ${term}` : term;
      if (next.length > maxChars) break;
      acc = next;
    }
    list = acc + ", …";
  }
  return (
    "NAMES & TERMS — the manuscript's own vocabulary, confirmed by the author. " +
    "Each is spelled and capitalised exactly as intended: never change its letters or its casing, " +
    "and never replace it with a dictionary word it resembles. A DIFFERENT spelling of one of these " +
    "in the text is a typo of that name and should be corrected TO the form listed here.\n" +
    list
  );
}

// ── The gate ──

const TOKEN_RE = /[\p{L}\p{N}'’ʼ-]+/gu;

function tokens(s: string): string[] {
  return (s.match(TOKEN_RE) ?? []).map((t) => normalizeApostrophes(t));
}

/** Strip a possessive or elided suffix: Gata's → Gata, Gatas' → Gatas. */
function stem(token: string): string {
  return token.replace(/'s$|'$/i, "");
}

/** The tokens a correction removes and the ones it inserts, with the
 *  unchanged run on either side stripped. Mirrors changedWords() in
 *  correctionSeverity.ts, on the tokeniser the gate needs. */
function changed(c: { original: string; corrected: string }): { del: string[]; ins: string[] } {
  const a = tokens(c.original);
  const b = tokens(c.corrected);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { del: a.slice(i, a.length - j), ins: b.slice(i, b.length - j) };
}

/** The protected term a token IS — itself, its stem, or a hyphen part. */
function protectedIn(token: string, words: ReadonlySet<string>): string | null {
  if (words.has(token)) return token;
  const s = stem(token);
  if (words.has(s)) return s;
  if (token.includes("-")) {
    for (const part of token.split("-")) {
      const ps = stem(part);
      if (words.has(part)) return part;
      if (words.has(ps)) return ps;
    }
  }
  return null;
}

function containsPhrase(text: string, phrase: string): boolean {
  let from = 0;
  while (true) {
    const at = text.indexOf(phrase, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + phrase.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    from = at + 1;
  }
}

export interface GateResult {
  kept: Correction[];
  dropped: { correction: Correction; term: string }[];
}

/**
 * Drop every correction that would change a protected term.
 *
 * Case-sensitive: the casing is part of what is protected, so "Gata" →
 * "gata" is dropped like "Gata" → "Data". What is allowed:
 *  - a change that leaves the term standing (punctuation around it, a word
 *    beside it) — the term is then not among the changed tokens at all;
 *  - a change that moves a variant TO the canonical form ("gata" → "Gata"),
 *    since the removed token is not the protected one;
 *  - a typo of a name fixed to the name ("Silverhnad" → "Silverhand"), for
 *    the same reason.
 * Possessives ("Gata's") and hyphen compounds ("Gata-born") count as the
 * term. A phrase is protected as a whole: a correction that removes it from
 * the text it quotes is dropped.
 *
 * Every dropped correction is handed back with the term that stopped it, so
 * the caller can list it as "left alone" rather than make it vanish.
 */
export function gateProtectedTerms(
  corrections: Correction[],
  protectedTerms: ProtectedTerms | null | undefined,
): GateResult {
  if (!protectedTerms || (protectedTerms.words.length === 0 && protectedTerms.phrases.length === 0)) {
    return { kept: corrections, dropped: [] };
  }
  const words = new Set(protectedTerms.words);
  const phrases = protectedTerms.phrases;
  const kept: Correction[] = [];
  const dropped: GateResult["dropped"] = [];

  for (const c of corrections) {
    let hit: string | null = null;
    const { del, ins } = changed(c);
    const insSet = new Set(ins.map((t) => stem(t)));
    for (const d of del) {
      const term = protectedIn(d, words);
      if (!term) continue;
      // The term survives on the other side: the change is around it.
      if (insSet.has(term) || ins.some((t) => protectedIn(t, words) === term)) continue;
      hit = term;
      break;
    }
    if (!hit) {
      for (const p of phrases) {
        if (containsPhrase(c.original, p) && !containsPhrase(c.corrected, p)) {
          hit = p;
          break;
        }
      }
    }
    if (hit) dropped.push({ correction: c, term: hit });
    else kept.push(c);
  }
  return { kept, dropped };
}
