// The engine, tested apart from the pattern table: substitution, case
// preservation, span shape, and the language gate.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findConfusablePatterns } from "../src/confusablePatterns.ts";

test("a match becomes a correction over the matched span only", () => {
  const cs = findConfusablePatterns("He read the letter form the king.", "en");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].original, "form the");
  assert.equal(cs[0].corrected, "from the");
  assert.equal(cs[0].reason, "confusable:form-det");
});

test("an initial capital survives the substitution", () => {
  const cs = findConfusablePatterns("Weather or not they come, we sail.", "en");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "Whether or not");
});

test("a Danish substitution replaces the right word", () => {
  const cs = findConfusablePatterns("Der stod en man ved døren.", "da");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].original, "en man");
  assert.equal(cs[0].corrected, "en mand");
});

test("a two-word wrong form collapses to one word", () => {
  const cs = findConfusablePatterns("Han kom til bage om aftenen.", "da");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "tilbage");
});

test("patterns of another language do not run", () => {
  // "en man" is Danish; an English manuscript must not be scored against it.
  assert.equal(findConfusablePatterns("Der stod en man ved døren.", "en").length, 0);
  assert.equal(findConfusablePatterns("He read the letter form the king.", "da").length, 0);
});

test("a language with no table returns nothing", () => {
  assert.deepEqual(findConfusablePatterns("Il lut la lettre form le roi.", "fr"), []);
});

test("an absent language is treated as English", () => {
  // queue.ts passes job.manuscriptLang, which can be undefined.
  assert.equal(findConfusablePatterns("He read the letter form the king.").length, 1);
});

test("every correction carries a reason the precision pass recognises", () => {
  const cs = findConfusablePatterns("He could of told me sooner.", "en");
  assert.equal(cs.length, 1);
  assert.ok(cs[0].reason?.startsWith("confusable:"));
});

test("repeated hits in one text are all reported", () => {
  const cs = findConfusablePatterns(
    "He read the letter form the king. The soldiers came form the north.",
    "en",
  );
  assert.equal(cs.length, 2);
});

test("the same span is never reported twice", () => {
  const cs = findConfusablePatterns("Its a long way and its a cold one.", "en");
  const keys = cs.map((c) => `${c.original}→${c.corrected}`);
  assert.equal(new Set(keys).size <= keys.length, true);
  for (const c of cs) assert.notEqual(c.original, c.corrected);
});
