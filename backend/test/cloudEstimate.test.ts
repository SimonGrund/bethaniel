// Tests for estimateTaskOutputTokens — the per-task output-token budget the
// local progress bar divides real tokens-generated-so-far by (see queue.ts's
// runCorrectionPass), plus the rule that a Betty in the Cloud job always runs
// the Speed preset — that one guards what Bethaniel pays upstream, so it is
// asserted rather than assumed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  estimateTaskOutputTokens,
  estimateCloudJob,
  cloudRunKnobs,
} from "../src/cloudEstimate.ts";
import { MODEL_CATALOG } from "../src/modelCatalog.ts";
import { RUN_MODE_PRESETS } from "../src/runModePresets.ts";

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

// ── Cloud jobs always run Speed ──
// Betty in the Cloud is Bethaniel's spend, not the user's. "custom" still
// exposes 4 editors + style agent + 4 reviewers + a second pass, which costs
// ~6x upstream for output the run-mode benchmarks found no better — so a
// cloud job must never be able to select it, whatever the client sends.

test("cloudRunKnobs forces the Speed preset for the cloud model", () => {
  const cloudEntry = MODEL_CATALOG.find((e) => e.id === "bethaniel-cloud")!;
  const knobs = cloudRunKnobs(cloudEntry.fileName);
  assert.ok(knobs, "cloud model must get forced knobs");
  assert.equal(knobs.extraPass, false, "the 2x second pass must be off");
  assert.equal(knobs.dualEditor, false, "no multi-editor fan-out");
  assert.equal(knobs.reviewerCount, 1);
  assert.deepEqual(knobs, RUN_MODE_PRESETS.speed);
});

test("cloudRunKnobs leaves every other model alone", () => {
  // Local and BYO-key runs spend the user's own compute — not ours to clamp.
  for (const m of ["Qwen3.5-9B.gguf", "custom:deepseek", "custom:gguf:/tmp/x.gguf", "", undefined]) {
    assert.equal(cloudRunKnobs(m), null, `${String(m)} must be untouched`);
  }
});

test("forcing Speed is what keeps a cloud job inside the quote ceiling", () => {
  // The knobs a hostile or stale client might send.
  const greedy = {
    reviewMode: true, reviewerCount: 4, dualEditor: true, dualCount: 4,
    styleComplianceAgent: true, extraPass: true,
  };
  const units = Array.from({ length: 30 }, () => ({ wordCount: 3333 }));
  const base = {
    units, modes: ["copy_edit", "line_edit"], wordsPerChunk: 2500,
    numPredict: 8192, manuscriptLang: "en",
  } as const;

  const asSent = estimateCloudJob({ ...base, runMode: "custom", ...greedy });
  const forced = estimateCloudJob({
    ...base, runMode: "speed", ...RUN_MODE_PRESETS.speed,
  });

  assert.ok(
    forced.estimatedTotalTokens * 4 < asSent.estimatedTotalTokens,
    `forcing Speed must cut cost several-fold (got ${forced.estimatedTotalTokens} vs ${asSent.estimatedTotalTokens})`,
  );
  // 100k words is the headline case; Speed must stay well inside the Worker's
  // MAX_QUOTE_TOKENS (25M) and DAILY_TOKEN_CEILING, with the greedy variant
  // being the thing that would have blown through them.
  assert.ok(forced.estimatedTotalTokens < 2_000_000);
});
