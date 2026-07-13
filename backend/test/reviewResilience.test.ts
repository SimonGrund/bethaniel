// Tests for the reviewer resilience helpers: retry-with-validation and
// score aggregation that flags unscored corrections instead of passing them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runWithRetry, aggregateReviewScores } from "../src/reviewResilience.ts";
import type { Correction } from "../src/types.ts";

const noBackoff = () => 0;

test("runWithRetry: succeeds after transient failures", async () => {
  let calls = 0;
  const out = await runWithRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("fetch failed");
      return "ok";
    },
    { maxAttempts: 3, backoffMs: noBackoff, isValid: (v) => v === "ok" },
  );
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("runWithRetry: throws after maxAttempts when every attempt fails", async () => {
  let calls = 0;
  await assert.rejects(
    runWithRetry(
      async () => {
        calls++;
        throw new Error("boom");
      },
      { maxAttempts: 3, backoffMs: noBackoff, isValid: () => true },
    ),
    /boom/,
  );
  assert.equal(calls, 3);
});

test("runWithRetry: invalid outputs are retried and keepBest returns the best", async () => {
  let calls = 0;
  const outputs = ["one score", "", "two scores here"];
  const out = await runWithRetry<string>(
    async () => outputs[calls++],
    {
      maxAttempts: 3,
      backoffMs: noBackoff,
      isValid: () => false, // nothing counts as fully valid
      keepBest: (a, b) => (a.length >= b.length ? a : b),
    },
  );
  assert.equal(out, "two scores here");
  assert.equal(calls, 3);
});

test("runWithRetry: abort errors are rethrown immediately, no retry", async () => {
  let calls = 0;
  const err = new Error("aborted");
  err.name = "AbortError";
  await assert.rejects(
    runWithRetry(
      async () => {
        calls++;
        throw err;
      },
      { maxAttempts: 3, backoffMs: noBackoff, isValid: () => true },
    ),
    /aborted/,
  );
  assert.equal(calls, 1);
});

test("runWithRetry: isAborted stops further attempts", async () => {
  let calls = 0;
  let aborted = false;
  await assert.rejects(
    runWithRetry(
      async () => {
        calls++;
        aborted = true;
        throw new Error("first failure");
      },
      {
        maxAttempts: 5,
        backoffMs: noBackoff,
        isValid: () => true,
        isAborted: () => aborted,
      },
    ),
    /first failure/,
  );
  assert.equal(calls, 1);
});

test("runWithRetry: onRetry reports each failed attempt", async () => {
  const retries: string[] = [];
  let calls = 0;
  await runWithRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error(`fail ${calls}`);
      return "ok";
    },
    {
      maxAttempts: 3,
      backoffMs: noBackoff,
      isValid: (v) => v === "ok",
      onRetry: (attempt, why) => retries.push(`${attempt}:${why}`),
    },
  );
  assert.deepEqual(retries, ["1:fail 1", "2:fail 2"]);
});

const mkCorrections = (n: number): Correction[] =>
  Array.from({ length: n }, (_, i) => ({
    original: `orig${i}`,
    corrected: `fix${i}`,
  }));

const scores = (entries: [number, number, string?][]) =>
  new Map(entries.map(([i, conf, reason]) => [i, { confidence: conf, reason: reason ?? "" }]));

test("aggregateReviewScores: min confidence across agents, flag below threshold", () => {
  const cs = mkCorrections(2);
  const verdict = aggregateReviewScores(
    cs,
    [
      scores([[0, 5], [1, 4, "fine"]]),
      scores([[0, 2, "wrong"], [1, 5]]),
    ],
    3,
  );
  assert.equal(cs[0].confidence, 2);
  assert.equal(cs[0].flagged, true);
  assert.equal(cs[0].reviewReason, "wrong");
  assert.equal(cs[1].confidence, 4);
  assert.equal(cs[1].flagged, undefined);
  assert.deepEqual(verdict, { flaggedCount: 1, unscoredCount: 0 });
});

test("aggregateReviewScores: unscored correction is flagged, confidence undefined", () => {
  const cs = mkCorrections(2);
  const verdict = aggregateReviewScores(cs, [scores([[0, 5, "good"]])], 3);
  assert.equal(cs[0].flagged, undefined);
  assert.equal(cs[1].flagged, true);
  assert.equal(cs[1].confidence, undefined);
  assert.match(cs[1].reviewReason ?? "", /not scored/);
  assert.deepEqual(verdict, { flaggedCount: 1, unscoredCount: 1 });
});

test("aggregateReviewScores: empty score maps flag everything", () => {
  const cs = mkCorrections(3);
  const verdict = aggregateReviewScores(cs, [new Map()], 3);
  assert.equal(cs.filter((c) => c.flagged).length, 3);
  assert.deepEqual(verdict, { flaggedCount: 3, unscoredCount: 3 });
});
