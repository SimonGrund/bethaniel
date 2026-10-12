// ── The author's free-text style sheet, read into rules ──
//
// A style sheet is the author's own words, and that is a selling point: they
// write what they mean, in any language, and Betty follows it. Handed to the
// editor whole, though, one sentence can do three jobs at once, and a small
// model cannot tell them apart. "Take and Give (in all tenses) are
// capitalized when reffering to the magical powers" is a list of words, a
// rule that needs judgement, and a scope — and Local Betty, told it, wrote
// "Take" over "bolt" and lowercased "Givers". Measured on a real novel; see
// noiseGates.ts and houseStyleRules.ts for the rest of that run.
//
// So each statement of the sheet is read on its own into one of five kinds,
// and only the fifth goes to the editor as words:
//
//   replace   "write X, not Y"           → find-and-replace (houseStyleRules)
//   keep      "Givers stay as written"   → the names list
//   casing    "capitalised when magic"   → the words' case is the author's;
//                                           the minority spellings are shown
//                                           for the author to tick
//   dialogue  "pirates speak wrong"      → the author picks the characters;
//                                           their dialogue is left alone
//   note      anything else              → the editor reads it, as before
//
// Reading is code first (a "X, not Y" line needs no model), then ONE small
// question per remaining statement to whichever model will run the job —
// Local Betty or the cloud, the same prompt. Every answer is checked against
// the statement and the book: a term the statement does not contain, or the
// book never uses, is dropped, and a reading that does not survive is a note.
// Nothing is enforced until the author confirms it on a card, so a wrong
// reading costs one click, and the worst case is the sheet as it was.
//
// Pure, except `readStyleSheet`, which takes the model call as an argument.

import { parseHouseStyleRules } from "./houseStyleRules.js";

export type SheetRuleKind = "replace" | "keep" | "casing" | "dialogue" | "note";

export interface SheetRule {
  kind: SheetRuleKind;
  /** The statement it was read from, verbatim. */
  source: string;
  /** replace */
  prefer?: string;
  avoid?: string[];
  /** keep, casing: the words, as the book writes them. */
  terms?: string[];
  /** casing: when the capital applies, in the author's words. */
  when?: string;
  /** dialogue: who, as the statement says it ("pirates"). */
  who?: string;
  /** Already the author's decision — a line their answers to Betty's
   *  house-style questions wrote. Enforced without a card. */
  settled?: boolean;
}

// ── Statements ──

/** Lines the app writes itself (houseStyleAnswers, the names block) and
 *  structure: read elsewhere, or not instructions at all. */
const NOT_A_STATEMENT = [
  /^#{1,6}\s/,
  /^NAMES & TERMS\b/,
  /^[-*_]{3,}$/,
];

/**
 * The sheet as statements: one per line, and a line of several sentences
 * split into them — "Pirates speak wrong. Take and Give are capitalised."
 * is two rules. The names block the app appends (lexicon.ts) ends the
 * sheet: everything after it is the list, not the author's words.
 */
export function splitStatements(sheet: string): string[] {
  const out: string[] = [];
  for (const raw of sheet.split("\n")) {
    const line = raw.trim().replace(/^[-*•]\s+/, "").trim();
    if (!line) continue;
    if (/^NAMES & TERMS\b/.test(line)) break;
    if (NOT_A_STATEMENT.some((re) => re.test(line))) continue;
    // Sentence ends followed by a capital; brackets and quotes kept whole.
    const parts = line.split(/(?<=[.!?])\s+(?=[\p{Lu}“"'(])/u);
    for (const p of parts) if (p.trim()) out.push(p.trim());
  }
  return out;
}

// ── Code first ──

const Q = `["“”'‘’«»„]`;
/** "X, not Y" / "X rather than Y" / "X instead of Y", optionally quoted. */
const REPLACE_PATTERNS: RegExp[] = [
  new RegExp(`^(?:write|use|spell|always write|always use|prefer)?\\s*${Q}?([^"“”'‘’«»„,]+?)${Q}?,?\\s+(?:not|never|rather than|instead of)\\s+${Q}?([^"“”'‘’«»„.]+?)${Q}?\\.?$`, "iu"),
  new RegExp(`^(?:skriv|brug)?\\s*${Q}?([^"“”'‘’«»„,]+?)${Q}?,?\\s+(?:ikke|aldrig|frem for|i stedet for)\\s+${Q}?([^"“”'‘’«»„.]+?)${Q}?\\.?$`, "iu"),
  new RegExp(`^(?:schreibe|verwende)?\\s*${Q}?([^"“”'‘’«»„,]+?)${Q}?,?\\s+(?:nicht|statt|anstatt)\\s+${Q}?([^"“”'‘’«»„.]+?)${Q}?\\.?$`, "iu"),
  new RegExp(`^(?:escribe|usa)?\\s*${Q}?([^"“”'‘’«»„,]+?)${Q}?,?\\s+(?:no|nunca|en lugar de|en vez de)\\s+${Q}?([^"“”'‘’«»„.]+?)${Q}?\\.?$`, "iu"),
];

/** A reading that needs no model: the app's own house-style lines, and a
 *  short "X, not Y" in the author's words. */
export function readByCode(statement: string): SheetRule | null {
  const house = parseHouseStyleRules(statement);
  if (house.length) {
    return { kind: "replace", source: statement, prefer: house[0].prefer, avoid: house[0].avoid, settled: true };
  }
  if (statement.split(/\s+/).length > 10) return null;
  for (const re of REPLACE_PATTERNS) {
    const m = re.exec(statement.trim());
    if (!m) continue;
    let prefer = m[1].trim();
    const avoid = m[2].split(/\s*(?:,|\bor\b|\beller\b|\boder\b|\bo\b)\s*/u).map((s) => s.trim()).filter(Boolean);
    // "Dwarves, not dwarfs.": the capital is the sentence's, not the word's.
    if (statement.trim().startsWith(prefer) && avoid[0] && avoid[0][0] === avoid[0][0].toLowerCase()) {
      prefer = prefer[0].toLowerCase() + prefer.slice(1);
    }
    if (prefer && avoid.length && prefer.split(/\s+/).length <= 3 && avoid.every((a) => a.split(/\s+/).length <= 3)) {
      return { kind: "replace", source: statement, prefer, avoid };
    }
  }
  return null;
}

// ── The model's question ──

export const SHEET_READ_PROMPT = `You read ONE instruction from a novelist's style sheet and say what kind of instruction it is. You do not edit anything.

Answer with ONE JSON object and nothing else. The kinds:

1. "replace" — always write one form instead of another.
   {"kind":"replace","prefer":"<form to use>","avoid":["<form to replace>", ...]}
2. "keep" — these names or words must stay exactly as written.
   {"kind":"keep","terms":["<word>", ...]}
3. "casing" — whether these words are capitalised depends on what they mean in the sentence.
   {"kind":"casing","terms":["<every form the instruction covers>", ...],"when":"<when the capital applies, short>"}
   If it says "all tenses" or "all forms", list them all: the base form, -s, -ing, the past tense (irregular ones too: Took, Gave, Rose), the past participle, and a noun for a person who does it (-er, -ers), each capitalised as the instruction says.
   A word that is ALWAYS capitalised is "keep", not "casing".
4. "dialogue" — some characters or groups speak in a non-standard way on purpose, and their speech must not be corrected.
   {"kind":"dialogue","who":"<the characters or group, as the instruction says it>"}
5. "note" — anything else: dialect, numbers, punctuation, tone, formatting, anything general.
   {"kind":"note"}

Copy words exactly as they are written in the instruction. Never invent a word the instruction does not mention, except the forms of a word in a "casing" instruction that covers all its forms.

Examples:
Instruction: Use "okay", never "OK".
{"kind":"replace","prefer":"okay","avoid":["OK"]}
Instruction: The Order of the Ember and the Ashen Gate are always capitalised.
{"kind":"keep","terms":["Order of the Ember","Ashen Gate"]}
Instruction: Rise is capitalised when it means the sorcery, in every form.
{"kind":"casing","terms":["Rise","Rises","Rising","Rose","Risen","Riser","Risers"],"when":"when it means the sorcery"}
Instruction: The Wardens are always capitalised.
{"kind":"keep","terms":["Wardens"]}
Instruction: The river folk talk in their own broken way, leave it.
{"kind":"dialogue","who":"the river folk"}
Instruction: Spell out numbers under one hundred.
{"kind":"note"}
Instruction: Kammeret skrives altid med stort K.
{"kind":"keep","terms":["Kammeret"]}`;

/** The first JSON object in a reply — models wrap it in fences or prose. */
function firstJson(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < reply.length; i++) {
    if (reply[i] === "{") depth++;
    else if (reply[i] === "}" && --depth === 0) {
      try {
        const v = JSON.parse(reply.slice(start, i + 1));
        return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : [];

const fold = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'");

/** How often the book writes this form, whole-word, exactly as given. */
export function occurrences(text: string, form: string): number {
  const esc = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "gu")) ?? []).length;
}

/** A whole-word pattern for a form, either apostrophe. */
function formPattern(form: string, flags: string): RegExp {
  const esc = form
    .replace(/[’‘]/g, "'")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/'/g, "['’‘]");
  return new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, flags);
}

/** Whole-word, any case, either apostrophe. */
function occurrencesAnyCase(text: string, form: string): number {
  return (text.match(formPattern(form, "giu")) ?? []).length;
}

/** The form the book itself writes, for a term the model spelled with the
 *  other apostrophe or another case: "Lu'Tau" → "Lu’Tau". */
function bookForm(text: string, form: string): string {
  const m = formPattern(form, "u").exec(text) ?? formPattern(form, "iu").exec(text);
  return m ? m[0] : form;
}

/**
 * The model's answer, checked. A term must be in the statement (or, for a
 * "casing" statement that covers every form, share its stem with a word that
 * is) AND in the book; a reading left with nothing is a note.
 */
export function checkReading(statement: string, reply: string, book: string): SheetRule {
  const note: SheetRule = { kind: "note", source: statement };
  const j = firstJson(reply);
  if (!j) return note;
  const said = fold(statement);
  const inStatement = (w: string) => said.includes(fold(w));
  const inBook = (w: string) => occurrencesAnyCase(book, w) > 0;
  switch (j.kind) {
    case "replace": {
      const prefer = typeof j.prefer === "string" ? j.prefer.trim() : "";
      const avoid = strings(j.avoid).filter((a) => inStatement(a) && fold(a) !== fold(prefer));
      if (!prefer || !inStatement(prefer)) return note;
      // Nothing to replace — the model's other form is not the author's, or
      // not in this book: "Blackskull is one word" read as replace-"Black
      // skull". What the author is saying is that the book's own form is
      // right — keep it.
      if (avoid.length === 0 || !avoid.some(inBook)) {
        return inBook(prefer) && !/\s/.test(prefer)
          ? { kind: "keep", source: statement, terms: [bookForm(book, prefer)] }
          : note;
      }
      return { kind: "replace", source: statement, prefer, avoid };
    }
    case "keep": {
      const terms = strings(j.terms).filter((t) => inStatement(t) && inBook(t));
      return terms.length
        ? { kind: "keep", source: statement, terms: unique(terms.map((t) => bookForm(book, t))) }
        : note;
    }
    case "casing": {
      const named = strings(j.terms);
      const stems = named.filter(inStatement).map((t) => fold(t).slice(0, Math.max(3, t.length - 1)));
      // A form the statement did not name must share a stem with one it did:
      // "Took" for "Take" does not, so the book decides — any form the model
      // offered that the book uses is kept when the statement covers all forms.
      const allForms = /\b(all|every|any)\b|\balle\b|\btodas?\b|\btodos?\b/i.test(statement);
      const terms = named.filter(
        (t) => inBook(t) && (inStatement(t) || (allForms && stems.length > 0) || stems.some((s) => fold(t).startsWith(s))),
      );
      if (!terms.length) return note;
      const when = typeof j.when === "string" ? j.when.trim().slice(0, 200) : undefined;
      // "Always capitalised" has no condition: that is keep.
      if (!when || /^(always|altid|immer|siempre|toujours)$/i.test(when)) {
        return {
          kind: "keep",
          source: statement,
          terms: unique(terms.map((t) => bookForm(book, capitalise(t)))),
        };
      }
      return { kind: "casing", source: statement, terms: unique(terms.map(capitalise)), when };
    }
    case "dialogue": {
      const who = typeof j.who === "string" ? j.who.trim().slice(0, 120) : "";
      return who ? { kind: "dialogue", source: statement, who } : note;
    }
    default:
      return note;
  }
}

const capitalise = (w: string) => w[0].toUpperCase() + w.slice(1);
function unique(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(fold(x)) ? false : (seen.add(fold(x)), true)));
}

export interface ReadDeps {
  /** One question to the model that will run the job: system, user → reply. */
  llm: (system: string, user: string) => Promise<string>;
  /** Statements read before, whose answers the app keeps: not asked again. */
  skip?: (statement: string) => boolean;
}

/**
 * Every statement of the sheet, read. Code first; one model question each
 * for the rest, one at a time (a local engine has one slot). A failed call
 * is a note — the statement still reaches the editor as the author wrote it.
 */
export async function readStyleSheet(sheet: string, book: string, deps: ReadDeps): Promise<SheetRule[]> {
  const rules: SheetRule[] = [];
  for (const statement of splitStatements(sheet)) {
    if (deps.skip?.(statement)) continue;
    const byCode = readByCode(statement);
    if (byCode) {
      rules.push(byCode);
      continue;
    }
    try {
      const reply = await deps.llm(SHEET_READ_PROMPT, `Instruction: ${statement}`);
      rules.push(checkReading(statement, reply, book));
    } catch {
      rules.push({ kind: "note", source: statement });
    }
  }
  return rules;
}

// ── The confirmed rules, for the job ──

/** A rule the author confirmed, as the app sends it with the run. */
export interface ConfirmedSheetRule {
  kind: SheetRuleKind;
  source: string;
  prefer?: string;
  avoid?: string[];
  terms?: string[];
  /** dialogue: the characters the author picked. */
  speakers?: string[];
  /** casing: the minority spellings the author ticked. */
  fixes?: { original: string; corrected: string }[];
}

export interface SheetJob {
  /** The author's guide with every enforced statement taken out, and one
   *  plain line per dialogue rule. What the editor reads. */
  guide: string;
  replace: { prefer: string; avoid: string[] }[];
  keep: string[];
  casing: string[];
  speakers: string[];
  fixes: { original: string; corrected: string }[];
}

const MAX_RULES = 100;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const strs = (v: unknown, max = 200, n = 100) =>
  Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : [];

/**
 * The confirmed rules, checked and turned into what the job enforces.
 *
 * An enforced statement leaves the guide: told to the editor as well, "Take
 * and Give are capitalised" is what made Local Betty write "Take" over
 * "bolt". A dialogue rule is the exception — it stays, re-said plainly with
 * the names, because the editor reading it does no harm and the gate's
 * paragraph test is approximate.
 */
export function sheetJob(guide: string, rules: unknown): SheetJob {
  const job: SheetJob = { guide, replace: [], keep: [], casing: [], speakers: [], fixes: [] };
  if (!Array.isArray(rules)) return job;
  const notes: string[] = [];
  for (const raw of rules.slice(0, MAX_RULES)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const source = str(r.source, 2000);
    let enforced = false;
    if (r.kind === "replace") {
      const prefer = str(r.prefer);
      const avoid = strs(r.avoid);
      if (prefer && avoid.length) {
        job.replace.push({ prefer, avoid });
        enforced = true;
      }
    } else if (r.kind === "keep") {
      const terms = strs(r.terms, 80);
      job.keep.push(...terms);
      enforced = terms.length > 0;
    } else if (r.kind === "casing") {
      const terms = strs(r.terms, 80);
      job.casing.push(...terms);
      if (Array.isArray(r.fixes)) {
        for (const f of r.fixes.slice(0, 500)) {
          const o = str((f as Record<string, unknown>)?.original, 400);
          const c = str((f as Record<string, unknown>)?.corrected, 400);
          if (o && c && o !== c) job.fixes.push({ original: o, corrected: c });
        }
      }
      enforced = terms.length > 0;
    } else if (r.kind === "dialogue") {
      const speakers = strs(r.speakers, 80, 50);
      if (speakers.length) {
        job.speakers.push(...speakers);
        notes.push(
          `The speech of ${speakers.join(", ")} is written the way they talk, on purpose: never correct its grammar or wording.`,
        );
        enforced = true;
      }
    }
    if (enforced && source) job.guide = job.guide.split(source).join("");
  }
  // Tidy what removing statements left behind: empty bullets, runs of blank lines.
  job.guide = job.guide
    .split("\n")
    .filter((l) => !/^\s*[-*•]\s*$/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (notes.length) job.guide = [job.guide, ...notes].filter(Boolean).join("\n");
  return job;
}

// ── What the card shows: the book's own counts ──

export interface CasingSample {
  /** A few words around the occurrence, as written. */
  original: string;
  /** The same words with the capital flipped: what ticking it applies. */
  corrected: string;
  /** The sentence it is in, for the author to read. */
  sentence: string;
  /** The word as written, to mark in the sentence. */
  word: string;
}

export interface RuleEvidence {
  /** replace: each avoided form; keep: each term. */
  counts?: { form: string; count: number }[];
  /** casing: how the book writes each form mid-sentence. */
  casing?: { form: string; capitalised: number; lowercase: number }[];
  /** casing: the spellings in the minority, to tick. */
  minority?: CasingSample[];
  /** dialogue: the book's names, most used first, to pick from. */
  candidates?: { name: string; count: number }[];
}

const MAX_MINORITY = 60;
const MAX_CANDIDATES = 30;

function sentenceAround(text: string, at: number, end: number): string {
  let s = at;
  while (s > 0 && !/[.!?\n]/.test(text[s - 1]) && at - s < 200) s--;
  let e = end;
  while (e < text.length && !/[.!?\n]/.test(text[e]) && e - end < 200) e++;
  if (e < text.length && text[e] !== "\n") e++;
  return text.slice(s, e).replace(/\s+/g, " ").trim();
}

/** About three words either side, within the line: enough to find this
 *  occurrence again in its chunk. */
function snippetAround(text: string, at: number, end: number): [number, number] {
  let s = at;
  let n = 0;
  while (s > 0 && text[s - 1] !== "\n") {
    if (/\s/.test(text[s - 1]) && !/\s/.test(text[s])) {
      if (++n > 3) break;
    }
    s--;
  }
  while (s < at && /\s/.test(text[s])) s++;
  let e = end;
  n = 0;
  while (e < text.length && text[e] !== "\n") {
    if (/\s/.test(text[e]) && !/\s/.test(text[e - 1])) {
      if (++n > 3) break;
    }
    e++;
  }
  return [s, e];
}

export function ruleEvidence(
  rule: SheetRule,
  book: string,
  isSentenceInitial: (text: string, index: number) => boolean,
  names: { term: string; count: number }[] = [],
): RuleEvidence {
  if (rule.kind === "replace") {
    return { counts: (rule.avoid ?? []).map((form) => ({ form, count: occurrencesAnyCase(book, form) })) };
  }
  if (rule.kind === "keep") {
    return { counts: (rule.terms ?? []).map((form) => ({ form, count: occurrencesAnyCase(book, form) })) };
  }
  if (rule.kind === "dialogue") {
    return { candidates: names.slice(0, MAX_CANDIDATES).map((n) => ({ name: n.term, count: n.count })) };
  }
  if (rule.kind !== "casing") return {};
  const casing: NonNullable<RuleEvidence["casing"]> = [];
  const minority: CasingSample[] = [];
  for (const term of rule.terms ?? []) {
    const lower = term[0].toLowerCase() + term.slice(1);
    const cap: number[] = [];
    const low: number[] = [];
    for (const m of book.matchAll(formPattern(term, "giu"))) {
      if (isSentenceInitial(book, m.index!)) continue;
      if (m[0] === term) cap.push(m.index!);
      else if (m[0] === lower) low.push(m.index!);
    }
    casing.push({ form: term, capitalised: cap.length, lowercase: low.length });
    // The minority is what the author ticks; the majority is the book's
    // habit and is left as it is.
    const [flipFrom, flipTo] = cap.length >= low.length ? [low, term] : [cap, lower];
    for (const i of flipFrom) {
      if (minority.length >= MAX_MINORITY) break;
      const end = i + term.length;
      const [s, e] = snippetAround(book, i, end);
      minority.push({
        original: book.slice(s, e),
        corrected: book.slice(s, i) + flipTo + book.slice(end, e),
        sentence: sentenceAround(book, i, end),
        word: book.slice(i, end),
      });
    }
  }
  return { casing, minority };
}
