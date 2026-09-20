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
  // A held port is usually a previous engine that had not finished dying.
  // freePort() kills the holder before each attempt, so the next try clears it.
  "log_hint_port_conflict",
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

// ── API rate limits ──

/**
 * HTTP 429 from an API model — "slow down", not "stop".
 *
 * It matches none of the network signatures queue.ts retries on (the message
 * carries an HTTP status, not a socket fault), so before this existed a rate
 * limit was classified as permanent and failed the chunk on the first
 * attempt. Betty in the Cloud's ledger allows 30 requests/minute per
 * credential, and the app's own parallel editor + reviewer agents exceed that
 * on an ordinary job.
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("429") || msg.includes("too many requests");
}

/**
 * How long to wait before the next attempt.
 *
 * Rate limits get a far longer backoff than network blips: the cloud ledger's
 * window is 60 seconds, and the ordinary 750ms x attempt ladder spends all
 * five attempts inside ~7 seconds — every one of them in the same window, so
 * all five fail. The 5s ladder spans ~50s over four retries instead, and the
 * window drains continuously, so capacity returns partway through.
 */
export function retryWaitMs(err: unknown, attempt: number): number {
  return isRateLimitError(err) ? 5000 * attempt : 750 * attempt;
}

// ── Bad answers, as distinct from failed requests ──

/**
 * A draft translation that `draftGuard` refused.
 *
 * A distinct type because the chunk loop has to tell it apart from a failed
 * request: the request succeeded, and what came back was unusable. That
 * distinction is what sets how many more goes it gets.
 *
 * Declared here rather than beside `draftGuard` in translationUpgrade.ts to
 * keep this module's one useful property — it imports nothing, so the policy
 * can be tested without dragging the upgrade orchestrator in behind it.
 */
export class DraftRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(`translation rejected: ${reason}`);
    this.name = "DraftRejectedError";
  }
}

/** Total attempts allowed for a chunk whose model output was unusable. */
export const MAX_OUTPUT_ATTEMPTS = 2;

/** Total attempts allowed for a chunk that failed to reach the model at all. */
export const MAX_TRANSIENT_ATTEMPTS = 5;

/**
 * How many times in total this chunk may be attempted, given what went wrong.
 *
 * Two ceilings, not one. A transient fetch fault costs a failed socket, so it
 * can afford the full ladder. A rejected draft costs a complete
 * re-translation of the chunk — real tokens against a budget the author has
 * already paid for — so it gets one retry and then tells the truth.
 *
 * A number rather than a boolean so both ceilings live in one place instead of
 * spreading `instanceof` checks through the chunk loop's catch.
 *
 * `isTransient` is supplied by the caller: the classifier that knows the
 * network signatures lives in queue.ts, and importing it would cost this
 * module the independence described above.
 */
export function chunkRetryLimit(err: unknown, isTransient: boolean): number {
  // Checked before the transient test on purpose. If a rejection ever also
  // matches a network signature, the cheaper ceiling must still win.
  if (err instanceof DraftRejectedError) return MAX_OUTPUT_ATTEMPTS;
  if (isTransient) return MAX_TRANSIENT_ATTEMPTS;
  return 1;
}
