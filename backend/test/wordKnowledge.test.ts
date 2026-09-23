// One reading of "is this a word".
//
// harvestForUpload asked en_US OR en_GB; getSpellCorrections asked en_US
// alone. "Tobias" appears 610 times in one real manuscript, is in en_GB and
// not en_US, and so was a real word to the lexicon (never harvested, never
// protected) and a misspelling to the speller, which proposed "To bias".
// Every one of the 75 findings in that class lived in that gap.

import { test } from "node:test";
import assert from "node:assert/strict";

import { initSpellchecker } from "../src/spellcheck.ts";
import { wordKnowledge, isWordAnywhere } from "../src/wordKnowledge.ts";

test("a word only the other English knows is reported as exactly that", async () => {
  await initSpellchecker();
  const know = wordKnowledge("en", "american")!;
  const v = know("Tobias");
  assert.equal(v.inDeclared, false, "en_US does not have it");
  assert.equal(v.inOtherEnglish, true, "en_GB does");
});

test("a word both dictionaries know is in both", async () => {
  await initSpellchecker();
  const know = wordKnowledge("en", "american")!;
  assert.equal(know("harbour").inOtherEnglish, true);
  assert.deepEqual(know("table"), { inDeclared: true, inOtherEnglish: true });
});

test("a word neither knows is in neither", async () => {
  await initSpellchecker();
  const know = wordKnowledge("en", "american")!;
  assert.deepEqual(know("Ricko"), { inDeclared: false, inOtherEnglish: false });
});

test("the declared dialect decides which one is 'declared'", async () => {
  await initSpellchecker();
  const us = wordKnowledge("en", "american")!;
  const gb = wordKnowledge("en", "british")!;
  // "grey" is en_GB only.
  assert.equal(us("grey").inDeclared, false);
  assert.equal(us("grey").inOtherEnglish, true);
  assert.equal(gb("grey").inDeclared, true);
});

test("a non-English language has no 'other English'", async () => {
  await initSpellchecker();
  const da = wordKnowledge("da")!;
  const v = da("hund");
  assert.equal(v.inDeclared, true);
  assert.equal(v.inOtherEnglish, false, "there is no other dictionary to ask");
});

test("a language with no dictionary returns null", async () => {
  await initSpellchecker();
  assert.equal(wordKnowledge("xx"), null);
});

test("isWordAnywhere is true when either English knows it", async () => {
  await initSpellchecker();
  const any = isWordAnywhere("en", "american")!;
  assert.equal(any("Tobias"), true, "this is what the lexicon harvest asks");
  assert.equal(any("Ricko"), false);
});
