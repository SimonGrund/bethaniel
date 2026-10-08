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
import { parseJsonResponse } from "./llm.js";
import { buildBriefQuestionsPrompt } from "./prompts.js";
import type { LlmCall } from "./storyAnalysis.js";

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

// ── The questions ──

export interface BriefOption {
  id: string;
  label: string;
}

export interface BriefQuestion {
  id: string;
  /** The source term, verbatim from the book, when the question is about one. */
  term?: string;
  question: string;
  options: BriefOption[];
  /** The id of the option Betty would choose. */
  suggested: string;
  why: string;
}

export const MAX_BRIEF_QUESTIONS = 5;
export const BRIEF_OUTPUT_TOKENS = 1200;

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  da: "Danish",
  de: "German",
  es: "Spanish",
  fr: "French",
};
/** The languages the app's own interface is translated into (i18n.ts). */
const UI_LANGS = new Set(["en", "da", "de", "es"]);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

function toQuestion(item: unknown, sourceText: string): BriefQuestion | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const id = str(o.id);
  const question = str(o.question);
  const suggested = str(o.suggested);
  if (!id || !question || !suggested) return null;
  if (!Array.isArray(o.options) || o.options.length < 2 || o.options.length > 4) return null;
  const options: BriefOption[] = [];
  const ids = new Set<string>();
  for (const opt of o.options) {
    if (!opt || typeof opt !== "object") return null;
    const oid = str((opt as Record<string, unknown>).id);
    const label = str((opt as Record<string, unknown>).label);
    if (!oid || !label || ids.has(oid)) return null;
    ids.add(oid);
    options.push({ id: oid, label });
  }
  if (!ids.has(suggested)) return null;
  let term: string | undefined;
  if (o.term !== undefined && o.term !== null) {
    const t = str(o.term);
    // A term the book does not contain is a name the model made up.
    if (!t || !sourceText.includes(t)) return null;
    term = t;
  }
  return { id, ...(term ? { term } : {}), question, options, suggested, why: str(o.why) ?? "" };
}

/**
 * The model's questions, each checked on its own: one malformed question is
 * dropped, the rest kept. `null` means the answer as a whole was unusable
 * (not JSON, no `questions` array) and is worth one retry.
 */
export function parseBriefQuestions(raw: string, sourceText: string): BriefQuestion[] | null {
  const parsed = parseJsonResponse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const list = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(list)) return null;
  const out: BriefQuestion[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const q = toQuestion(item, sourceText);
    if (!q || seen.has(q.id)) continue;
    seen.add(q.id);
    out.push(q);
    if (out.length === MAX_BRIEF_QUESTIONS) break;
  }
  return out;
}

export interface BriefRequest {
  text: string;
  manuscriptLang: string;
  /** A language name, as the wizard stores it ("French"). */
  targetLang: string;
  /** The interface language code (store.lang). */
  uiLang: string;
}

export interface BriefDeps {
  llm: LlmCall;
  isKnownWord?: (word: string) => boolean;
}

/**
 * Ask the paid model for its questions. Two tries at a usable answer, then
 * none — the author still gets the tone question and can start the run.
 * A failing call (network, out of credit) throws; the route turns that into
 * "no questions" too.
 */
export async function runBriefQuestions(
  req: BriefRequest,
  deps: BriefDeps,
): Promise<BriefQuestion[]> {
  const candidates = collectBriefCandidates(req.text, req.manuscriptLang, deps.isKnownWord);
  const ui = baseLang(req.uiLang);
  const system = buildBriefQuestionsPrompt({
    sourceLanguage: LANGUAGE_NAMES[baseLang(req.manuscriptLang)] ?? "the source language",
    targetLanguage: req.targetLang,
    uiLanguage: UI_LANGS.has(ui) ? LANGUAGE_NAMES[ui] : "English",
  });
  const user = JSON.stringify({ candidates, excerpts: sampleExcerpts(req.text) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const payload =
      attempt === 0
        ? user
        : `${user}\n\nYOUR PREVIOUS RESPONSE WAS NOT VALID JSON IN THE REQUIRED SHAPE. Respond again with STRICT valid JSON only — no prose, no code fences.`;
    const raw = await deps.llm(system, payload, { maxTokens: BRIEF_OUTPUT_TOKENS });
    const questions = parseBriefQuestions(raw, req.text);
    if (questions !== null) return questions;
  }
  return [];
}

/**
 * What a translate task reads as its notes: the author's answers first, then
 * their style sheet. The brief is the newer, translation-specific choice, so
 * it wins where the two disagree.
 */
export function combineTranslationNotes(brief: string, styleGuide: string): string {
  const b = brief.trim();
  const s = styleGuide.trim();
  if (!b) return s;
  if (!s) return b;
  return `${b}\n\nSTYLE SHEET (the author's own notes — where they disagree with the brief above, the brief above wins):\n${s}`;
}
