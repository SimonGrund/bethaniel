// The Danish spell pass reported the commonest words in the language as
// misspellings and "corrected" them into nonsense:
//
//   "den" -> "gen"      "kom" -> "gom"      "havde" -> "hævde"
//   "sin" -> "sen"      "gik" -> "gig"      "været" -> "næret"
//
// 34 such corrections on an error-free Danish fixture, 73 on a longer one.
//
// Cause: Hunspell lets an entry carry morphological analysis tags after the
// word — da_DK.dic writes `den al:dens`, `havde st:have`, `kom st:komme` for
// 26,232 of its entries, and they are precisely the high-frequency ones
// (pronouns, auxiliaries, irregular verb forms). nspell does not strip those
// tags, so it indexed the whole line: "den al:dens" was a known word and
// plain "den" was not. de_DE.dic and both English dictionaries carry no
// morphological fields at all, which is why only Danish was affected.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getWordValidator,
  getSpellCorrections,
  stripMorphologicalFields,
} from "../src/spellcheck.ts";

// ── the transform itself ────────────────────────────────────────────────────

test("morphological fields are stripped, affix flags are kept", () => {
  assert.equal(stripMorphologicalFields("den al:dens"), "den");
  assert.equal(stripMorphologicalFields("havde st:have"), "havde");
  assert.equal(
    stripMorphologicalFields("sin al:sit al:sine al:sines"),
    "sin",
    "every trailing tag goes, not just the first",
  );
  assert.equal(
    stripMorphologicalFields("kvinde/10,11,2,39,31"),
    "kvinde/10,11,2,39,31",
    "affix flags are what makes the entry inflect — they must survive",
  );
  assert.equal(
    stripMorphologicalFields("bog/44,10,39,31 st:bog"),
    "bog/44,10,39,31",
    "flags kept, tags dropped, on the same entry",
  );
});

test("a line count and a plain word are left alone", () => {
  assert.equal(stripMorphologicalFields("179979"), "179979");
  assert.equal(stripMorphologicalFields("bogbinder"), "bogbinder");
});

test("an entry whose space is not a morphological tag survives", () => {
  // Only a trailing run of xx:value tags is removed.
  assert.equal(stripMorphologicalFields("de facto"), "de facto");
});

// ── the words that were broken ──────────────────────────────────────────────

const DANISH_BASICS = [
  "den", "det", "sin", "havde", "kom", "gik", "hendes", "hende",
  "været", "ville", "dem", "kunne", "nogen", "nogle", "lagde",
];

test("the commonest Danish words are known to the dictionary", () => {
  const known = getWordValidator("da");
  assert.ok(known, "the Danish dictionary should load");
  for (const word of DANISH_BASICS) {
    assert.ok(known!(word), `"${word}" must be a known Danish word`);
  }
});

test("error-free Danish prose does not get its function words 'corrected'", () => {
  const clean =
    "Da brevet kom, havde hun ikke bundet en bog i ni år. " +
    "Hun stod i sin mors værksted, og hun vidste, at nogen havde været der. " +
    "Hun lagde det på bænken, og det gik som det skulle.";
  const corrections = getSpellCorrections(clean, "da");
  assert.deepEqual(
    corrections.map((c) => c.original),
    [],
    "no word in ordinary Danish prose should be flagged",
  );
});

test("a real Danish misspelling is still caught", () => {
  // The fix must not turn the Danish pass into a no-op.
  const corrections = getSpellCorrections("Hun stod i sin mors værkstd.", "da");
  assert.ok(
    corrections.some((c) => c.original === "værkstd"),
    "a genuine misspelling must still be reported",
  );
});
