// ── Telling Bethaniel that a paid chunk failed twice ──
//
// Cloud jobs only. Betty runs on the author's own machine, and a local run has
// no credential, nowhere to report to, and no promise to keep — reporting one
// would mean sending data off a machine the product promises never sends data
// off. A cloud job already talks to the Worker and the author has already
// paid, so the report is both possible and owed: without it the only way
// Bethaniel learns a customer's run broke is if they write in.
//
// Nothing here is allowed to fail a job. Every call is best-effort.

import { DraftRejectedError } from "./retryPolicy.js";

/**
 * Map a local error onto the Worker's closed enum.
 *
 * Done on this side so the Worker never parses an error string, and so the
 * only thing that crosses the wire is one of seven known words. The message
 * itself is never sent: it can contain the manuscript that caused it, and the
 * issue it would land in is on a public repository.
 *
 * Mirrors FAILURE_REASONS in worker/src/db.ts. Anything unmapped becomes
 * "other" here as well as there, so a drift costs detail, never privacy.
 */
export function failureReasonFor(err: unknown): string {
  if (err instanceof DraftRejectedError) {
    const r = err.reason.toLowerCase();
    if (r.includes("empty")) return "empty_output";
    if (r.includes("untranslated")) return "echoed_source";
    if (r.includes("too short") || r.includes("truncat")) return "truncated";
    return "other";
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // Timeout before the 5xx test: "504 gateway timeout" is a timeout by any
  // useful reading, and the more specific diagnosis is the more useful one.
  if (
    msg.includes("etimedout") ||
    msg.includes("timeout") ||
    msg.includes("timed out")
  )
    return "timeout";
  if (/\b5\d\d\b/.test(msg)) return "provider_5xx";
  if (
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("undici") ||
    msg.includes("epipe")
  )
    return "network";
  return "other";
}

export interface CloudFailureReport {
  /** Worker origin, e.g. https://bethaniel-cloud.cloudwatcher.workers.dev */
  baseUrl: string;
  /** The credential token — the same one the proxy authenticates with. */
  apiKey: string;
  /** "Chapter 3 · chunk 2/4". A chapter NAME at most, never its text. */
  unitLabel: string;
  reason: string;
  attempts: number;
  /** "edit" | "readthrough" | "translate" | "enhance" — coerced Worker-side. */
  product: string;
}

/**
 * File one failure report. Swallows everything.
 *
 * A job that has already lost a chunk must not also fail because telling us
 * about it failed, so there is deliberately no error path out of here.
 */
export async function reportCloudFailure(
  opts: CloudFailureReport,
): Promise<void> {
  try {
    await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/v1/failure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        unitLabel: opts.unitLabel,
        reason: opts.reason,
        attempts: opts.attempts,
        product: opts.product,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* best effort — see the note above */
  }
}
