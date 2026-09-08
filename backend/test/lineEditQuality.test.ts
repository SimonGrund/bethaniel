// Line edit cannot be scored by planted-error recall — see the header of
// src/lineEditQuality.ts. These tests pin the reference-free score that
// replaces it: the Scribendi decision rule and the two similarity ratios that
// stop it rewarding blandness.
//
// The perplexity scorer is injected, so every case here is deterministic and
// runs without a model.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  levenshtein,
  levenshteinRatio,
  tokenSortRatio,
  tokenize,
  scribendiVerdict,
  scoreLineEdit,
} from "../src/lineEditQuality.ts";
import { parsePerplexityOutput } from "../src/perplexity.ts";

// ── the ratios ──────────────────────────────────────────────────────────────

test("levenshtein: the textbook cases", () => {
  assert.equal(levenshtein("", ""), 0);
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("abc", ""), 3);
  assert.equal(levenshtein("same", "same"), 0);
});

test("levenshteinRatio: 1 for identical, 0 for wholly different", () => {
  assert.equal(levenshteinRatio("the shore", "the shore"), 1);
  assert.equal(levenshteinRatio("", ""), 1);
  assert.ok(levenshteinRatio("abcd", "wxyz") === 0);
});

test("tokenize drops punctuation and case, keeps apostrophes", () => {
  assert.deepEqual(tokenize("The cat's mat, again!"), ["the", "cat's", "mat", "again"]);
});

test("tokenSortRatio is blind to word order, unlike levenshtein", () => {
  const a = "She turned and left the lighthouse";
  const b = "The lighthouse she turned and left";
  assert.equal(tokenSortRatio(a, b), 1, "same words, reordered — fully preserved");
  assert.ok(
    levenshteinRatio(a, b) < 0.6,
    "raw levenshtein reads the same reordering as a large change",
  );
});

test("tokenSortRatio falls when the vocabulary is swapped out", () => {
  // The failure mode the guard exists for: fluent, blander, not the author's.
  const author = "A long jagged shore studded with inlets and quiet coves";
  const bland = "There was a coastline with several bays and some water";
  assert.ok(tokenSortRatio(author, bland) < 0.8);
});

// ── the decision rule ───────────────────────────────────────────────────────

const base = { levenshteinRatio: 0.9, tokenSortRatio: 0.9 };

test("more fluent while still the author's passage scores +1", () => {
  assert.equal(
    scribendiVerdict({ ...base, perplexityBefore: 30, perplexityAfter: 20 }),
    1,
  );
});

test("less fluent scores -1", () => {
  assert.equal(
    scribendiVerdict({ ...base, perplexityBefore: 20, perplexityAfter: 30 }),
    -1,
  );
});

test("a fluency win bought by rewriting the passage away scores -1", () => {
  // Perplexity plunged, but neither ratio clears the threshold: the model
  // replaced the prose rather than editing it. Rewarding this is exactly how a
  // reference-free metric turns a novel into press-release English.
  assert.equal(
    scribendiVerdict({
      perplexityBefore: 40,
      perplexityAfter: 5,
      levenshteinRatio: 0.3,
      tokenSortRatio: 0.35,
    }),
    -1,
  );
});

test("either ratio clearing the threshold is enough", () => {
  // Heavy reordering: levenshtein says "changed", token sort says "same words".
  assert.equal(
    scribendiVerdict({
      perplexityBefore: 30,
      perplexityAfter: 25,
      levenshteinRatio: 0.4,
      tokenSortRatio: 0.95,
    }),
    1,
  );
});

test("an untouched passage scores 0, not +1", () => {
  // A line editor that returns the manuscript unchanged has done nothing. If
  // this scored +1 the metric would rank "does nothing" above "tries".
  assert.equal(
    scribendiVerdict({
      perplexityBefore: 25,
      perplexityAfter: 25,
      levenshteinRatio: 1,
      tokenSortRatio: 1,
    }),
    0,
  );
});

test("equal perplexity on a real edit is neither a win nor a loss", () => {
  assert.equal(
    scribendiVerdict({ ...base, perplexityBefore: 25, perplexityAfter: 25 }),
    0,
  );
});

test("the threshold is configurable", () => {
  const input = {
    perplexityBefore: 30,
    perplexityAfter: 20,
    levenshteinRatio: 0.7,
    tokenSortRatio: 0.7,
  };
  assert.equal(scribendiVerdict(input), -1, "0.7 fails the default 0.8 floor");
  assert.equal(scribendiVerdict({ ...input, threshold: 0.6 }), 1);
});

// ── the aggregate ───────────────────────────────────────────────────────────

test("scoreLineEdit averages verdicts and counts the outcomes", async () => {
  const ppl = async (text: string) => (text.startsWith("better") ? 10 : 20);
  const result = await scoreLineEdit(
    [
      { before: "the shore was long and jagged here", after: "better shore was long and jagged here" },
      { before: "the shore was long and jagged here", after: "the shore was long and jagged here" },
    ],
    ppl,
  );
  assert.equal(result.improved, 1);
  assert.equal(result.unchanged, 1);
  assert.equal(result.degraded, 0);
  assert.equal(result.score, 0.5);
});

test("scoreLineEdit scores each distinct passage only once", async () => {
  // The scorer spawns a process and loads a model per call, so a repeated
  // passage must not pay twice.
  let calls = 0;
  const ppl = async () => {
    calls++;
    return 15;
  };
  await scoreLineEdit(
    [
      { before: "one and the same passage", after: "one and the same passage" },
      { before: "one and the same passage", after: "one and the same passage" },
    ],
    ppl,
  );
  assert.equal(calls, 1, "one distinct string across both pairs");
});

test("an empty run scores 0 rather than NaN", async () => {
  const result = await scoreLineEdit([], async () => 10);
  assert.equal(result.score, 0);
  assert.deepEqual(result.passages, []);
});

// ── reading the binary ──────────────────────────────────────────────────────

test("parsePerplexityOutput reads the final estimate", () => {
  const out = "perplexity: 12 chunks\n[1]8.9,[2]9.4\nFinal estimate: PPL = 9.2871 +/- 0.31\n";
  assert.equal(parsePerplexityOutput(out), 9.2871);
});

test("parsePerplexityOutput falls back to the last running estimate", () => {
  // A run cut short still carries a usable number.
  assert.equal(parsePerplexityOutput("[1]8.9,[2]9.4,[3]10.1"), 10.1);
});

test("parsePerplexityOutput returns null when there is no number to read", () => {
  assert.equal(
    parsePerplexityOutput("error: you need at least 1024 tokens to evaluate perplexity"),
    null,
  );
});
