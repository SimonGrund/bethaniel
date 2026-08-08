// ── Automatic chapter retry policy ──
//
// Classifies the hintKey values diagnoseEngineExit (logBus.ts) already produces.
// Pure and dependency-free so the policy can be tested on its own.

/** Automatic attempts after the first failure — 3 runs in total. */
export const MAX_AUTO_ATTEMPTS = 2;

/**
 * Faults worth another go: the engine died, went unreachable, or stalled. A
 * fresh load usually clears them.
 *
 * Everything else is deterministic and would fail identically — a missing or
 * corrupt model, a missing binary, a context that does not fit, or a machine
 * that just ran out of memory (retrying that makes it worse, not better).
 * Cancellation is the user's decision. Unrecognised hints are not retried: a
 * chapter quietly retrying forever on an unknown fault is worse than one that
 * stops and says so.
 */
const RETRYABLE = new Set([
  "log_hint_engine_crash_generic",
  "log_hint_engine_unreachable",
  "log_hint_timeout",
]);

export function isRetryableHint(hintKey: string | undefined): boolean {
  return hintKey != null && RETRYABLE.has(hintKey);
}

export function shouldAutoRetry(opts: {
  hintKey?: string;
  attempts?: number;
}): boolean {
  if (!isRetryableHint(opts.hintKey)) return false;
  return (opts.attempts ?? 0) < MAX_AUTO_ATTEMPTS;
}
