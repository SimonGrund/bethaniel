// Regression tests for the copy/line-edit correction pipeline.
// Run with: npm test  (uses node:test via the tsx loader — no extra deps).
//
// These lock in the guarantee that the editor cannot turn a correctly-spelled
// word into a non-word, plus the word-boundary, proper-noun, and real-word-swap
// safeguards added on top of it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyCorrections, isRealWordSwap } from "../src/llm.ts";
import { getWordValidator } from "../src/spellcheck.ts";

const isAcceptableWord = getWordValidator("en", { englishDialect: "american" });
assert.equal(
  typeof isAcceptableWord,
  "function",
  "English validator should load (dictionaries present)",
);
const validate = isAcceptableWord!;

test("rejects the reported corruption (real word → non-word)", () => {
  const text = "Apparently, Aaron's foul mood didn't bother him.";
  const [out, applied, skipped] = applyCorrections(
    text,
    [
      { original: "Apparently", corrected: "Appwrently" },
      { original: "didn't", corrected: "did't" },
    ],
    { isAcceptableWord: validate },
  );
  assert.equal(out, text, "text must be unchanged");
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 2);
  for (const s of skipped) assert.match(s.reason ?? "", /misspelled word/);
});

test("still applies a genuine typo fix", () => {
  const [out, applied] = applyCorrections(
    "I went to teh store.",
    [{ original: "teh", corrected: "the" }],
    { isAcceptableWord: validate },
  );
  assert.equal(out, "I went to the store.");
  assert.equal(applied.length, 1);
});

test("word-boundary: a single-word fix doesn't mutate a larger word", () => {
  // "form" must be replaced only as a standalone word, never inside "formal".
  const [out] = applyCorrections(
    "He kept formal form here.",
    [{ original: "form", corrected: "from" }],
    { isAcceptableWord: validate },
  );
  assert.equal(out, "He kept formal from here.");
});

test("protects proper nouns (name → different real word is rejected)", () => {
  const text = "Aaron is here.";
  const [out, applied, skipped] = applyCorrections(
    text,
    [{ original: "Aaron", corrected: "around" }],
    { isAcceptableWord: validate },
  );
  assert.equal(out, text);
  assert.equal(applied.length, 0);
  assert.match(skipped[0].reason ?? "", /proper noun/);
});

test("without a validator the spell gate is a no-op (proves the gate matters)", () => {
  const [out] = applyCorrections(
    "Apparently fine.",
    [{ original: "Apparently", corrected: "Appwrently" }],
    {},
  );
  assert.equal(out, "Appwrently fine.");
});

test("isRealWordSwap detects valid→valid single-word swaps only", () => {
  assert.equal(isRealWordSwap("form", "from", validate), true);
  assert.equal(isRealWordSwap("teh", "the", validate), false); // origin not a word
  assert.equal(isRealWordSwap("cat", "cat", validate), false); // identical
  assert.equal(isRealWordSwap("big cat", "big dog", validate), false); // multi-token
});

test("getWordValidator returns null for an unsupported language", () => {
  assert.equal(getWordValidator("xx"), null);
});
