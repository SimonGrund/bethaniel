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
// Score 2 is NOT held back, though `flagKindOf` calls it "doubted" too. It
// displays as 45% and reads like a coin flip rather than noise — `the East`
// against `the east`, `woodsmoke` against `wood smoke`, `a whole lot` against
// `a lot`. Those are real questions, and the author is the one who answers
// them. Hiding a bucket that is right half the time would be a different and
// worse change, so the line is drawn at the score, not at the flag.

import type { Correction } from "./types";

/**
 * The reviewer's lowest score: not "unsure", but "this is wrong".
 *
 * Its displayed certainty is 10% — or 18% on the few where the second check
 * disagrees with the reviewer, since `certaintyPercent` nudges a doubtful
 * reviewer upward. Both are this bucket, which is why the score is the test
 * and the displayed percentage is not.
 */
export const REVIEWER_REJECTED_SCORE = 1;

export function reviewerRejected(c: Pick<Correction, "confidence">): boolean {
  return c.confidence === REVIEWER_REJECTED_SCORE;
}

/** How many of these the deck would hold back. */
export function countRejected(
  corrections: Pick<Correction, "confidence">[],
): number {
  return corrections.filter(reviewerRejected).length;
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
