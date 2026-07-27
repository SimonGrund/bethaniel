// Resilience helpers for the reviewer stage: generic retry for local-LLM
// calls and score aggregation that treats unscored corrections as unvetted.

import type { Correction } from "./types.js";

export interface RetryOptions<T> {
  maxAttempts: number;
  backoffMs: (attempt: number) => number;
  /** An attempt whose result fails this check is retried like an error. */
  isValid: (value: T) => boolean;
  isAborted?: () => boolean;
  onRetry?: (attempt: number, why: string) => void;
  /** When every attempt is invalid, pick the best result instead of throwing. */
  keepBest?: (a: T, b: T) => T;
}

function isAbortError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    (err instanceof Error && err.name === "AbortError") ||
    msg.includes("abort") ||
    msg.includes("cancel")
  );
}

/**
 * Retry wrapper for local llama-server calls. Unlike the transient-fetch
 * retry in queue.ts, this retries on ANY error except abort/cancel — local
 * inference fails via OOM, slot exhaustion, and garbage output, not just
 * network hiccups. Invalid-but-non-throwing results (per `isValid`) are
 * retried too; if all attempts are invalid, `keepBest` selects the best
 * partial result rather than discarding everything.
 */
export async function runWithRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions<T>,
): Promise<T> {
  let best: T | undefined;
  let hasBest = false;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    if (opts.isAborted?.()) break;
    try {
      const value = await fn(attempt);
      if (opts.isValid(value)) return value;
      if (opts.keepBest) {
        best = hasBest ? opts.keepBest(best as T, value) : value;
        hasBest = true;
      }
      lastErr = new Error("invalid output");
    } catch (err) {
      if (isAbortError(err)) throw err;
      lastErr = err;
    }
    if (attempt < opts.maxAttempts) {
      opts.onRetry?.(
        attempt,
        lastErr instanceof Error ? lastErr.message : String(lastErr),
      );
      const wait = opts.backoffMs(attempt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }

  if (hasBest) return best as T;
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr ?? "retry attempts exhausted"));
}

/**
 * Flag corrections whose `original` span cannot be located in the true
 * original text with a plain indexOf — the exact contract the frontend's
 * applyAccepted uses when rebuilding the manuscript for export. Second-pass
 * corrections whose span overlaps a first-pass edit fail this check: they
 * would silently no-op on export, so they must be verified manually instead.
 * Returns the number of corrections flagged.
 */
export function flagUnanchoredCorrections(
  originalText: string,
  cs: Correction[],
): number {
  let flaggedCount = 0;
  const note = "second-pass edit overlaps a first-pass change — verify manually";
  for (const c of cs) {
    if (originalText.indexOf(c.original) !== -1) continue;
    c.flagged = true;
    c.reviewReason = c.reviewReason ? `${c.reviewReason}; ${note}` : note;
    flaggedCount++;
  }
  return flaggedCount;
}

export interface ReviewVerdict {
  flaggedCount: number;
  unscoredCount: number;
}

/**
 * Merge reviewer score maps onto corrections: each correction gets the
 * MINIMUM confidence across reviewers; below-threshold corrections are
 * flagged. A correction NO reviewer scored is a parse/truncation gap (the
 * reviewer prompt demands a score for every index), so it is flagged as
 * unvetted rather than passed through — `confidence` stays undefined so the
 * UI never shows a fabricated 5/5.
 */
export function aggregateReviewScores(
  cs: Correction[],
  scoreMaps: Map<number, { confidence: number; reason: string }>[],
  threshold: number,
): ReviewVerdict {
  let flaggedCount = 0;
  let unscoredCount = 0;

  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];

    // preApproved corrections bypass the reviewer entirely: they are
    // deterministic, high-confidence fixes (e.g. the Hunspell spell-checker and
    // an LLM editor independently produced the same change). The skeptical
    // reviewer otherwise withholds obvious spelling fixes, so never flag them —
    // and don't count them as unscored even when no reviewer scored them.
    if (c.preApproved) {
      if (c.confidence === undefined) c.confidence = 5;
      continue;
    }

    let minConfidence = Infinity;
    let minReason = "";
    for (const scores of scoreMaps) {
      const score = scores.get(i);
      if (score && score.confidence < minConfidence) {
        minConfidence = score.confidence;
        minReason = score.reason;
      }
    }

    if (!Number.isFinite(minConfidence)) {
      c.flagged = true;
      c.reviewReason = "not scored by reviewer — verify manually";
      unscoredCount++;
      flaggedCount++;
      continue;
    }

    c.confidence = minConfidence;
    if (minReason) c.reviewReason = minReason;
    if (minConfidence < threshold) {
      c.flagged = true;
      flaggedCount++;
    }
  }

  return { flaggedCount, unscoredCount };
}
