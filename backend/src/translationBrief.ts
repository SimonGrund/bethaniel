// ── Translation brief: what Betty asks before she translates ──
//
// After an author pays for a translation, Betty reads the book and asks a
// handful of questions a translator would otherwise guess at — keep a name or
// translate it, what to do with "Mr", miles or a book title — and the answers
// bind every stage of the run (see /queue/add).
//
// The model never reads the whole book for this. The candidates are counted
// here, deterministically, over every word of it, so a name that lives only
// in chapter 30 is still found and the call costs the same for any length.

import { capitalisesNouns, isSentenceInitial } from "./spellcheck.js";
import { parseJsonResponse } from "./llm.js";
import { buildBriefQuestionsPrompt } from "./prompts.js";
import type { LlmCall } from "./storyAnalysis.js";
import { parseTermList } from "./termList.js";

export type CandidateKind =
  | "name"
  | "invented"
  | "honorific"
  | "unit"
  | "title"
  | "phrase"
  | "acronym";

export interface BriefCandidate {
  term: string;
  kind: CandidateKind;
  count: number;
  /** The sentence it first appeared in, trimmed. */
  example: string;
}

/** A name, invented word or phrase seen fewer times is not worth a question. */
const MIN_REPEATS = 3;
/** An acronym is rarer and almost always a term: twice is enough. */
const MIN_ACRONYM_REPEATS = 2;
const MAX_CANDIDATES = 60;
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

/** Roman numerals are capitals too, and never a term ("Part II"). */
const ROMAN = /^[IVXLCDM]+$/;

/** Words that end a phrase rather than belong to one: the function words of
 *  each language, plus the commonest time adverbs ("today", "now"), which
 *  otherwise glue themselves to the end of every repeated noun phrase.
 *  Words under three letters never count, so the shortest are left out. */
const FUNCTION_WORDS: Record<string, string[]> = {
  en: ("the and but for with from are was were been its this that these those his her " +
    "their our not then than there here must will would can could should may has have had " +
    "does did before after without under over into out about all any each more most some " +
    "such only own same very just also today now again always never when where which who " +
    "whom what while because shall might").split(" "),
  da: ("og at er en et den det de til af på med for som har var ikke der han hun jeg men " +
    "om så fra sig skal kan vil efter før over under ved hos eller også her nu når hvor " +
    "hvis fordi altid aldrig igen").split(" "),
  de: ("der die das und ist ein eine einen dem den des von mit für auf nicht sich als " +
    "auch sie wir ich bei nach vor über unter oder aber wenn noch nur wie hat war wird " +
    "werden kann muss soll darf heute immer nie wieder weil").split(" "),
  es: ("los las una del con por para que son sus como más pero este esta ese esa fue ser " +
    "sin sobre entre cuando también debe puede deberá hoy ahora siempre nunca porque").split(" "),
  fr: ("les une des dans par pour sur avec sans que qui est sont pas cette ces son ses " +
    "elle ils nous vous mais plus comme avant après sous doit peut aujourd hui toujours jamais " +
    "parce").split(" "),
};

/** True when the word at `index` begins its line, past any Markdown or
 *  quotation marks: the line after a heading opens a sentence even though
 *  the heading ended without a full stop. */
function startsLine(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && /[ \t*_"'“‘«>#-]/.test(text[i])) i--;
  return i < 0 || text[i] === "\n";
}

/** Every word the text uses in lowercase somewhere. A capitalised word that
 *  is also there in lowercase ("Data" beside "data") is an ordinary word
 *  in a title or at a line start, not a name. */
function lowercaseWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(WORD_RE)) if (m[0][0] === m[0][0].toLowerCase()) out.add(m[0]);
  return out;
}

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
  const lower = nounsCapitalised ? new Set<string>() : lowercaseWords(text);
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
    if (w.length <= 6 && w === w.toUpperCase() && w !== w.toLowerCase()) {
      if (!ROMAN.test(w)) bump("acronym", w, i);
      continue;
    }
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
      if (isSentenceInitial(text, i) || startsLine(text, i)) continue;
      if (nounsCapitalised && (!isKnownWord || isKnownWord(w))) continue;
      if (lower.has(w.toLowerCase())) continue;
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

  for (const p of collectPhrases(text, base)) tally.set(`phrase|${p.term}`, p);

  const kept = [...tally.values()].filter((c) => {
    if (c.kind === "acronym") return c.count >= MIN_ACRONYM_REPEATS;
    if (c.kind === "name" || c.kind === "invented" || c.kind === "phrase") return c.count >= MIN_REPEATS;
    return true;
  });
  kept.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  return kept.slice(0, MAX_CANDIDATES);
}

/**
 * Two- and three-word runs of content words seen at least MIN_REPEATS times:
 * the "due diligence" and "data controller" a professional text is made of,
 * which no capital letter and no dictionary miss would find. A run ends at
 * any punctuation or line break and at a function word. A phrase inside a
 * longer one that is just as frequent is dropped — "load bearing" is only
 * ever part of "load bearing wall". Counted case-insensitively, reported in
 * the spelling the book uses most, so the term is verbatim in the text.
 */
function collectPhrases(text: string, base: string): BriefCandidate[] {
  const stop = new Set(FUNCTION_WORDS[base] ?? FUNCTION_WORDS.en);
  const grams = new Map<string, { count: number; forms: Map<string, number>; index: number }>();
  let run: { w: string; start: number; end: number }[] = [];
  let prevEnd = 0;
  const flush = () => {
    for (let n = 2; n <= 3; n++) {
      for (let k = 0; k + n <= run.length; k++) {
        const slice = run.slice(k, k + n);
        const key = slice.map((t) => t.w.toLowerCase()).join(" ");
        const form = slice.map((t) => t.w).join(" ");
        const g = grams.get(key) ?? { count: 0, forms: new Map(), index: slice[0].start };
        g.count++;
        g.forms.set(form, (g.forms.get(form) ?? 0) + 1);
        grams.set(key, g);
      }
    }
    run = [];
  };
  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0];
    const start = m.index ?? 0;
    // Anything but spaces between two words — a comma, a full stop, a line
    // break — ends the phrase.
    if (/[^ \t]/.test(text.slice(prevEnd, start))) flush();
    prevEnd = start + w.length;
    if (w.length < 3 || stop.has(w.toLowerCase())) {
      flush();
      continue;
    }
    run.push({ w, start, end: prevEnd });
  }
  flush();

  const frequent = [...grams].filter(([, g]) => g.count >= MIN_REPEATS);
  const out: BriefCandidate[] = [];
  for (const [key, g] of frequent) {
    const covered = frequent.some(
      ([other, o]) => other !== key && o.count >= g.count && ` ${other} `.includes(` ${key} `),
    );
    if (covered) continue;
    const term = [...g.forms].sort((a, b) => b[1] - a[1])[0][0];
    out.push({ term, kind: "phrase", count: g.count, example: exampleAt(text, g.index) });
  }
  return out;
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
  /** For a question about a term: the exact text this option renders it as,
   *  in the target language — what the brief binds and the glossary keeps. */
  rendering?: string;
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
export const MAX_GLOSSARY_ROWS = 40;
/** A forty-row table, five questions and condensed instructions. At 2,400
 *  a long translator brief's answer was cut off mid-JSON on a real run. */
export const BRIEF_OUTPUT_TOKENS = 4000;
/** Betty's condensed instructions, as they ride in every chunk. */
const MAX_INSTRUCTIONS_CHARS = 2000;

/** One row of the table: a term, how it is rendered, or kept as written. */
export interface GlossaryRow {
  term: string;
  rendering: string;
  keep: boolean;
  /** Came from the author's saved glossary for this language pair. */
  saved?: boolean;
  /** The author's own: from their term list, their notes or their style
   *  guide's glossary. */
  author?: boolean;
}

/** What the saved glossary holds for one language pair (db.ts). */
export type SavedGlossaryEntry = Omit<GlossaryRow, "saved">;

/** What one answer from the model holds. */
export interface BriefParse {
  questions: BriefQuestion[];
  glossary: GlossaryRow[];
  /** The author's notes, condensed by Betty into rules for every chunk. */
  instructions?: string;
}

export interface BriefResult extends BriefParse {
  /** The author's term list, the lines that were not rows — kept verbatim
   *  for the brief. */
  authorNotes: string;
  /** Every row of the author's list, terms this book lacks included: the
   *  whole list is saved for the next translation in the language pair. */
  listRows: SavedGlossaryEntry[];
  instructions: string;
  /** Both of Betty's answers were unusable: the table holds only what was
   *  decided before she read, and the app says so. */
  degraded?: true;
}

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
    const rendering = str((opt as Record<string, unknown>).rendering);
    options.push(rendering ? { id: oid, label, rendering } : { id: oid, label });
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
  return parseBriefResponse(raw, sourceText)?.questions ?? null;
}

function questionsFrom(list: unknown[], sourceText: string): BriefQuestion[] {
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

/**
 * The same term in another number: "data subject" / "data subjects",
 * "Maßnahme" / "Maßnahmen", "begreb" / "begreber". One is the other plus an
 * ending of at most two letters. Two rows for one term would let the
 * translation render them differently, which is what a glossary prevents.
 */
function samePlural(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 2 && /^\p{L}+$/u.test(long.slice(short.length));
}

function glossaryFrom(list: unknown, sourceText: string, asked: Set<string>, lang: string): GlossaryRow[] {
  if (!Array.isArray(list)) return [];
  // The same test as for name candidates, for what the model proposes on
  // its own: a single function word, or a capitalised word the text also
  // uses in lowercase, is no term ("The", "Data"). Not in German, where
  // every noun is capitalised and the lowercase test means nothing.
  const base = baseLang(lang);
  const stop = new Set(FUNCTION_WORDS[base] ?? FUNCTION_WORDS.en);
  const lower = capitalisesNouns(base) ? new Set<string>() : lowercaseWords(sourceText);
  const ordinary = (term: string) =>
    !/\s/.test(term) && (stop.has(term.toLowerCase()) || (term[0] !== term[0].toLowerCase() && lower.has(term.toLowerCase())));
  const out: GlossaryRow[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const term = str(o.term);
    // Verbatim in the book, once, and not already a question of its own.
    if (!term || !sourceText.includes(term) || seen.has(term) || asked.has(term)) continue;
    if (ordinary(term)) continue;
    if (out.some((r) => samePlural(r.term, term))) continue;
    const keep = o.keep === true;
    const rendering = keep ? term : str(o.rendering);
    if (!rendering) continue;
    seen.add(term);
    // A row Betty made from the author's own notes is the author's decision.
    out.push(o.fromNotes === true ? { term, rendering, keep, author: true } : { term, rendering, keep });
    if (out.length === MAX_GLOSSARY_ROWS) break;
  }
  return out;
}

/**
 * The whole answer: Betty's questions and her table. `null` when it could
 * not be used at all (not JSON, no `questions` array) and is worth a retry;
 * a missing or broken table on its own is just an empty one.
 */
export function parseBriefResponse(raw: string, sourceText: string, lang = "en"): BriefParse | null {
  const parsed = parseJsonResponse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as { questions?: unknown; glossary?: unknown };
  if (!Array.isArray(o.questions)) return null;
  const questions = questionsFrom(o.questions, sourceText);
  const asked = new Set(questions.flatMap((q) => (q.term ? [q.term] : [])));
  const instructions = str((o as { instructions?: unknown }).instructions)?.slice(0, MAX_INSTRUCTIONS_CHARS);
  return {
    questions,
    glossary: glossaryFrom(o.glossary, sourceText, asked, lang),
    ...(instructions ? { instructions } : {}),
  };
}

/**
 * Whether a listed term occurs in the book: as written, or in its other
 * number — "Belastende hændelser" in a book that says "belastende hændelse",
 * "contingency plan" in one that says "plans". The same at-most-two-letter
 * ending samePlural allows; the shorter form must keep four letters.
 */
function occursIn(lowerText: string, term: string): boolean {
  const t = term.toLowerCase();
  if (lowerText.includes(t)) return true;
  for (const cut of [1, 2]) {
    if (t.length - cut >= 4 && /\p{L}{1,2}$/u.test(t) && lowerText.includes(t.slice(0, -cut))) return true;
  }
  return false;
}

/** How many saved (or listed) terms one book can bring into its table. */
const MAX_SAVED_ROWS = 300;

/**
 * The author's saved glossary for this language pair, laid over Betty's
 * table: a saved term the book contains takes its saved rendering, and one
 * she did not list is added. The author already decided these once.
 */
export function mergeSavedGlossary(
  rows: GlossaryRow[],
  saved: SavedGlossaryEntry[],
  sourceText: string,
  /** What the laid-over rows are: the saved glossary, or the author's list. */
  mark: "saved" | "author" = "saved",
): GlossaryRow[] {
  const lowerText = sourceText.toLowerCase();
  const inBook = saved
    .filter((e) => e.term && occursIn(lowerText, e.term))
    .slice(0, MAX_SAVED_ROWS);
  const marked = (e: SavedGlossaryEntry): GlossaryRow =>
    mark === "author"
      ? { term: e.term, rendering: e.rendering, keep: e.keep, author: true }
      : { term: e.term, rendering: e.rendering, keep: e.keep, saved: true };
  const out: GlossaryRow[] = [];
  const listed = new Set<string>();
  for (const r of rows) {
    // A saved entry for this term — or for it in the other number — wins.
    const e = inBook.find((e) => e.term === r.term) ?? inBook.find((e) => samePlural(e.term, r.term));
    const row = e ? marked(e) : r;
    if (listed.has(row.term)) continue;
    listed.add(row.term);
    out.push(row);
  }
  for (const e of inBook) {
    if (!listed.has(e.term)) out.push(marked(e));
  }
  return out;
}

export interface BriefRequest {
  text: string;
  /** What the author pasted or uploaded on the term-list card. */
  termList?: string;
  /** The author's style sheet; a glossary in it counts as decided. */
  styleGuide?: string;
  manuscriptLang: string;
  /** A language name, as the wizard stores it ("French"). */
  targetLang: string;
  /** The interface language code (store.lang). */
  uiLang: string;
}

export interface BriefDeps {
  llm: LlmCall;
  isKnownWord?: (word: string) => boolean;
  /** The author's saved glossary for this source and target language. */
  savedGlossary?: SavedGlossaryEntry[];
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
): Promise<BriefResult> {
  const candidates = collectBriefCandidates(req.text, req.manuscriptLang, deps.isKnownWord);
  const ui = baseLang(req.uiLang);
  const system = buildBriefQuestionsPrompt({
    sourceLanguage: LANGUAGE_NAMES[baseLang(req.manuscriptLang)] ?? "the source language",
    targetLanguage: req.targetLang,
    uiLanguage: UI_LANGS.has(ui) ? LANGUAGE_NAMES[ui] : "English",
  });
  // Decided before Betty reads a word, in this order of authority: the
  // author's list on this run, a glossary in their style sheet, then what
  // they settled on an earlier translation in this language pair. None of it
  // is hers to ask about again; all of it is what her own suggestions must
  // stay consistent with.
  const list = parseTermList(req.termList ?? "");
  const sheetRows = parseTermList(req.styleGuide ?? "").rows;
  const lowerText = req.text.toLowerCase();
  const inBook = (e: SavedGlossaryEntry) => occursIn(lowerText, e.term);
  const author = uniqueTerms([...list.rows, ...sheetRows]).filter(inBook);
  const saved = (deps.savedGlossary ?? []).filter(inBook);
  const decidedEntries = uniqueTerms([...author, ...saved]).slice(0, MAX_DECIDED);
  const decided = new Set(decidedEntries.map((e) => e.term.toLowerCase()));
  const authorNotes = list.rest.slice(0, MAX_NOTES_CHARS);
  const user = JSON.stringify({
    candidates,
    excerpts: sampleExcerpts(req.text),
    decided: decidedEntries.map(({ term, rendering }) => ({ term, rendering })),
    authorNotes,
  });
  const finish = (parsed: BriefParse | null): BriefResult => {
    const fromSaved = mergeSavedGlossary(parsed?.glossary ?? [], saved, req.text);
    const merged = mergeSavedGlossary(fromSaved, author, req.text, "author");
    // The author's own rows lead the table — their list's in its order, then
    // what Betty took from their notes — then the saved ones, then hers.
    const listed = new Map(author.map((e, i) => [e.term, i]));
    const rank = (r: GlossaryRow) =>
      listed.has(r.term) ? listed.get(r.term)! : r.author ? 1e4 : r.saved ? 2e4 : 3e4;
    return {
      questions: (parsed?.questions ?? []).filter((q) => !q.term || !decided.has(q.term.toLowerCase())),
      glossary: merged.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r),
      authorNotes: list.rest,
      listRows: list.rows,
      instructions: parsed?.instructions ?? "",
      ...(parsed === null ? { degraded: true as const } : {}),
    };
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const payload =
      attempt === 0
        ? user
        : `${user}\n\nYOUR PREVIOUS RESPONSE WAS NOT VALID JSON IN THE REQUIRED SHAPE. Respond again with STRICT valid JSON only — no prose, no code fences.`;
    const raw = await deps.llm(system, payload, { maxTokens: BRIEF_OUTPUT_TOKENS });
    const parsed = parseBriefResponse(raw, req.text, req.manuscriptLang);
    if (parsed !== null) return finish(parsed);
  }
  return finish(null);
}

/** At most this many decided terms go to the model by name. */
const MAX_DECIDED = 150;
/** The author's notes the model reads. At 4,000 a real translator brief's
 *  term section — past the first four pages — never reached her. */
const MAX_NOTES_CHARS = 30_000;

/** One entry per term, ignoring case; the first wins. */
function uniqueTerms(entries: SavedGlossaryEntry[]): SavedGlossaryEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const k = e.term.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** At most this many rows are saved from one run, each term and rendering
 *  at most this long — the table is a list of terms, never a manuscript. */
const MAX_SAVE_ROWS = 1000;
const MAX_TERM_CHARS = 200;

/** The rows a run's table saves, from whatever the app sent: trimmed, one
 *  per term, a kept term stored as itself. */
export function glossaryRowsToSave(rows: unknown): SavedGlossaryEntry[] {
  if (!Array.isArray(rows)) return [];
  const out: SavedGlossaryEntry[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const term = str(o.term);
    if (!term || term.length > MAX_TERM_CHARS || seen.has(term)) continue;
    const keep = o.keep === true;
    const rendering = keep ? term : str(o.rendering);
    if (!rendering || rendering.length > MAX_TERM_CHARS) continue;
    seen.add(term);
    out.push({ term, rendering, keep });
    if (out.length === MAX_SAVE_ROWS) break;
  }
  return out;
}
