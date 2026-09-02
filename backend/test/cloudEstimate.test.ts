// Tests for estimateTaskOutputTokens — the per-task output-token budget the
// local progress bar divides real tokens-generated-so-far by (see queue.ts's
// runCorrectionPass). Scoped to this one function; estimateCloudJob itself
// (the whole-job cloud-pricing estimator it's built from) has no prior test
// coverage and backfilling that is out of scope here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { estimateTaskOutputTokens } from "../src/cloudEstimate.ts";

const baseOpts = {
  wordsPerChunk: 2000,
  runMode: "custom" as const,
  reviewMode: true,
  reviewerCount: 1,
  dualEditor: false,
  dualCount: 2,
  styleComplianceAgent: false,
  extraPass: false,
  numPredict: 4096,
};

test("estimateTaskOutputTokens returns a positive estimate for copy_edit", () => {
  const tokens = estimateTaskOutputTokens("copy_edit", 2000, baseOpts);
  assert.ok(tokens > 0);
});

test("estimateTaskOutputTokens scales up with word count", () => {
  // Output is a fixed-per-call budget times chunk count (wordsPerChunk=2000
  // here), so 1000 vs 10000 words is 1 chunk vs 5 — roughly, not more than,
  // a 5x difference.
  const small = estimateTaskOutputTokens("copy_edit", 1000, baseOpts);
  const large = estimateTaskOutputTokens("copy_edit", 10000, baseOpts);
  assert.ok(large > small * 4, "10x the words (5x the chunks) should need meaningfully more output budget");
});

test("estimateTaskOutputTokens: dual editor increases the estimate over a single editor", () => {
  const single = estimateTaskOutputTokens("copy_edit", 4000, baseOpts);
  const dual = estimateTaskOutputTokens("copy_edit", 4000, {
    ...baseOpts,
    dualEditor: true,
    dualCount: 2,
  });
  assert.ok(dual > single, "two parallel editor agents should budget more output tokens than one");
});

test("estimateTaskOutputTokens: reviewMode adds reviewer-call budget", () => {
  const withoutReview = estimateTaskOutputTokens("copy_edit", 4000, {
    ...baseOpts,
    reviewMode: false,
  });
  const withReview = estimateTaskOutputTokens("copy_edit", 4000, {
    ...baseOpts,
    reviewMode: true,
  });
  assert.ok(withReview > withoutReview);
});

test("estimateTaskOutputTokens: extraPass roughly doubles copy_edit but not line_edit", () => {
  const copyOnce = estimateTaskOutputTokens("copy_edit", 4000, baseOpts);
  const copyTwice = estimateTaskOutputTokens("copy_edit", 4000, {
    ...baseOpts,
    extraPass: true,
  });
  assert.ok(copyTwice > copyOnce * 1.8, "a second full pass should roughly double the estimate");

  const lineOnce = estimateTaskOutputTokens("line_edit", 4000, baseOpts);
  const lineTwice = estimateTaskOutputTokens("line_edit", 4000, {
    ...baseOpts,
    extraPass: true,
  });
  assert.equal(lineOnce, lineTwice, "line_edit is unaffected by extraPass, per estimateCorrectionsMode");
});

test("estimateTaskOutputTokens: translate mode returns a positive, word-count-scaled estimate", () => {
  const small = estimateTaskOutputTokens("translate", 1000, baseOpts);
  const large = estimateTaskOutputTokens("translate", 10000, baseOpts);
  assert.ok(small > 0);
  assert.ok(large > small * 4);
});

test("estimateTaskOutputTokens: translate budgets more than a plain copy_edit for the same text", () => {
  // Translate re-emits the full chunk length (draft + upgrade pass) rather
  // than a short corrections list, so it should need substantially more
  // output budget for the same source.
  const copy = estimateTaskOutputTokens("copy_edit", 4000, baseOpts);
  const translate = estimateTaskOutputTokens("translate", 4000, baseOpts);
  assert.ok(translate > copy);
});
