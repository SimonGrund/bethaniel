// Tests for the benchmark scoring module: ground-truth extraction from a
// clean/errored fixture pair, matching a model's corrections against it, and
// the recall/precision/consistency/time score formulas.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  buildGroundTruth,
  correctionCatchesError,
  scoreCorrections,
  consistencyScore,
  timeScore,
  falsePositiveCleanScore,
  overallScore,
} from "../src/benchScoring.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(__dirname, "..", "..", "sample_texts");

// ── buildGroundTruth ──

test("buildGroundTruth: a single word substitution is one planted error", () => {
  const errored = "She had writen the letter.";
  const correct = "She had written the letter.";
  const errors = buildGroundTruth(errored, correct);
  assert.equal(errors.length, 1);
  assert.match(errors[0].wrong, /writen/);
  assert.match(errors[0].right, /written/);
});

test("buildGroundTruth: a missing comma is its own planted error", () => {
  const errored = "Outside gulls turned circles.";
  const correct = "Outside, gulls turned circles.";
  const errors = buildGroundTruth(errored, correct);
  assert.equal(errors.length, 1);
});

test("buildGroundTruth: separated errors stay distinct; close ones merge", () => {
  const errored =
    "The dog run fast across the wide open sunny meadow this morning. The cat was happpy.";
  const correct =
    "The dog runs fast across the wide open sunny meadow this morning. The cat was happy.";
  const errors = buildGroundTruth(errored, correct);
  assert.equal(errors.length, 2, "far-apart errors should stay separate");

  // Two typos a few words apart in the same short clause — this is exactly
  // the line-edit fixture's density, and should merge into one span rather
  // than fragment into two tiny unrelated-looking corrections.
  const closeErrored = "The dog run fast and was happpy.";
  const closeCorrect = "The dog runs fast and was happy.";
  const closeErrors = buildGroundTruth(closeErrored, closeCorrect);
  assert.equal(closeErrors.length, 1, "nearby errors should merge into one span");
});

test("buildGroundTruth: identical text has no planted errors", () => {
  const text = "Nothing is wrong with this sentence.";
  assert.deepEqual(buildGroundTruth(text, text), []);
});

test("buildGroundTruth: matches the real fixture pair with a sane, non-trivial count", () => {
  const errored = readFileSync(join(SAMPLE_DIR, "english_copy_edit.md"), "utf-8");
  const correct = readFileSync(join(SAMPLE_DIR, "english_correct.md"), "utf-8");
  const errors = buildGroundTruth(errored, correct);
  // Not pinned to an exact count (fixtures may evolve) — just confirms the
  // diff-based approach recovers a real, plausible number of planted errors,
  // unlike the old hardcoded "expected: 10" guess.
  assert.ok(errors.length >= 8, `expected several planted errors, got ${errors.length}`);
  assert.ok(errors.length <= 30, `suspiciously many planted errors: ${errors.length}`);
});

// ── correctionCatchesError ──

test("correctionCatchesError: an exact-span correction catches the error", () => {
  const err = { wrong: "had writen the", right: "had written the" };
  assert.equal(
    correctionCatchesError({ original: "had writen the", corrected: "had written the" }, err),
    true,
  );
});

test("correctionCatchesError: a narrower/wider span still catches it", () => {
  const err = { wrong: "had writen the", right: "had written the" };
  assert.equal(correctionCatchesError({ original: "writen", corrected: "written" }, err), true);
});

test("correctionCatchesError: touching the same spot without fixing it does not count", () => {
  const err = { wrong: "had writen the", right: "had written the" };
  assert.equal(
    correctionCatchesError({ original: "had writen the", corrected: "had wrote the" }, err),
    false,
  );
});

test("correctionCatchesError: an unrelated correction does not count", () => {
  const err = { wrong: "had writen the", right: "had written the" };
  assert.equal(
    correctionCatchesError({ original: "shakey hand", corrected: "shaky hand" }, err),
    false,
  );
});

// ── scoreCorrections ──

test("scoreCorrections: perfect match yields 100% recall and precision", () => {
  const groundTruth = [
    { wrong: "writen", right: "written" },
    { wrong: "shakey", right: "shaky" },
  ];
  const corrections = [
    { original: "writen", corrected: "written" },
    { original: "shakey", corrected: "shaky" },
  ];
  const result = scoreCorrections(corrections, groundTruth);
  assert.equal(result.recall, 100);
  assert.equal(result.precision, 100);
  assert.equal(result.f1, 100);
  assert.equal(result.falseNegatives, 0);
  assert.equal(result.falsePositives, 0);
});

test("scoreCorrections: a missed error lowers recall but not precision", () => {
  const groundTruth = [
    { wrong: "writen", right: "written" },
    { wrong: "shakey", right: "shaky" },
  ];
  const corrections = [{ original: "writen", corrected: "written" }];
  const result = scoreCorrections(corrections, groundTruth);
  assert.equal(result.recall, 50);
  assert.equal(result.precision, 100);
  assert.equal(result.missedErrors.length, 1);
});

test("scoreCorrections: an invented correction lowers precision but not recall", () => {
  const groundTruth = [{ wrong: "writen", right: "written" }];
  const corrections = [
    { original: "writen", corrected: "written" },
    { original: "perfectly fine text", corrected: "changed for no reason" },
  ];
  const result = scoreCorrections(corrections, groundTruth);
  assert.equal(result.recall, 100);
  assert.equal(result.precision, 50);
  assert.equal(result.falsePositiveCorrections.length, 1);
});

test("scoreCorrections: no ground truth (clean text) has null recall, precision reflects false positives", () => {
  const result = scoreCorrections(
    [{ original: "fine", corrected: "also fine but changed" }],
    [],
  );
  assert.equal(result.recall, null);
  assert.equal(result.precision, 0);
  assert.equal(result.falsePositives, 1);
});

test("scoreCorrections: no ground truth and no corrections is a perfect clean run", () => {
  const result = scoreCorrections([], []);
  assert.equal(result.recall, null);
  assert.equal(result.precision, 100);
  assert.equal(result.falsePositives, 0);
});

test("scoreCorrections: one correction cannot double-count two errors", () => {
  const groundTruth = [
    { wrong: "writen", right: "written" },
    { wrong: "writen", right: "written" },
  ];
  const corrections = [{ original: "writen", corrected: "written" }];
  const result = scoreCorrections(corrections, groundTruth);
  assert.equal(result.truePositives, 1);
  assert.equal(result.falseNegatives, 1);
});

// ── consistencyScore ──

test("consistencyScore: identical runs score 100", () => {
  const run = [{ original: "writen", corrected: "written" }];
  assert.equal(consistencyScore(run, run), 100);
});

test("consistencyScore: completely disjoint runs score 0", () => {
  const a = [{ original: "writen", corrected: "written" }];
  const b = [{ original: "shakey", corrected: "shaky" }];
  assert.equal(consistencyScore(a, b), 0);
});

test("consistencyScore: two empty runs (both clean) score 100", () => {
  assert.equal(consistencyScore([], []), 100);
});

test("consistencyScore: partial overlap scores between 0 and 100", () => {
  const a = [
    { original: "writen", corrected: "written" },
    { original: "shakey", corrected: "shaky" },
  ];
  const b = [{ original: "writen", corrected: "written" }];
  const score = consistencyScore(a, b);
  assert.ok(score > 0 && score < 100);
});

// ── timeScore / falsePositiveCleanScore / overallScore ──

test("timeScore: the fastest model scores 100", () => {
  assert.equal(timeScore(1000, 1000), 100);
});

test("timeScore: a slower model scores proportionally lower", () => {
  assert.equal(timeScore(2000, 1000), 50);
});

test("falsePositiveCleanScore: zero false positives is a perfect 100", () => {
  assert.equal(falsePositiveCleanScore(0), 100);
});

test("falsePositiveCleanScore: false positives cost points with a floor of 0", () => {
  assert.equal(falsePositiveCleanScore(2), 70);
  assert.equal(falsePositiveCleanScore(100), 0);
});

test("overallScore: weights quality (F1) at 80% and time at 20%", () => {
  assert.equal(overallScore(100, 100), 100);
  assert.equal(overallScore(100, 0), 80);
  assert.equal(overallScore(0, 100), 20);
});
