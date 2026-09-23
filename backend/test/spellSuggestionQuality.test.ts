// Report the word; withhold the guess.
//
// Measured on two real manuscripts, the suggestions were the damaging part:
// "Tobias" (610 occurrences) -> "To bias", "seagrass" -> "Seagram",
// "Krogman" -> "Frogman", "sworddancers" -> "sword dancers". Every one of
// those words is worth REPORTING — a misspelled character name is among the
// most important things to catch before publishing — and none of those
// replacements is worth proposing.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initSpellchecker,
  getSpellCorrections,
  suggestionIsWorthOffering,
} from "../src/spellcheck.ts";

/** The first correction for a passage, if the layer reports one at all. */
async function only(text: string, lang = "en_US") {
  await initSpellchecker();
  const cs = getSpellCorrections(text, lang, { englishDialect: "american" });
  return cs[0];
}

test("a word the other English knows is reported without a guess", async () => {
  // "barque" is in en_GB and not en_US. The old layer proposed "baroque".
  // A capitalised name like "Tobias" never reaches this rule — a mid-sentence
  // capital is protected outright, which is what the manuscript-wide name set
  // now guarantees for every chunk.
  const c = await only("The barque rode low in the water that morning.");
  assert.ok(c, "barque must still be REPORTED");
  assert.equal(c.corrected, c.original, "but no replacement is proposed");
  assert.equal(c.reason, "spell-check-unknown");
});

test("a finding with no suggestion is flagged, never applied", async () => {
  // Copy edits auto-apply anything unflagged. Applying a no-op would file it
  // as a completed correction the author never saw.
  const c = await only("The barque rode low in the water that morning.");
  assert.equal(c.flagged, true);
});

test("an ordinary typo still gets its suggestion", async () => {
  const c = await only("He walked thruogh the hall and out into the yard.");
  assert.ok(c);
  assert.notEqual(c.corrected, c.original, "this one the dictionary can vouch for");
  assert.notEqual(c.flagged, true);
});

// ── suggestionIsWorthOffering, the gate itself ──

test("a lowercase word is never given a Capitalised replacement", () => {
  assert.equal(suggestionIsWorthOffering("seagrass", "Seagram"), false);
  assert.equal(suggestionIsWorthOffering("southlander", "Netherlander"), false);
});

test("a bare space insertion into a closed compound is refused", () => {
  assert.equal(suggestionIsWorthOffering("sworddancers", "sword dancers"), false);
  assert.equal(suggestionIsWorthOffering("woodsmoke", "wood smoke"), false);
});

test("eye-dialect keeps its spelling", () => {
  assert.equal(suggestionIsWorthOffering("Per’aps", "Perhaps"), false);
  assert.equal(suggestionIsWorthOffering("s’pose", "pose"), false);
});

test("an interjection is not a misspelling of a word", () => {
  // Caught two ways: a stretched letter, or no vowel at all. "Mhmm" has no
  // tripled letter, which is why the vowel rule exists.
  assert.equal(suggestionIsWorthOffering("Shhh", "Shah"), false);
  assert.equal(suggestionIsWorthOffering("Mhmm", "Hmm"), false);
  assert.equal(suggestionIsWorthOffering("Pfft", "Pft"), false);
  // A real word always has one, so nothing ordinary is caught by it.
  assert.equal(suggestionIsWorthOffering("thruogh", "through"), true);
});

test("a possessive is not eye-dialect", () => {
  // The eye-dialect rule must not fire on a trailing ’s.
  assert.equal(suggestionIsWorthOffering("captains’s", "captain's"), true);
});

test("a sentence-initial capital keeps its fix", async () => {
  // There is no capitalised-word rule, deliberately. A mid-sentence capital
  // never reaches this point — it is skipped as a proper noun — so every
  // capitalised word that does is sentence-initial, i.e. a typo candidate.
  // An earlier version of this rule withheld "Teh" -> "The".
  assert.equal(suggestionIsWorthOffering("Teh", "The"), true);
  const c = await only("Teh cat sat on the mat by the window.");
  assert.ok(c);
  assert.notEqual(c.corrected, c.original, "the guess must not be withheld");
  assert.equal(c.reason, undefined, "an outright non-word needs no special tag");
});

test("an ordinary suggestion passes", () => {
  assert.equal(suggestionIsWorthOffering("thruogh", "through"), true);
});
