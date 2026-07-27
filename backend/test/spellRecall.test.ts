// Tests for spell-check RECALL improvements (single-run spelling coverage):
//  - no per-chunk correction cap
//  - sentence-initial capitalized misspellings are caught (typos at the start
//    of a sentence look like proper nouns to the old heuristic)
//  - mid-sentence capitalized words, and names seen capitalized mid-sentence
//    anywhere in the text, are still protected (never auto-"corrected")

import { test } from "node:test";
import assert from "node:assert/strict";

import { getSpellCorrections } from "../src/spellcheck.ts";

test("getSpellCorrections: no per-chunk cap — flags far more than 30 misspellings", () => {
  // 33 distinct lowercase non-words — just past the old hard cap of 30.
  const words: string[] = [];
  for (let i = 0; i < 33; i++) {
    const a = String.fromCharCode(97 + Math.floor(i / 20));
    const b = String.fromCharCode(97 + (i % 20));
    words.push(`zqx${a}${b}`); // e.g. zqxaa, zqxab, … — none are real words
  }
  const text = words.join(" ") + ".";
  const corrections = getSpellCorrections(text, "en_US", {});
  assert.ok(
    corrections.length > 30,
    `expected the cap to be gone (>30), got ${corrections.length}`,
  );
});

test("getSpellCorrections: catches a sentence-initial capitalized misspelling", () => {
  const text = "Teh cat sat. Recieve the box.";
  const originals = getSpellCorrections(text, "en_US", {}).map((c) => c.original);
  assert.ok(originals.includes("Teh"), `expected "Teh" flagged, got ${JSON.stringify(originals)}`);
  assert.ok(
    originals.includes("Recieve"),
    `expected "Recieve" flagged, got ${JSON.stringify(originals)}`,
  );
});

test("getSpellCorrections: a mid-sentence capitalized proper noun is NOT flagged", () => {
  const text = "I saw Karim there today.";
  const corrections = getSpellCorrections(text, "en_US", {});
  assert.equal(corrections.length, 0, JSON.stringify(corrections));
});

test("getSpellCorrections: a name seen capitalized mid-sentence is protected even at a sentence start", () => {
  // "Karim" starts the second sentence but also appears mid-sentence, so it is
  // clearly a name — it must not be flagged just because it opens a sentence.
  const text = "Later that day I saw Karim. Karim smiled at me.";
  const originals = getSpellCorrections(text, "en_US", {}).map((c) => c.original);
  assert.ok(!originals.includes("Karim"), `"Karim" must be protected, got ${JSON.stringify(originals)}`);
});

test("getSpellCorrections: a correctly-spelled capitalized sentence start is not flagged", () => {
  const text = "The cat sat. She smiled warmly.";
  assert.deepEqual(getSpellCorrections(text, "en_US", {}), []);
});
