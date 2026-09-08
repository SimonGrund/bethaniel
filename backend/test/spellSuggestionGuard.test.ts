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

// ── Narrowing, measured on the German stress fixture ──
//
// The guard above was suppressing four bad substitutions and sixteen good
// fixes. Two of its three tests carried the cost:
//
//   - a head-only "does this word start with a real word" check fired on 20
//     of 20 downgraded German words. Almost every German noun begins with a
//     shorter noun, so it only ever said "this is German". Removed.
//   - the compound test was applied to capitalization fixes, where it has no
//     claim to make: "werkstatt" -> "Werkstatt" decomposes exactly as well as
//     the word it corrects. Five good fixes were lost that way.

test("a capitalization fix decomposes like any compound — that is not a reason to doubt it", () => {
  // Both halves are real German words, so isValidCompound says "coinage" —
  // but the suggestion only changes case, which settles nothing about
  // compounding. The caller must not consult the compound test at all here.
  const de = {
    correct: (w: string) =>
      ["werk", "statt", "werkstatt", "bank", "werkbank"].includes(w.toLowerCase()),
  };
  assert.equal(isValidCompound("werkstatt", "de", de as never), true);
  // The fix itself is an ordinary, confident one — nothing about the
  // substitution is in doubt.
  assert.equal(isConfidentSuggestion("werkstatt", "Werkstatt", de), true);
});

test("a typo inside a compound is still a typo, not a coinage", () => {
  // "Ledermapppe" (three p's) does NOT decompose — "mapppe" is no word — so
  // the compound test correctly declines to protect it, and the fix stands.
  const de = {
    correct: (w: string) => ["leder", "mappe", "ledermappe"].includes(w.toLowerCase()),
  };
  assert.equal(isValidCompound("ledermapppe", "de", de as never), false);
  assert.equal(isConfidentSuggestion("Ledermapppe", "Ledermappe", de), true);
});

test("a genuine coinage is still withheld — the guard keeps its purpose", () => {
  const de = { correct: (w: string) => ["zehntel", "grad"].includes(w.toLowerCase()) };
  // Zehntelgrad is a real compound the dictionary never enumerated; rewriting
  // it to the non-word "Zehntelegrad" is exactly what must stay suppressed,
  // and it is not a capitalization change, so the compound test still applies.
  assert.equal(isValidCompound("zehntelgrad", "de", de as never), true);
});
