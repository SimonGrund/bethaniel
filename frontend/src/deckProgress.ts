// ── Which suggestions the deck offers, and how far through them you are ──
//
// A reviewer scores every correction 1–5. Measured against planted ground
// truth (scripts/bench-verdicts.ts, and the table in types.ts), a 1 is right
// about 6% of the time — wrong roughly nineteen times in twenty. It is not a
// close call the author should adjudicate; it is noise with a percentage
// printed on it.
//
// And it is most of the deck. Counted over 2,226 corrections from real runs
// on two books:
//
//   score 1   1,360   61.1%      kneeled → keeled
//                                single-handedly → single-offhandedly
//                                he never been born, → he been never born,
//                                drylands → dry lands   (the author's coinage)
//                                crosstrees → cross trees  (a nautical term)
//   score 2     145    6.5%
//   score 3      14    0.6%
//   score 4     381   17.1%
//   score 5     323   14.5%
//
// Six of six sampled 1s were plainly wrong. So a reviewer's 1 is held back by
// default, and an author who wants the whole list can ask for it.
//
// Which other scores to hold back depends on WHICH reviewer gave them. That
// was measured on 12 October 2026: the same 85k-word novel edited by Local
// Betty (Qwen3.5-4B) and by Betty in the Cloud (DeepSeek-V4-Flash), 30
// suggestions per score from each, judged blind (score, note and run hidden)
// as right / neutral / wrong, in percent:
//
//              cloud                  local
//   score 5    60 / 27 / 13           23 / 37 / 40
//   score 4    37 / 53 / 10           33 / 40 / 27
//   score 3    20 / 53 / 27            0 / 44 / 56   (only 9 in the run)
//   score 2    20 / 60 / 20           10 / 20 / 70
//   score 1    20 /  3 / 77           13 /  7 / 80
//
// The small local reviewer separates 1-3 from 4-5 and nothing finer: its 2s
// and 3s are as wrong as its 1s, so on a local run everything under 4 is held
// back. The cloud reviewer's 2s and 3s are mostly harmless taste — "short
// moment" against "brief moment" — so they are kept, but after everything
// else in the job, as optional polish. An External Betty key is a large
// hosted model too and is treated like the cloud. Thirty cards a bucket is
// about ±15 points: the gaps above are real, ten-point differences are not.
//
// The planted-error benchmark put score 2 at about one in two. A finished
// book has far fewer real errors than a planted fixture, which is why the
// same score means less on one.

import type { Correction } from "./types";

/**
 * The reviewer's lowest score: not "unsure", but "this is wrong".
 *
 * Its displayed certainty is 10% — or 18% on the few older results where the
 * precision pass (removed September 2026) disagreed with the reviewer, since
 * `certaintyPercent` nudges a doubtful
 * reviewer upward. Both are this bucket, which is why the score is the test
 * and the displayed percentage is not.
 */
export const REVIEWER_REJECTED_SCORE = 1;

export function reviewerRejected(c: Pick<Correction, "confidence">): boolean {
  return c.confidence === REVIEWER_REJECTED_SCORE;
}

/** Whose scores these are: the small model on this machine, or a large
 *  hosted one (Betty in the Cloud, External Betty). A result without a model
 *  is read as hosted, which holds back only the 1s, as before. */
export type ReviewerKind = "local" | "hosted";

export function reviewerKindOf(model: string | null | undefined): ReviewerKind {
  if (!model) return "hosted";
  return model.startsWith("custom:") && !model.startsWith("custom:gguf") ? "hosted" : "local";
}

/** The lowest score a local reviewer's suggestion needs to be shown. */
const LOCAL_SHOWN_FROM = 4;

/** Held back by default: shown only when the author asks for everything. */
export function heldBack(c: Pick<Correction, "confidence">, kind: ReviewerKind): boolean {
  if (c.confidence == null) return false;
  return kind === "local" ? c.confidence < LOCAL_SHOWN_FROM : reviewerRejected(c);
}

/** Kept, but after every other suggestion in the job: a hosted reviewer's 2s
 *  and 3s, which measured as mostly harmless matters of taste. */
export function optionalPolish(c: Pick<Correction, "confidence">, kind: ReviewerKind): boolean {
  return kind === "hosted" && (c.confidence === 2 || c.confidence === 3);
}

/** How many of these the deck would hold back. */
export function countRejected(
  corrections: Pick<Correction, "confidence">[],
  kind: ReviewerKind = "hosted",
): number {
  return corrections.filter((c) => heldBack(c, kind)).length;
}

export interface Progress {
  decided: number;
  total: number;
  /** 0–100, rounded. */
  percent: number;
}

/**
 * How far through a pile of decisions someone is.
 *
 * An empty pile is 100%, not 0% or NaN: there is nothing left to do, which is
 * what the number is asked to say. The two ends are exact — 99% must not
 * round up to 100 with one card still in hand, and 1 of 400 must not round
 * down to 0 after real work — so they are clamped away from each other rather
 * than left to `Math.round`.
 */
export function progressOf(decided: number, total: number): Progress {
  const safeTotal = Math.max(0, total);
  const safeDecided = Math.min(Math.max(0, decided), safeTotal);
  if (safeTotal === 0) {
    return { decided: 0, total: 0, percent: 100 };
  }
  const exact = (safeDecided / safeTotal) * 100;
  let percent = Math.round(exact);
  if (percent === 100 && safeDecided < safeTotal) percent = 99;
  if (percent === 0 && safeDecided > 0) percent = 1;
  return { decided: safeDecided, total: safeTotal, percent };
}
