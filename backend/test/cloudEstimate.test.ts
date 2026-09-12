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
  cloudProductFor,
  cloudRunKnobs,
  partitionCloudModes,
} from "../src/cloudEstimate.ts";
import { MODEL_CATALOG } from "../src/modelCatalog.ts";
import { RUN_MODE_PRESETS } from "../src/runModePresets.ts";

const baseOpts = {
  wordsPerChunk: 2000,
  runMode: "custom" as const,
  reviewMode: true,
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

test("cloudRunKnobs pins the Speed preset for the cloud model", () => {
  const cloudEntry = MODEL_CATALOG.find((e) => e.id === "bethaniel-cloud")!;
  const knobs = cloudRunKnobs(cloudEntry.fileName);
  assert.ok(knobs, "cloud model must get pinned knobs");
  assert.equal(knobs.extraPass, false, "the 2x second pass must be off");
  const { styleComplianceAgent: _authors, ...rest } = RUN_MODE_PRESETS.speed;
  assert.deepEqual(knobs, rest);
});

test("cloudRunKnobs leaves the style agent to the author", () => {
  // It is the one knob in the set that answers to the author's own style
  // sheet rather than to a cost/quality trade-off Bethaniel can settle for
  // them. Pinning it meant the checkbox in the UI silently did nothing on a
  // cloud run. `resolveKnob` reads `forced?.[key] ?? explicit ?? ...`, so
  // leaving the key off the object is what hands the decision back.
  const cloudEntry = MODEL_CATALOG.find((e) => e.id === "bethaniel-cloud")!;
  const knobs = cloudRunKnobs(cloudEntry.fileName)!;
  assert.equal(
    Object.prototype.hasOwnProperty.call(knobs, "styleComplianceAgent"),
    false,
    "pinning this key would override the author's own setting",
  );
});

test("the quote prices the style agent only when a sheet exists", () => {
  // queue.ts gates the second editor on `styleComplianceAgent && styleGuide`,
  // so pricing it from the knob alone quoted a call the run never makes.
  const base = {
    units: [{ wordCount: 5000 }],
    modes: ["copy_edit"],
    wordsPerChunk: 2500,
    runMode: "speed" as const,
    reviewMode: true,
    extraPass: false,
    numPredict: 4096,
  };
  const onNoSheet = estimateCloudJob({ ...base, styleComplianceAgent: true });
  const offNoSheet = estimateCloudJob({ ...base, styleComplianceAgent: false });
  assert.deepEqual(
    onNoSheet.estimatedTotalTokens,
    offNoSheet.estimatedTotalTokens,
    "no style sheet means no style agent, whatever the knob says",
  );

  const withSheet = estimateCloudJob({
    ...base,
    styleComplianceAgent: true,
    styleGuideChars: 800,
  });
  assert.ok(
    withSheet.estimatedTotalTokens > onNoSheet.estimatedTotalTokens,
    "a supplied sheet must add the second editor call to the quote",
  );
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
    reviewMode: true, styleComplianceAgent: true, extraPass: true,
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

  // extraPass is now the ONLY lever this clamp has. The editor and reviewer
  // fan-out knobs it used to override were removed once they were measured to
  // be no-ops — every agent ran the same prompt at temperature 0 and returned
  // the same answer — so the ceiling this test guards is a clean 2x, not the
  // several-fold it was when a stale client could ask for four of everything.
  assert.ok(
    forced.estimatedTotalTokens * 2 <= asSent.estimatedTotalTokens,
    `forcing Speed must at least halve the cost (got ${forced.estimatedTotalTokens} vs ${asSent.estimatedTotalTokens})`,
  );
  // 100k words is the headline case; Speed must stay well inside the Worker's
  // MAX_QUOTE_TOKENS (25M) and DAILY_TOKEN_CEILING, with the greedy variant
  // being the thing that would have blown through them.
  assert.ok(forced.estimatedTotalTokens < 2_000_000);
});

// ── Only tested passes may run in the cloud ──
// Developmental editing and story analysis are long-context whole-book passes
// whose cloud cost and quality have not been validated, so they must not be
// sellable — selling an untested pass is worse than not offering it.

test("the cloud allowlist covers exactly the tested passes", () => {
  for (const m of ["copy_edit", "line_edit", "combined_edit", "translate"]) {
    assert.deepEqual(partitionCloudModes([m]).rejected, [], `${m} must be allowed`);
  }
  // "Final readthrough" is one button in the UI but two modes underneath
  // (FINAL_READTHROUGH_MODES in frontend/src/types.ts); both must pass or the
  // selection breaks for a reason nobody would guess. Spelled out rather than
  // imported — the backend does not otherwise depend on frontend types.
  assert.deepEqual(
    partitionCloudModes(["proofread", "publication_scan"]).rejected, [],
  );
});

test("developmental edit and story analysis are refused", () => {
  const blocked = [
    "developmental_edit", "character_catalog", "location_catalog",
    "timeline", "combined_analysis", "analysis_summary", "blurb",
    "text_evaluator",
  ];
  for (const m of blocked) {
    assert.deepEqual(
      partitionCloudModes([m]).allowed, [], `${m} must not be sellable`,
    );
  }
});

test("a mixed selection reports precisely which passes are refused", () => {
  const { allowed, rejected } = partitionCloudModes([
    "copy_edit", "developmental_edit", "translate", "timeline",
  ]);
  assert.deepEqual(allowed, ["copy_edit", "translate"]);
  assert.deepEqual(rejected, ["developmental_edit", "timeline"]);
});

// ── Which product a selection is ──
// The Worker prices the three paid cards alike but names them apart on the
// receipt, so the estimate has to say which one this is — with the same
// precedence as the app's frontCardFor, and the enhanced analysis only when
// it is alone.

test("each front card is its own product; the enhanced analysis only alone", () => {
  assert.equal(cloudProductFor(["copy_edit"]), "edit");
  assert.equal(cloudProductFor(["combined_edit"]), "edit");
  assert.equal(cloudProductFor(["proofread", "publication_scan"]), "readthrough");
  assert.equal(cloudProductFor(["publication_scan"]), "readthrough");
  assert.equal(cloudProductFor(["translate"]), "translate");
  assert.equal(cloudProductFor(["language_enhance"]), "enhance");
  // An older selection holding two cards: the dearest wins, as in the app.
  assert.equal(cloudProductFor(["copy_edit", "translate"]), "translate");
  assert.equal(cloudProductFor(["copy_edit", "proofread"]), "readthrough");
  // The small price never applies alongside an edit.
  assert.equal(cloudProductFor(["copy_edit", "language_enhance"]), "edit");
});
