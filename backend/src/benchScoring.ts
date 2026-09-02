// ── Benchmark scoring — recall/precision/consistency/time for model comparison ──
//
// The benchmark fixtures (sample_texts/*_correct.md vs *_copy_edit.md /
// *_line_edit.md) are near-identical prose except for deliberately planted
// errors. Diffing a pair gives an exact, auditable ground truth — replacing
// a hardcoded "expected: 10" guess — so a model's surfaced corrections can be
// scored against real recall (did it catch the planted errors?) and
// precision (did it invent problems that aren't there?) instead of just a
// raw correction count.

import { diffWordsWithSpace } from "diff";
import { widenToWords } from "./retextChecks.js";

export interface PlantedError {
  /** The erroneous text, widened to word boundaries for readability/matching. */
  wrong: string;
  /** The correct text at the same position. */
  right: string;
}

/** Bare shape a benchmarked correction needs — matches Correction structurally. */
export interface ScoredCorrection {
  original: string;
  corrected: string;
}

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

interface RawSpan {
  wS: number;
  wE: number;
  rS: number;
  rE: number;
}

/**
 * Diff an errored fixture against its clean counterpart to recover the exact
 * set of deliberately planted errors. Consecutive removed/added runs (a
 * substitution) merge into one planted error; a lone removed run (extra
 * erroneous text with nothing to replace it) or lone added run (missing
 * text) still produces one, with the other side empty.
 *
 * Adjacent changes closer together than `mergeGapChars` are then merged into
 * one combined error — load-bearing for line-edit fixtures, which are dense,
 * near-universal paraphrasing rather than isolated typos: without merging,
 * a single reworded sentence fragments into dozens of tiny adjacent spans
 * that don't correspond to what a human reviewer would count as one
 * meaningful improvement. Copy-edit fixtures have sparse, isolated errors,
 * so merging rarely triggers there.
 */
export function buildGroundTruth(
  erroredText: string,
  correctText: string,
  mergeGapChars = 20,
): PlantedError[] {
  const changes = diffWordsWithSpace(erroredText, correctText);
  const spans: RawSpan[] = [];
  let erroredPos = 0;
  let correctPos = 0;
  let i = 0;

  while (i < changes.length) {
    const c = changes[i];
    if (c.removed || c.added) {
      const wrongStart = erroredPos;
      const rightStart = correctPos;
      let wrongLen = 0;
      let rightLen = 0;
      let j = i;
      while (j < changes.length && (changes[j].removed || changes[j].added)) {
        if (changes[j].removed) wrongLen += changes[j].value.length;
        else rightLen += changes[j].value.length;
        j++;
      }
      const [wS, wE] = widenToWords(erroredText, wrongStart, wrongStart + wrongLen);
      const [rS, rE] = widenToWords(correctText, rightStart, rightStart + rightLen);
      spans.push({ wS, wE, rS, rE });
      erroredPos += wrongLen;
      correctPos += rightLen;
      i = j;
    } else {
      erroredPos += c.value.length;
      correctPos += c.value.length;
      i++;
    }
  }

  const merged: RawSpan[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && span.wS - prev.wE <= mergeGapChars) {
      prev.wE = Math.max(prev.wE, span.wE);
      prev.rE = Math.max(prev.rE, span.rE);
    } else {
      merged.push({ ...span });
    }
  }

  return merged.map((s) => ({
    wrong: erroredText.slice(s.wS, s.wE),
    right: correctText.slice(s.rS, s.rE),
  }));
}

/**
 * Whether a model's correction actually catches a planted error: it must
 * touch the same span (its `original` and the error's `wrong` text overlap
 * by containment either way — a model may widen or narrow the context) AND
 * its fix must genuinely move toward the right answer, not just touch the
 * spot without truly fixing it.
 */
export function correctionCatchesError(
  correction: ScoredCorrection,
  err: PlantedError,
): boolean {
  const original = norm(correction.original);
  const corrected = norm(correction.corrected);
  const wrong = norm(err.wrong);
  const right = norm(err.right);
  if (!wrong && !right) return false;
  const spanOverlaps =
    wrong.length > 0 && (original.includes(wrong) || wrong.includes(original));
  if (!spanOverlaps) return false;
  if (!right) return true; // pure deletion: touching the erroneous span is the fix
  return corrected.includes(right) || right.includes(corrected);
}

export interface RecallPrecisionResult {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** 0-100. Undefined ground truth (clean-text runs) has no recall — use precision only. */
  recall: number | null;
  /** 0-100 */
  precision: number;
  /** 0-100, harmonic mean of recall/precision when both exist; falls back to precision alone. */
  f1: number;
  missedErrors: PlantedError[];
  falsePositiveCorrections: ScoredCorrection[];
  /**
   * Every false positive split into two kinds that call for different fixes:
   * "wrongFix" landed on a real planted error's span but proposed the wrong
   * replacement (e.g. "ceder"→"ceded" instead of "cedar") — the model's
   * DETECTION was right, only its guess was wrong, which is exactly the
   * class of mistake a skeptical reviewer re-reading the fix in context
   * should be able to catch. "hallucination" touches text with no planted
   * error at all — a different failure mode the reviewer can't fix by
   * checking spelling, since there was nothing wrong to begin with.
   */
  falsePositiveBreakdown: {
    wrongFix: ScoredCorrection[];
    hallucination: ScoredCorrection[];
  };
}

function words(s: string): string[] {
  return norm(s).split(" ").filter(Boolean);
}

function bigrams(ws: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < ws.length - 1; i++) out.add(`${ws[i]} ${ws[i + 1]}`);
  return out;
}

/**
 * Whether a correction's span touches ANY planted error's span, regardless
 * of whether its fix is right — used to separate "found the spot, wrong
 * guess" false positives from "invented a problem" ones.
 *
 * Full substring containment (either direction) is the fast, common case.
 * It under-counts, though: ground-truth spans get merged when errors sit
 * close together (`mergeGapChars`), and a model's correction span can be
 * wider or offset from the merged span (e.g. it fixes a duplicated word but
 * not a typo four words later that got merged into the same ground-truth
 * span) — neither side then contains the other even though the correction
 * plainly targets that error. A shared two-word run (bigram) between the
 * correction's original text and the error's wrong text catches these
 * without over-matching on lone common words like "the" or "and".
 */
function touchesAnyErrorSpan(
  correction: ScoredCorrection,
  groundTruth: PlantedError[],
): boolean {
  const original = norm(correction.original);
  const originalWords = words(correction.original);
  const originalBigrams = originalWords.length >= 2 ? bigrams(originalWords) : null;
  return groundTruth.some((err) => {
    const wrong = norm(err.wrong);
    if (!wrong) return false;
    if (original.includes(wrong) || wrong.includes(original)) return true;
    if (!originalBigrams) return false;
    const wrongWords = words(err.wrong);
    if (wrongWords.length < 2) return false;
    for (const bg of bigrams(wrongWords)) {
      if (originalBigrams.has(bg)) return true;
    }
    return false;
  });
}

/**
 * Score a model's corrections against ground truth. Each ground-truth error
 * is matched against the first not-yet-claimed correction that catches it
 * (greedy, one correction can't double-count two errors). Anything left
 * over on either side is a miss (false negative) or a false positive.
 */
export function scoreCorrections(
  corrections: ScoredCorrection[],
  groundTruth: PlantedError[],
): RecallPrecisionResult {
  const claimed = new Set<number>();
  const missedErrors: PlantedError[] = [];
  let truePositives = 0;

  for (const err of groundTruth) {
    const idx = corrections.findIndex(
      (c, i) => !claimed.has(i) && correctionCatchesError(c, err),
    );
    if (idx === -1) {
      missedErrors.push(err);
    } else {
      claimed.add(idx);
      truePositives++;
    }
  }

  const falsePositiveCorrections = corrections.filter((_, i) => !claimed.has(i));
  const falsePositives = falsePositiveCorrections.length;
  const falseNegatives = missedErrors.length;

  const falsePositiveBreakdown = {
    wrongFix: falsePositiveCorrections.filter((c) =>
      touchesAnyErrorSpan(c, groundTruth),
    ),
    hallucination: falsePositiveCorrections.filter(
      (c) => !touchesAnyErrorSpan(c, groundTruth),
    ),
  };

  const recall =
    groundTruth.length > 0 ? (truePositives / groundTruth.length) * 100 : null;
  const precision =
    corrections.length > 0 ? (truePositives / corrections.length) * 100 : 100;
  const f1 =
    recall !== null
      ? recall + precision > 0
        ? (2 * recall * precision) / (recall + precision)
        : 0
      : precision;

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    recall,
    precision,
    f1,
    missedErrors,
    falsePositiveCorrections,
    falsePositiveBreakdown,
  };
}

/**
 * How similar two runs of the SAME task were — the seeding work should push
 * this toward 100 for local models; a low score means a model's quality
 * number here was a lucky/unlucky roll, not something to trust at face value.
 * Jaccard similarity (0-100) over (original→corrected) pairs.
 */
export function consistencyScore(
  runA: ScoredCorrection[],
  runB: ScoredCorrection[],
): number {
  const keyOf = (c: ScoredCorrection) => `${norm(c.original)}→${norm(c.corrected)}`;
  const a = new Set(runA.map(keyOf));
  const b = new Set(runB.map(keyOf));
  if (a.size === 0 && b.size === 0) return 100;
  let intersection = 0;
  for (const k of a) if (b.has(k)) intersection++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 100 : Math.round((intersection / union) * 100);
}

/** 100 for the fastest model in the run; scaled down for slower ones. */
export function timeScore(thisMs: number, fastestMs: number): number {
  if (thisMs <= 0) return 100;
  return Math.min(100, Math.round((100 * fastestMs) / thisMs));
}

/** Flat penalty per false positive on already-clean text — it should be zero. */
export function falsePositiveCleanScore(fpCount: number): number {
  return Math.max(0, 100 - fpCount * 15);
}

/**
 * Overall weighted score for one mode (copy_edit or line_edit): mostly
 * quality (F1 of recall & precision — a model can't win by over- or
 * under-flagging), a smaller slice for speed.
 */
export function overallScore(f1: number, timeScoreValue: number): number {
  return Math.round(0.8 * f1 + 0.2 * timeScoreValue);
}
