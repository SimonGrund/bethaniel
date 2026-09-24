// ── The publication-quality score ──
//
// One number for "how close is this to publishable", and it was cruel. On a
// real 85,000-word novel with five remaining typos it read 35: a failing
// grade for a manuscript a copy editor would call nearly done. Two things
// were wrong with it.
//
// It charged a flat fifteen points per structural finding, whatever the
// finding was. Four of that book's five blockers were notices that a curly-
// quoted book had a straight quote in it — worth saying, worth one point,
// not worth sixty between them. Severity now sets the price, and the three
// severities the scan already assigns are the three prices.
//
// And the typo scale was steeper than the standard it claimed to measure
// against. The anchors below are the author's, and they are the whole
// definition of this scale — the tests assert them directly, so a later
// tweak to a constant cannot quietly move the bar:
//
//     fewer than 1 fault per 20,000 words   ready       (95+)
//     about   1 fault per 10,000 words      check it    (yellow)
//     more than 1 fault per  5,000 words    not ready   (red)
//
// A professionally proofread book is about one slip per ten thousand words,
// which is the middle line: good work, not yet clean. Everything follows
// from putting 10 points on one fault per ten thousand words.

export type FindingSeverity = "error" | "warning" | "info";

/** At or above this, the panel calls a manuscript ready. */
export const QUALITY_SCORE_PASS = 95;
/** Below this, it is in the red. */
export const QUALITY_SCORE_WARN = 80;

/** Points charged for one fault per ten thousand words. */
const POINTS_PER_FAULT_PER_10K = 10;

// ── The curve ──
//
// Points are not subtracted; they are spent against what is left. Each one
// removes a share of the distance still above the floor, so the first fault
// in a clean book costs several points and the hundredth costs a fraction of
// one. That is how a reader already reads the number: the difference between
// 97 and 92 is the difference between two books, and the difference between
// 12 and 7 is nothing at all. A straight subtraction charged both the same
// and bottomed out at zero, which says a manuscript is not worth opening —
// never true of a book someone finished writing.
//
// The two anchors below are the spec; the constants are solved FROM them, so
// the curve cannot drift away from what was asked for. Score = 100·e^(−k·Pᵃ),
// fitted through both points, which leaves the third anchor — one fault per
// ten thousand words — landing on 90 of its own accord.
const ANCHOR_READY = { penalty: 5, score: 95 }; //  1 fault per 20,000 words
const ANCHOR_RED = { penalty: 20, score: 80 }; //  1 fault per  5,000 words

const CURVE_EXPONENT =
  Math.log(
    Math.log(ANCHOR_RED.score / 100) / Math.log(ANCHOR_READY.score / 100),
  ) / Math.log(ANCHOR_RED.penalty / ANCHOR_READY.penalty);

const CURVE_RATE =
  -Math.log(ANCHOR_READY.score / 100) / ANCHOR_READY.penalty ** CURVE_EXPONENT;

/**
 * The lowest number the panel will show. Zero is a verdict rather than a
 * measurement — it says nothing here is salvageable — and no manuscript has
 * earned it. Only a text of almost pure error reaches this far down anyway.
 */
const SCORE_FLOOR = 1;

/**
 * What each kind of structural finding costs.
 *
 * An `error` is a defect in the book as an object — a chapter duplicated, a
 * chapter empty, a paragraph repeated. One of those alone lands exactly on
 * the red line, because it is not a matter of degree: it wants looking at
 * before anything else. A `warning` is a real fault with a plausible
 * innocent reading (numbering that skips, a chapter ending without
 * punctuation). `info` is a house-style notice, which is the price of saying
 * it at all.
 */
const STRUCTURAL_COST: Record<FindingSeverity, number> = {
  error: 20,
  warning: 6,
  info: 1.5,
};

/**
 * The most the house-style notices can cost between them, however many there
 * are. Twenty straight quotation marks in a curly-quoted book is not twenty
 * problems — it is one decision, applied twenty times, and normalising them
 * is a single pass. Without this cap a consistent style choice drags a
 * clean manuscript into the red, which is the fault this whole rescale
 * exists to fix, arriving by a different door.
 */
const INFO_CAP = 6;

/**
 * Short pieces are scored as if they were at least this long. Density is
 * meaningless on a fragment: one typo in a 400-word sample is one typo, not
 * twenty-five per ten thousand words.
 */
const MIN_SCORED_WORDS = 5000;

export function computeQualityScore(opts: {
  wordCount: number;
  /** The severities of the structural findings that block publication. */
  structural: FindingSeverity[];
  /** Blocking corrections — faults a reader would take for a typo. */
  confirmedCount: number;
}): number {
  const per10k = Math.max(opts.wordCount, MIN_SCORED_WORDS) / 10000;
  const faultsPer10k = opts.confirmedCount / per10k;
  const cost = (of: FindingSeverity) =>
    opts.structural.filter((s) => s === of).length * STRUCTURAL_COST[of];
  const penalty =
    faultsPer10k * POINTS_PER_FAULT_PER_10K +
    cost("error") +
    cost("warning") +
    Math.min(cost("info"), INFO_CAP);
  if (penalty <= 0) return 100;
  const score = 100 * Math.exp(-CURVE_RATE * penalty ** CURVE_EXPONENT);
  return Math.max(SCORE_FLOOR, Math.min(100, Math.round(score)));
}

/** The band a score falls in — the ring's colour, and the report's. */
export function qualityTier(score: number): "good" | "ok" | "bad" {
  if (score >= QUALITY_SCORE_PASS) return "good";
  if (score >= QUALITY_SCORE_WARN) return "ok";
  return "bad";
}
