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

// ── paragraph-final punctuation restoration ──
// Real case: the model rewrote a paragraph-final sentence and dropped its
// period ("…flashed Tobias a forced smile." → "…forced smile"), the reviewer
// endorsed it, and the exported paragraph ended on a bare word.

test("restores a stripped paragraph-final period while keeping the real fix", () => {
  const text =
    "“Okay… Just for a little while, though.” His heart beat fast as he flashed Tobias a forced smile.\n\n\nAaron blinked in the warm light.";
  const [out, applied] = applyCorrections(text, [
    {
      original:
        "“Okay… Just for a little while, though.” His heart beat fast as he flashed Tobias a forced smile.",
      corrected:
        "“Okay… just for a little while, though.” His heart beat fast as he flashed Tobias a forced smile",
    },
  ]);
  assert.equal(applied.length, 1);
  assert.ok(out.includes("“Okay… just for")); // the legitimate fix survives
  assert.ok(out.includes("a forced smile.\n\n\nAaron")); // the period is back
});

test("restores a stripped period at the very end of the text", () => {
  const text = "The sound of Tabahi sleeping filled the air.";
  const [out] = applyCorrections(text, [
    {
      original: "The sound of Tabahi sleeping filled the air.",
      corrected: "The sound of Tabahi filled the air",
    },
  ]);
  assert.equal(out, "The sound of Tabahi filled the air.");
});

test("an em-dash rewrite may still drop a paragraph-final period", () => {
  const text = "Bria readied to block—.\n\nToo late.";
  const [out] = applyCorrections(text, [
    { original: "Bria readied to block—.", corrected: "Bria readied to block—" },
  ]);
  assert.equal(out, "Bria readied to block—\n\nToo late.");
});

test("mid-paragraph punctuation changes are untouched by the restore", () => {
  const text = "He waved. Then he left.\n";
  const [out] = applyCorrections(text, [
    { original: "He waved.", corrected: "He waved," },
  ]);
  assert.equal(out, "He waved, Then he left.\n");
});

// ── italic / emphasis marker preservation ──
// A correction whose text sits inside *italics* must never splice the markers
// away. The fuzzy locator replaces fuzzy.match (not c.original), so the marker
// guard is checked against the actual replaced span too; today fuzzyFind's
// equivalence classes (whitespace/quotes/dashes) cannot swallow markers, so
// these tests lock in the invariant rather than exercise a live bug.

const countEmphasisMarkers = (s: string): number =>
  (s.match(/[*_]/g) ?? []).length;

test("fix inside an italic span keeps the markers (exact match)", () => {
  const text = "He said, *She wisphered softly*, then left.";
  const [out, applied] = applyCorrections(text, [
    { original: "She wisphered softly", corrected: "She whispered softly" },
  ]);
  assert.equal(applied.length, 1);
  assert.equal(out, "He said, *She whispered softly*, then left.");
  assert.equal(countEmphasisMarkers(out), countEmphasisMarkers(text));
});

test("fix inside an italic span keeps the markers (fuzzy match)", () => {
  // The double space forces the fuzzy whitespace-flexible locator.
  const text = "He said, *She wisphered  softly*, then left.";
  const [out, applied] = applyCorrections(text, [
    { original: "She wisphered softly", corrected: "She whispered softly" },
  ]);
  assert.equal(applied.length, 1);
  assert.match(out, /\*She whispered\s+softly\*/);
  assert.equal(countEmphasisMarkers(out), countEmphasisMarkers(text));
});

test("a correction that strips italic markers is rejected", () => {
  const text = "The word *softly* was emphasized.";
  const [out, applied, skipped] = applyCorrections(text, [
    { original: "*softly*", corrected: "softly" },
  ]);
  assert.equal(out, text);
  assert.equal(applied.length, 0);
  assert.match(skipped[0].reason ?? "", /would alter markdown/);
});

test("rejects a correction that wraps punctuation in underscores", () => {
  const text = "Are you okay? He left.";
  const [out, applied, skipped] = applyCorrections(text, [
    { original: "okay?", corrected: "okay_?_" },
    { original: "left.", corrected: "left_._" },
  ]);
  assert.equal(out, text, "no stray underscores may be injected");
  assert.ok(!out.includes("_"));
  assert.equal(applied.length, 0);
  assert.equal(skipped.length, 2);
  for (const s of skipped) assert.match(s.reason ?? "", /would alter markdown/);
});

test("rejects a correction that adds italic asterisks the original lacked", () => {
  const text = "She whispered softly.";
  const [out, applied, skipped] = applyCorrections(text, [
    { original: "whispered softly", corrected: "*whispered softly*" },
  ]);
  assert.equal(out, text);
  assert.equal(applied.length, 0);
  assert.match(skipped[0].reason ?? "", /would alter markdown/);
});

test("underscore emphasis (docx import style) survives a fix inside it", () => {
  // DOCX import (mammoth + turndown) emits _underscore_ emphasis.
  const text = "Hun skrev _Kniven lå på bordet_ i margenen.";
  const [out, applied] = applyCorrections(text, [
    { original: "Kniven lå på bordet", corrected: "Kniven lå på bordet." },
  ]);
  assert.equal(applied.length, 1);
  assert.equal(countEmphasisMarkers(out), countEmphasisMarkers(text));
  assert.match(out, /_Kniven lå på bordet\.?_/);
});

// ── Introduced dot-adjacent punctuation guards (".," and "..") ──
// A correction must never inject a period jammed against other punctuation:
// ","→".," or "sentence."→"sentence.." are corruption, not corrections.

test("skips a correction that turns a comma into '.,'", () => {
  const text = "He waited, then left.";
  const [out, , skipped] = applyCorrections(text, [
    { original: "waited,", corrected: "waited.," },
  ]);
  assert.equal(out, text, "must not inject '.,'");
  assert.ok(!out.includes(".,"));
  assert.ok(skipped.length >= 1, "the bad correction is skipped");
});

test("skips a correction that doubles a sentence-final period", () => {
  const text = "She left. He stayed.";
  const [out, , skipped] = applyCorrections(text, [
    { original: "left.", corrected: "left.." },
  ]);
  assert.equal(out, text);
  assert.ok(!out.includes(".."));
  assert.ok(skipped.length >= 1);
});

test("absorbs an introduced period spliced against an adjacent comma", () => {
  // original span stops short of the manuscript's comma; corrected adds a '.'
  const text = "He went home, then slept.";
  const [out] = applyCorrections(text, [
    { original: "home", corrected: "home." },
  ]);
  assert.ok(!out.includes("home.,"), "the seam '.,' must not appear");
  assert.ok(!out.includes(".,"));
});

test("a legitimate fix inside text that already contains '.,' is not blocked", () => {
  // "etc.," is the author's — a correction that keeps it must still apply.
  const text = "He packed socks, etc., and left in haste.";
  const [out] = applyCorrections(text, [
    { original: "in haste", corrected: "in a hurry" },
  ]);
  assert.equal(out, "He packed socks, etc., and left in a hurry.");
});
