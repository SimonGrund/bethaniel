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
  classifyPlantedError,
  correctionCatchesError,
  recallByCategory,
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

// ── Error categories ──
//
// A headline recall number said the cloud model was "worse at copy-editing"
// when what it was actually worse at was commas specifically, while being
// fine at spelling. These keep that split honest.

test("classifyPlantedError: a missing comma is a comma error", () => {
  assert.equal(
    classifyPlantedError({ wrong: "yellowed brittle", right: "yellowed, brittle" }),
    "comma",
  );
  assert.equal(
    classifyPlantedError({ wrong: "nets and rope", right: "nets, and rope" }),
    "comma",
  );
});

test("classifyPlantedError: without a dictionary, single-word swaps stay one bucket", () => {
  assert.equal(classifyPlantedError({ wrong: "modern atlus.", right: "modern atlas." }), "spelling");
  assert.equal(classifyPlantedError({ wrong: "by than,", right: "by then," }), "spelling");
});

// A single "spelling" number averaged three unrelated capabilities together
// and described none of them: the deterministic Hunspell pass makes outright
// misspellings a near-solved problem (100% on the 4B), while wrong-but-real
// words sit near 50% because no dictionary can see them. Reporting 78% for
// the pair told the reader nothing true about either.
const CHECKS = {
  isKnownWord: (w: string) => ["their", "there", "then", "than", "quite", "quiet"].includes(w),
  isKnownInOtherDialect: (w: string) => ["colour", "realised", "grey"].includes(w),
};

test("classifyPlantedError: a word the dictionary rejects is a misspelling", () => {
  assert.equal(classifyPlantedError({ wrong: "modern atlus.", right: "modern atlas." }, CHECKS), "misspelling");
});

test("classifyPlantedError: a real word in the wrong place is word choice, not spelling", () => {
  assert.equal(classifyPlantedError({ wrong: "by than,", right: "by then," }, CHECKS), "wordChoice");
  assert.equal(classifyPlantedError({ wrong: "spread their,", right: "spread there," }, CHECKS), "wordChoice");
});

test("classifyPlantedError: the other dialect's spelling is neither of those", () => {
  assert.equal(classifyPlantedError({ wrong: "the colour of", right: "the color of" }, CHECKS), "dialect");
  assert.equal(classifyPlantedError({ wrong: "rising grey and", right: "rising gray and" }, CHECKS), "dialect");
});

test("classifyPlantedError: word choice wins over dialect when both dictionaries know the word", () => {
  // "grey" is listed in both stubs; the manuscript's own dialect decides.
  const both = { isKnownWord: () => true, isKnownInOtherDialect: () => true };
  assert.equal(classifyPlantedError({ wrong: "rising grey and", right: "rising gray and" }, both), "wordChoice");
});

test("classifyPlantedError: with no dialect check, everything unknown is a misspelling", () => {
  const onlyOwn = { isKnownWord: (w: string) => w === "their" };
  assert.equal(classifyPlantedError({ wrong: "the colour of", right: "the color of" }, onlyOwn), "misspelling");
});

test("classifyPlantedError: case is tested before punctuation", () => {
  // "tuesday" → "Tuesday" is punctuation-identical; without the ordering it
  // would be filed as a punctuation error.
  assert.equal(classifyPlantedError({ wrong: "tuesday came", right: "Tuesday came" }), "capitalization");
});

test("classifyPlantedError: a repeated word is its own category", () => {
  assert.equal(classifyPlantedError({ wrong: "at at all.", right: "at all." }), "duplicateWord");
  assert.equal(classifyPlantedError({ wrong: "the the last", right: "the last" }), "duplicateWord");
});

test("classifyPlantedError: non-comma punctuation stays separate from commas", () => {
  assert.equal(classifyPlantedError({ wrong: "with it's shadow", right: "with its shadow" }), "punctuation");
});

test("classifyPlantedError: a multi-word rewrite is not a spelling fix", () => {
  assert.equal(
    classifyPlantedError({ wrong: "she recognised a long jagged", right: "she recognized a long, jagged" }),
    "other",
  );
});

test("recallByCategory: rows add up to the headline recall", () => {
  const truth = [
    { wrong: "yellowed brittle", right: "yellowed, brittle" },
    { wrong: "small careful", right: "small, careful" },
    { wrong: "modern atlus.", right: "modern atlas." },
  ];
  // Caught one comma error and the spelling one; missed the other comma.
  const missed = [truth[1]];
  const rows = recallByCategory(truth, missed);
  const comma = rows.find((r) => r.category === "comma")!;
  const spelling = rows.find((r) => r.category === "spelling")!;
  assert.equal(comma.planted, 2);
  assert.equal(comma.caught, 1);
  assert.equal(comma.recall, 50);
  assert.equal(spelling.planted, 1);
  assert.equal(spelling.recall, 100);
  const totalCaught = rows.reduce((n, r) => n + r.caught, 0);
  assert.equal(totalCaught, truth.length - missed.length);
});

test("recallByCategory: a category the fixture never planted reports null, not 0%", () => {
  const rows = recallByCategory([{ wrong: "a b", right: "a, b" }], []);
  assert.equal(rows.find((r) => r.category === "spelling")!.recall, null);
  assert.equal(rows.find((r) => r.category === "comma")!.recall, 100);
});
