// Mapping a local error onto the Worker's closed enum.
//
// The mapping lives on this side so the Worker never has to parse an error
// string at all, and so the only thing that crosses the wire is one of seven
// known words. The message itself is never sent: it can contain the manuscript
// that caused it, and the issue it would land in is public.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  failureReasonFor,
  isCancellation,
} from "../src/cloudFailureReport.ts";
import { DraftRejectedError } from "../src/retryPolicy.ts";

test("an empty draft reports empty_output", () => {
  assert.equal(
    failureReasonFor(new DraftRejectedError("empty translation output")),
    "empty_output",
  );
});

test("an echoed source reports echoed_source", () => {
  assert.equal(
    failureReasonFor(
      new DraftRejectedError("untranslated — the source text came back unchanged"),
    ),
    "echoed_source",
  );
});

test("a short draft reports truncated", () => {
  assert.equal(
    failureReasonFor(
      new DraftRejectedError(
        "translation too short (120/900 chars) — the chunk was probably truncated",
      ),
    ),
    "truncated",
  );
});

test("a network fault reports network", () => {
  assert.equal(failureReasonFor(new Error("fetch failed")), "network");
  assert.equal(failureReasonFor(new Error("ECONNRESET")), "network");
});

test("a timeout reports timeout", () => {
  assert.equal(failureReasonFor(new Error("ETIMEDOUT")), "timeout");
});

test("a 500 reports provider_5xx", () => {
  assert.equal(failureReasonFor(new Error("upstream returned 503")), "provider_5xx");
});

test("anything else reports other — and never the message itself", () => {
  const reason = failureReasonFor(new Error('failed on "The ferry stopped running"'));
  assert.equal(reason, "other");
  assert.ok(!reason.includes("ferry"));
});

test("every mapped reason is one the Worker will accept", () => {
  // The Worker coerces anything off its list to "other", so a drift here
  // would not leak anything — it would silently flatten every diagnosis into
  // one useless bucket. Mirrors FAILURE_REASONS in worker/src/db.ts.
  const accepted = new Set([
    "empty_output",
    "echoed_source",
    "truncated",
    "network",
    "provider_5xx",
    "timeout",
    "other",
  ]);
  const samples: unknown[] = [
    new DraftRejectedError("empty translation output"),
    new DraftRejectedError("untranslated — the source text came back unchanged"),
    new DraftRejectedError("translation too short (1/9 chars)"),
    new DraftRejectedError("some future reason nobody has written yet"),
    new Error("fetch failed"),
    new Error("ETIMEDOUT"),
    new Error("upstream returned 503"),
    new Error("who knows"),
    "not an error at all",
    null,
  ];
  for (const s of samples) assert.ok(accepted.has(failureReasonFor(s)));
});

// ── A stopped job is not a failed one ──
//
// From a real alert: 24 chunks reported within 250ms of each other, 26 tokens
// apiece, every one carrying "This operation was aborted". The backend had
// been killed mid-run. Each row raised a GitHub issue and an email saying an
// author received source text where a translation should have been — none of
// which was true, and the job in question was the developer's own.

test("an abort is not a failure worth reporting", () => {
  assert.equal(isCancellation(new Error("This operation was aborted")), true);
  assert.equal(isCancellation("cancelled"), true);
  const abort = new Error("aborted");
  abort.name = "AbortError";
  assert.equal(isCancellation(abort), true);
});

test("both spellings of cancel", () => {
  assert.equal(isCancellation(new Error("The operation was canceled")), true);
  assert.equal(isCancellation(new Error("The operation was cancelled")), true);
});

test("a real failure still is one", () => {
  assert.equal(isCancellation(new Error("fetch failed")), false);
  assert.equal(isCancellation(new Error("503 Service Unavailable")), false);
  assert.equal(isCancellation(new Error("ETIMEDOUT")), false);
  assert.equal(isCancellation(new Error("model returned an empty answer")), false);
});

test("and its reason is still mapped for the ones that are", () => {
  // The guard sits in front of failureReasonFor, not inside it: the mapping
  // is still the mapping.
  assert.equal(failureReasonFor(new Error("fetch failed")), "network");
  assert.equal(failureReasonFor(new Error("504 gateway timeout")), "timeout");
});
