// Benchmarking (sample_texts/stress100_*) showed the local models sometimes
// invent corrections that aren't fixes at all — inserting a connective word
// that wasn't there, splitting a correctly-spelled compound word apart, or
// quietly changing which name a proper noun is. The copy-edit prompt already
// forbids all three (see prompts.ts's "NEVER INVENT TEXT THAT WASN'T THERE"
// block), but a re-benchmark after tightening that language showed zero
// change in these specific patterns — the same hallucinations recurred
// verbatim. These three are mechanically detectable with no risk of dropping
// a real fix, so they're caught here as a deterministic backstop.

import { test, before } from "node:test";
import assert from "node:assert/strict";

import { parseCorrectionsJson } from "../src/llm.ts";
import { initSpellchecker } from "../src/spellcheck.ts";

// parseCorrectionsJson's hygiene checks consult the dictionary (a correction
// that splits a real compound, or renames a proper noun, is dropped). Hunspell
// is WebAssembly, so that dictionary does not exist until this resolves.
before(async () => {
  await initSpellchecker();
});

test("drops a correction that only prepends an invented connective word", () => {
  const raw = '{"original": "forever. He would", "corrected": "forever. Furthermore, he would"}';
  assert.deepEqual(parseCorrectionsJson(raw, "en"), []);
});

test("drops a correction that inserts a connective word mid-sentence", () => {
  const raw = '{"original": "suited. He signed", "corrected": "suited. Furthermore, he signed"}';
  assert.deepEqual(parseCorrectionsJson(raw, "en"), []);
});

test("drops a correction that splits a dictionary-valid compound word apart", () => {
  const raw = '{"original": "It was daytime outside.", "corrected": "It was day time outside."}';
  assert.deepEqual(parseCorrectionsJson(raw, "en"), []);
});

test("keeps a compound-word split when the original word isn't in the dictionary (fail-open)", () => {
  // "woodsmoke" is a real word but absent from the en_US Hunspell wordlist —
  // the filter can't vouch for it, so it must not drop the correction.
  const raw = '{"original": "old woodsmoke.", "corrected": "old wood smoke."}';
  const cs = parseCorrectionsJson(raw, "en");
  assert.equal(cs.length, 1);
});

test("drops a correction that changes a proper noun's letters, not just its case", () => {
  const raw = '{"original": "Thaddeus Okafor,", "corrected": "Thaddeus Orator,"}';
  assert.deepEqual(parseCorrectionsJson(raw, "en"), []);
});

test("keeps a pure capitalization fix on the same name", () => {
  const raw = '{"original": "tuesday came", "corrected": "Tuesday came"}';
  const cs = parseCorrectionsJson(raw, "en");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "Tuesday came");
});

test("keeps a genuine spelling fix on a common word", () => {
  const raw = '{"original": "of ceder and", "corrected": "of cedar and"}';
  const cs = parseCorrectionsJson(raw, "en");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "of cedar and");
});

test("keeps a confusable-word swap", () => {
  const raw = '{"original": "to there satchel", "corrected": "to their satchel"}';
  const cs = parseCorrectionsJson(raw, "en");
  assert.equal(cs.length, 1);
});

test("keeps a dialect spelling fix", () => {
  const raw = '{"original": "grey morning", "corrected": "gray morning"}';
  const cs = parseCorrectionsJson(raw, "en");
  assert.equal(cs.length, 1);
});

test("without a lang argument, English is assumed and all three checks still apply", () => {
  const connective = '{"original": "forever. He would", "corrected": "forever. Furthermore, he would"}';
  assert.deepEqual(parseCorrectionsJson(connective), []);

  const split = '{"original": "It was daytime outside.", "corrected": "It was day time outside."}';
  assert.deepEqual(parseCorrectionsJson(split), []);
});

// ── A capitalized misspelling is not a name ──
//
// The proper-noun rule fires on a capitalized token that is not a dictionary
// word. That describes every name it was written to protect — and also every
// sentence-initial typo, and in German, where the orthography capitalizes all
// nouns, very nearly every noun typo there is. Measured on the German stress
// fixture, it discarded 10 of 10 correct typo fixes the editor and
// LanguageTool had produced.
//
// What separates the two is the REPLACEMENT: "Werkzeug" and "Receive" are real
// words, so the correction is a spelling fix; "Thaddeous" and "Constanse" are
// not, so it is a name being mangled.

test("keeps a sentence-initial misspelling — capitalized is not the same as a name", () => {
  const raw = '{"original": "Recieve the parcel", "corrected": "Receive the parcel"}';
  const cs = parseCorrectionsJson(raw, "en");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "Receive the parcel");
});

test("keeps a German noun typo fix — the dictionary stores the fix capitalized", () => {
  // "zeichnungen" is absent from the dictionary; "Zeichnungen" is there. Asking
  // only about the lowercase form finds nothing in the language this rule hurts
  // most, so the replacement is tried both ways.
  const raw = '{"original": "keine Zeichungen", "corrected": "keine Zeichnungen"}';
  const cs = parseCorrectionsJson(raw, "de");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "keine Zeichnungen");
});

test("still drops a name corruption in German", () => {
  const raw = '{"original": "Elias kam", "corrected": "Elios kam"}';
  assert.deepEqual(parseCorrectionsJson(raw, "de"), []);
});
