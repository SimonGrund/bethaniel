// A chapter that failed transiently should try again by itself. One that failed
// for a reason which will recur identically should not — retrying a missing
// model file just burns time and fills the log.
//
// The hintKey values come from diagnoseEngineExit in logBus.ts; this classifies
// them rather than inventing a second error model.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_AUTO_ATTEMPTS,
  isRetryableHint,
  shouldAutoRetry,
  isRateLimitError,
  retryWaitMs,
} from "../src/retryPolicy.ts";

test("transient engine faults are retryable", () => {
  for (const k of [
    "log_hint_engine_crash_generic",
    "log_hint_engine_unreachable",
    "log_hint_timeout",
  ]) {
    assert.equal(isRetryableHint(k), true, `${k} should retry`);
  }
});

test("deterministic faults are not retryable", () => {
  for (const k of [
    "log_hint_model_missing",
    "log_hint_binary_missing",
    "log_hint_corrupt_model",
    "log_hint_context_too_large",
    "log_hint_oom",
    "log_hint_cancelled",
  ]) {
    assert.equal(isRetryableHint(k), false, `${k} must not retry`);
  }
});

test("unknown and missing hints are not retried", () => {
  // A chapter quietly retrying forever on an unrecognised fault is worse than
  // one that stops and says so.
  assert.equal(isRetryableHint("something_new"), false);
  assert.equal(isRetryableHint(undefined), false);
});

test("retries stop after the attempt budget", () => {
  assert.equal(MAX_AUTO_ATTEMPTS, 2);
  const hintKey = "log_hint_timeout";
  assert.equal(shouldAutoRetry({ hintKey, attempts: 0 }), true);
  assert.equal(shouldAutoRetry({ hintKey, attempts: 1 }), true);
  assert.equal(shouldAutoRetry({ hintKey, attempts: 2 }), false);
  assert.equal(shouldAutoRetry({ hintKey, attempts: 99 }), false);
});

test("a non-retryable hint is never retried regardless of attempts", () => {
  assert.equal(
    shouldAutoRetry({ hintKey: "log_hint_model_missing", attempts: 0 }),
    false,
  );
});

test("a missing attempts count is treated as zero", () => {
  assert.equal(shouldAutoRetry({ hintKey: "log_hint_timeout" }), true);
});

test("a port conflict is retried — the holder may just have been slow to die", () => {
  // This used to be classified as a generic engine crash, which retries. Giving
  // it its own honest hint must not quietly take that away: freePort() kills
  // the holder on every attempt, so the second try often succeeds.
  assert.equal(isRetryableHint("log_hint_port_conflict"), true);
  assert.equal(
    shouldAutoRetry({ hintKey: "log_hint_port_conflict", attempts: 0 }),
    true,
  );
  assert.equal(
    shouldAutoRetry({
      hintKey: "log_hint_port_conflict",
      attempts: MAX_AUTO_ATTEMPTS,
    }),
    false,
    "it must still give up rather than loop on a port another app owns",
  );
});

// ── API rate limits ──
//
// Regression: a 429 from Betty in the Cloud used to be classified as a
// permanent failure, so the chunk died on the first attempt with no retry.

test("isRateLimitError: recognises a 429 however the provider phrases it", () => {
  assert.equal(
    isRateLimitError(new Error('API error 429: {"error":{"message":"Too many requests"}}')),
    true,
  );
  assert.equal(isRateLimitError(new Error("Too Many Requests")), true);
  assert.equal(isRateLimitError("429"), true);
});

test("isRateLimitError: leaves other failures alone", () => {
  assert.equal(isRateLimitError(new Error("fetch failed")), false);
  assert.equal(isRateLimitError(new Error("API error 402: Insufficient Balance")), false);
  assert.equal(isRateLimitError(null), false);
  assert.equal(isRateLimitError(undefined), false);
});

test("retryWaitMs: a rate limit waits long enough to outlast the window", () => {
  // The cloud ledger's window is 60s. Four retries on the ordinary ladder
  // span ~7s and would all land inside it; the rate-limit ladder spans ~50s.
  const ordinary = [1, 2, 3, 4].reduce((n, a) => n + retryWaitMs(new Error("fetch failed"), a), 0);
  const limited = [1, 2, 3, 4].reduce((n, a) => n + retryWaitMs(new Error("429"), a), 0);
  assert.equal(ordinary, 7500);
  assert.equal(limited, 50000);
  assert.ok(limited > 45_000, "must span most of the 60s window");
});

test("retryWaitMs: grows with the attempt number", () => {
  assert.ok(retryWaitMs(new Error("429"), 2) > retryWaitMs(new Error("429"), 1));
  assert.ok(retryWaitMs(new Error("boom"), 2) > retryWaitMs(new Error("boom"), 1));
});
