// ── Where the publication-quality bar sits ──
//
// The three anchors are the author's, stated as densities, and they are the
// whole definition of the scale. They are asserted here rather than left
// implicit in a constant, because a scale defined by "10 points per fault
// per ten thousand words" is one edit away from meaning something else and
// nobody would notice until a book scored 35 again.
//
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeQualityScore,
  qualityTier,
  QUALITY_SCORE_PASS,
  QUALITY_SCORE_WARN,
} from "../../frontend/src/qualityScore.ts";

const clean = { structural: [] as never[] };

test("a manuscript with nothing found scores 100", () => {
  assert.equal(
    computeQualityScore({ wordCount: 84883, confirmedCount: 0, ...clean }),
    100,
  );
});

test("fewer than one fault per 20,000 words is ready", () => {
  // The bar: at exactly 1/20k a book is on it, and anything sparser clears it.
  const onTheBar = computeQualityScore({
    wordCount: 20000,
    confirmedCount: 1,
    ...clean,
  });
  assert.equal(onTheBar, QUALITY_SCORE_PASS);
  assert.equal(qualityTier(onTheBar), "good");

  const sparser = computeQualityScore({
    wordCount: 40000,
    confirmedCount: 1,
    ...clean,
  });
  assert.ok(sparser > QUALITY_SCORE_PASS, `expected >95, got ${sparser}`);
  assert.equal(qualityTier(sparser), "good");
});

test("about one fault per 10,000 words lands in the yellow", () => {
  // What a professionally proofread book looks like: good work, not clean.
  for (const [words, faults] of [
    [10000, 1],
    [100000, 10],
    [84883, 8],
  ] as const) {
    const score = computeQualityScore({
      wordCount: words,
      confirmedCount: faults,
      ...clean,
    });
    assert.equal(
      qualityTier(score),
      "ok",
      `${faults} in ${words} words scored ${score}`,
    );
  }
});

test("more than one fault per 5,000 words is in the red", () => {
  // At exactly 1/5k a book sits on the bottom of the yellow; denser is red.
  const onTheLine = computeQualityScore({
    wordCount: 50000,
    confirmedCount: 10,
    ...clean,
  });
  assert.equal(onTheLine, QUALITY_SCORE_WARN);

  const denser = computeQualityScore({
    wordCount: 50000,
    confirmedCount: 13,
    ...clean,
  });
  assert.equal(qualityTier(denser), "bad", `scored ${denser}`);
});

test("a short piece is not condemned for one typo", () => {
  // Density is meaningless on a fragment: one slip in 400 words is one slip.
  const score = computeQualityScore({
    wordCount: 400,
    confirmedCount: 1,
    ...clean,
  });
  assert.ok(score >= QUALITY_SCORE_WARN, `expected not red, got ${score}`);
});

test("a house-style notice costs almost nothing", () => {
  // Four straight quotation marks in a curly-quoted book used to cost sixty
  // points between them. They are worth saying and worth about a point each.
  const four = computeQualityScore({
    wordCount: 84883,
    confirmedCount: 0,
    structural: ["info", "info", "info", "info"],
  });
  assert.ok(four >= 90, `four notices scored ${four}`);
});

test("the same notice twenty times is still one decision", () => {
  // A book that consistently uses straight quotes trips this check on every
  // line of dialogue. Charging per instance would put a clean manuscript in
  // the red for a style choice, which is the fault this scale exists to fix.
  const twenty = computeQualityScore({
    wordCount: 84883,
    confirmedCount: 0,
    structural: Array(20).fill("info"),
  });
  const four = computeQualityScore({
    wordCount: 84883,
    confirmedCount: 0,
    structural: ["info", "info", "info", "info"],
  });
  assert.equal(twenty, four);
  assert.equal(qualityTier(twenty), "ok", `scored ${twenty}`);
});

test("one defect in the book as an object reaches the red line", () => {
  // A duplicated chapter is not a matter of degree.
  assert.equal(
    computeQualityScore({
      wordCount: 84883,
      confirmedCount: 0,
      structural: ["error"],
    }),
    QUALITY_SCORE_WARN,
  );
  assert.equal(
    qualityTier(
      computeQualityScore({
        wordCount: 84883,
        confirmedCount: 2,
        structural: ["error"],
      }),
    ),
    "bad",
  );
});

test("the book that prompted the rescale", () => {
  // 84,883 words, five blocking corrections, four house-style notices. It
  // scored 35 on the old scale — a failing grade for a manuscript five typos
  // from clean.
  const score = computeQualityScore({
    wordCount: 84883,
    confirmedCount: 5,
    structural: ["info", "info", "info", "info"],
  });
  assert.equal(qualityTier(score), "ok", `scored ${score}`);
  assert.ok(score >= 85, `expected a high yellow, got ${score}`);
});
