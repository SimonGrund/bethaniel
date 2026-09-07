// Hunspell's suggest() is built for a human picking from a list. Taking
// suggestion[0] and proposing it as "the fix" produced meaning-changing edits
// on already-correct prose — measured on the clean German fixture:
//
//   siebzehnzähnige -> siebzehnjährige   (seventeen-TOOTHED -> seventeen-YEAR-OLD)
//   tintenfleckigen -> grünfleckigen     (ink-stained -> green-stained)
//   Zehntelgrad     -> Zehntelegrad      (valid compound -> non-word)
//
// The flag is right — the dictionary genuinely does not know these coined
// compounds. The SUBSTITUTION is what corrupts the manuscript, so a suggestion
// too far from the original is withheld rather than proposed.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isConfidentSuggestion, isValidCompound } from "../src/spellcheck.ts";

// Minimal stand-in: only the words a real dictionary would know.
const KNOWN = new Set([
  "wood", "smoke", "lot", "inconfundible", "mente", "grün", "fleckig",
  "zehntel", "grad", "receive", "the",
]);
const dict = { correct: (w: string) => KNOWN.has(w.toLowerCase()) };

test("accepts a close suggestion — an ordinary typo", () => {
  assert.equal(isConfidentSuggestion("recieve", "receive", dict), true);
  assert.equal(isConfidentSuggestion("teh", "the", dict), true);
});

test("rejects a suggestion far enough away to be a different word", () => {
  // distance 5 on a 15-character word: not a slip of the fingers
  assert.equal(
    isConfidentSuggestion("tintenfleckigen", "grünfleckigen", dict),
    false,
  );
});

test("distance alone cannot protect a valid compound — that is isValidCompound's job", () => {
  // siebzehnzähnige -> siebzehnjährige is TWO edits, and Zehntelgrad ->
  // Zehntelegrad is one, yet both rewrite the meaning. Documented here so the
  // guard is not mistaken for complete cover: what saves these words is not
  // being flagged at all, because they decompose into real words.
  assert.equal(
    isConfidentSuggestion("siebzehnzähnige", "siebzehnjährige", dict),
    true,
  );
  assert.equal(isConfidentSuggestion("zehntelgrad", "zehntelegrad", dict), true);
});

test("rejects splitting a word whose parts are both real words", () => {
  // A coined compound, not a typo — "wood smoke" and "inconfundible mente"
  // are the dictionary's ignorance showing, not the author's mistake.
  assert.equal(isConfidentSuggestion("woodsmoke", "wood smoke", dict), false);
  assert.equal(
    isConfidentSuggestion("inconfundiblemente", "inconfundible mente", dict),
    false,
  );
});

test("still allows a split where one part is too short to be a morpheme", () => {
  // "alot" -> "a lot" is a real fix; "a" is not a compound element.
  assert.equal(isConfidentSuggestion("alot", "a lot", dict), true);
});

test("scales tolerance with word length, but never below 2", () => {
  // Long words get slightly more room, short ones do not.
  assert.equal(isConfidentSuggestion("cat", "cot", dict), true);
  assert.equal(isConfidentSuggestion("cat", "dogs", dict), false);
});

test("an identical or empty suggestion is not confident", () => {
  assert.equal(isConfidentSuggestion("word", "word", dict), false);
  assert.equal(isConfidentSuggestion("word", "", dict), false);
});

// ── Compound decomposition ──

test("isValidCompound: a German coinage built from real words is not a typo", () => {
  assert.equal(isValidCompound("zehntelgrad", "de", dict), true);
  assert.equal(isValidCompound("Zehntelgrad".toLowerCase(), "de-DE", dict), true);
});

test("isValidCompound: only for languages that actually compound", () => {
  // Same word, English dictionary rules — no compound assumption.
  assert.equal(isValidCompound("zehntelgrad", "en", dict), false);
});

test("isValidCompound: a missing-space typo still gets flagged", () => {
  // "lot" is a word but "a" is not a compound element, so this never
  // qualifies — the 3-character floor is what keeps real typos catchable.
  assert.equal(isValidCompound("alot", "de", dict), false);
});

test("isValidCompound: a short word is never treated as a compound", () => {
  assert.equal(isValidCompound("woodlot", "de", dict), false);
});
