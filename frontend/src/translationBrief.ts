// ── The translation brief, on this side ──
//
// After a paid translation is claimed, Betty asks her questions
// (TranslationQuestions.tsx; the questions come from the backend's
// translationBrief.ts) and the answers become this plain-text brief, sent with
// the job. The backend puts it ahead of the author's style sheet, where every
// translation stage reads it.
//
// The brief is English instructions for the translator, but the answers are
// quoted as the author saw them — in the interface language — and a term
// exactly as the book spells it. The model reads both.
//
// Pure; tested from backend/test/translationBriefRender.test.ts.

export type Tone = "match" | "softer" | "stricter";

export interface BriefOption {
  id: string;
  label: string;
  /** For a question about a term: the exact text it is rendered as. */
  rendering?: string;
}

export interface BriefQuestion {
  id: string;
  term?: string;
  question: string;
  options: BriefOption[];
  suggested: string;
  why: string;
}

/** One row of the glossary table. `saved`: from the author's glossary for
 *  this language pair; `added`: typed in by the author on this run. */
export interface GlossaryRow {
  term: string;
  rendering: string;
  keep: boolean;
  saved?: boolean;
  added?: boolean;
  /** From the author's term list, notes or style-guide glossary. */
  author?: boolean;
  /** Changed by the author in the table on this run. */
  edited?: boolean;
}

/** One answer: an option, or the author's own words ("Other…"). */
export interface BriefAnswer {
  optionId?: string;
  other?: string;
}

/** A paid translation waiting on its answers. `questions` is null while
 *  Betty is still reading the book; she starts once the term-list card is
 *  done (`listDone`), so she reads the list with the book. */
export interface PendingTranslationBrief {
  /** What the author pasted or uploaded on the term-list card. */
  termList?: string;
  listDone?: boolean;
  /** The list's free text, as the backend read it. */
  authorNotes?: string;
  /** Betty's condensed rules from a long brief (see briefNotes). */
  instructions?: string;
  /** How many times Betty has been asked to read the text on this run. */
  asks?: number;
  /** Every row of the author's list, kept for the next translation. */
  listRows?: { term: string; rendering: string; keep: boolean }[];
  /** The list as Betty read it; a different one on the card means the
   *  author went back and changed it. */
  listAsked?: string;
  questions: BriefQuestion[] | null;
  tone: Tone;
  answers: Record<string, BriefAnswer>;
  /** Betty's table, as the author has edited it. Absent in a pending run
   *  saved before the table existed. */
  glossary?: GlossaryRow[];
  /** The card the author is on. Kept here, not in the component: the
   *  component is unmounted while a submission is in flight, and a failed
   *  one must put the author back on the card they left, not the tone. */
  step?: number;
  /** The questions call failed; only the tone question is on offer. */
  degraded?: boolean;
}

const TONE_LINES: Record<Tone, string | null> = {
  match: null, // what a translation does anyway
  softer: "- Tone: softer and warmer than the original, without losing any meaning.",
  stricter:
    "- Tone: stricter and shorter than the original — tighten and cut padding, never content.",
};

export function defaultAnswers(questions: BriefQuestion[]): Record<string, BriefAnswer> {
  return Object.fromEntries(questions.map((q) => [q.id, { optionId: q.suggested }]));
}

function chosenOption(q: BriefQuestion, a: BriefAnswer | undefined) {
  const id = a?.optionId ?? q.suggested;
  return q.options.find((o) => o.id === id) ?? q.options.find((o) => o.id === q.suggested);
}

function answerText(q: BriefQuestion, a: BriefAnswer | undefined): string {
  const own = a?.other?.trim();
  if (own) return `"${own}"`;
  const opt = chosenOption(q, a);
  if (!opt) return "";
  // The label is in the author's language; the rendering is what the
  // translation must actually say.
  return q.term && opt.rendering ? `${opt.label} (render as "${opt.rendering}")` : opt.label;
}

/** The answers to questions about a term, as glossary rows — so the next
 *  translation in this language pair does not ask them again. */
export function answeredTermsToSave(
  questions: BriefQuestion[],
  answers: Record<string, BriefAnswer>,
): { term: string; rendering: string; keep: boolean }[] {
  return questions.flatMap((q) => {
    if (!q.term) return [];
    const a = answers[q.id];
    const rendering = a?.other?.trim() || chosenOption(q, a)?.rendering;
    return rendering ? [{ term: q.term, rendering, keep: rendering === q.term }] : [];
  });
}

/** The rows worth keeping: a term, and either a rendering or "keep". */
export function glossaryToSave(rows: GlossaryRow[]): { term: string; rendering: string; keep: boolean }[] {
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    const term = r.term.trim();
    const rendering = r.keep ? term : r.rendering.trim();
    // A term the author added again is the row already there.
    if (!term || !rendering || seen.has(term)) return [];
    seen.add(term);
    return [{ term, rendering, keep: r.keep }];
  });
}

export function renderTranslationBrief(
  tone: Tone,
  questions: BriefQuestion[],
  answers: Record<string, BriefAnswer>,
  glossary: GlossaryRow[] = [],
  authorNotes = "",
): string {
  const lines: string[] = [];
  const toneLine = TONE_LINES[tone];
  if (toneLine) lines.push(toneLine);
  for (const q of questions) {
    const term = q.term ? `"${q.term}" — ` : "";
    lines.push(`- ${term}${q.question} → ${answerText(q, answers[q.id])}`);
  }
  const rows = glossaryToSave(glossary);
  if (rows.length > 0) {
    lines.push("GLOSSARY (binding — render each term exactly so, every time it occurs):");
    for (const r of rows) {
      lines.push(r.keep ? `- "${r.term}": keep exactly as written` : `- "${r.term}" → "${r.rendering}"`);
    }
  }
  const notes = authorNotes.trim();
  if (notes) lines.push("AUTHOR'S NOTES (in their own words — follow them throughout):", notes);
  if (lines.length === 0) return "";
  return [
    "TRANSLATION BRIEF (the author's answers to the translator's questions — these override the style sheet):",
    ...lines,
  ].join("\n");
}

type ListRow = { term: string; rendering: string; keep: boolean };

/** As written, or in its other number (at most a two-letter ending) — the
 *  backend's occursIn in translationBrief.ts, kept in step. */
function occursIn(lowerText: string, term: string): boolean {
  const t = term.toLowerCase();
  if (lowerText.includes(t)) return true;
  for (const cut of [1, 2]) {
    if (t.length - cut >= 4 && /\p{L}{1,2}$/u.test(t) && lowerText.includes(t.slice(0, -cut))) return true;
  }
  return false;
}

/**
 * The author went back to the list card and changed it after Betty had read
 * it. Rather than pay for her to read the book again, the new list's rows
 * are laid over the table: they lead it as the author's, the rows the old
 * list put there go, and Betty's own rows and the author's edits stay —
 * unless the new list now names the same term, which wins. `text` is the
 * book: a listed term it does not contain has no row to show.
 */
export function overlayListRows(
  glossary: GlossaryRow[],
  oldRows: ListRow[],
  newRows: ListRow[],
  text: string,
): GlossaryRow[] {
  const lowerText = text.toLowerCase();
  const seen = new Set<string>();
  const listed: GlossaryRow[] = [];
  for (const r of newRows) {
    const k = r.term.toLowerCase();
    if (seen.has(k) || !occursIn(lowerText, r.term)) continue;
    seen.add(k);
    listed.push({ term: r.term, rendering: r.rendering, keep: r.keep, author: true });
  }
  const fromOldList = new Set(oldRows.map((r) => r.term.toLowerCase()));
  const kept = glossary.filter((r) => {
    const k = r.term.toLowerCase();
    if (seen.has(k)) return false; // the new list says how
    return !(r.author && fromOldList.has(k)); // the old list's, now gone
  });
  return [...listed, ...kept];
}

/** Betty's questions the edited list has not answered. */
export function questionsOpenAfterList(questions: BriefQuestion[], rows: ListRow[]): BriefQuestion[] {
  const listed = new Set(rows.map((r) => r.term.toLowerCase()));
  return questions.filter((q) => !q.term || !listed.has(q.term.toLowerCase()));
}

/** Notes up to this length ride in every chunk as the author wrote them. */
const VERBATIM_NOTES_CHARS = 2000;
/** Without Betty's condensed rules, this much of a long brief rides. */
const FALLBACK_NOTES_CHARS = 8000;

/**
 * The author's notes as they ride in every chunk's instructions. Short ones
 * verbatim. A long translator brief — thirteen thousand characters on a real
 * run — would cost every chunk thousands of tokens and outgrow the brief, so
 * it rides as the compact rule list Betty wrote from it (she read all of it),
 * or, when she could not, as its opening.
 */
export function briefNotes(authorNotes: string, instructions: string): string {
  const notes = authorNotes.trim();
  if (notes.length <= VERBATIM_NOTES_CHARS) return notes;
  return instructions.trim() || notes.slice(0, FALLBACK_NOTES_CHARS);
}
