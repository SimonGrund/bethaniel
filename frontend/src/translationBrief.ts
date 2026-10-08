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
}

export interface BriefQuestion {
  id: string;
  term?: string;
  question: string;
  options: BriefOption[];
  suggested: string;
  why: string;
}

/** One answer: an option, or the author's own words ("Other…"). */
export interface BriefAnswer {
  optionId?: string;
  other?: string;
}

/** A paid translation waiting on its answers. `questions` is null while
 *  Betty is still reading the book. */
export interface PendingTranslationBrief {
  questions: BriefQuestion[] | null;
  tone: Tone;
  answers: Record<string, BriefAnswer>;
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

function answerText(q: BriefQuestion, a: BriefAnswer | undefined): string {
  const own = a?.other?.trim();
  if (own) return `"${own}"`;
  const id = a?.optionId ?? q.suggested;
  const opt = q.options.find((o) => o.id === id) ?? q.options.find((o) => o.id === q.suggested);
  return opt?.label ?? "";
}

export function renderTranslationBrief(
  tone: Tone,
  questions: BriefQuestion[],
  answers: Record<string, BriefAnswer>,
): string {
  const lines: string[] = [];
  const toneLine = TONE_LINES[tone];
  if (toneLine) lines.push(toneLine);
  for (const q of questions) {
    const term = q.term ? `"${q.term}" — ` : "";
    lines.push(`- ${term}${q.question} → ${answerText(q, answers[q.id])}`);
  }
  if (lines.length === 0) return "";
  return [
    "TRANSLATION BRIEF (the author's answers to the translator's questions — these override the style sheet):",
    ...lines,
  ].join("\n");
}
