// Seven planted errors in stress100 were missed by every layer and every
// model tested — the two local GGUFs, all five OVHcloud candidates, and
// LanguageTool at picky level. All seven are confusable-word pairs, invisible
// to a dictionary because both members are real words. These tests pin the
// detection side; whether the model then picks the right member is a
// benchmark question, not a unit-test one.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findConfusables, CONFUSABLE_SETS } from "../src/confusables.ts";
import { buildConfusableHintBlock } from "../src/prompts.ts";

const setFor = (word: string) =>
  CONFUSABLE_SETS.find((s) => s.includes(word));

test("every pair the whole stack missed on stress100 is covered", () => {
  for (const [a, b] of [
    ["than", "then"],
    ["weather", "whether"],
    ["write", "right"],
    ["allowed", "aloud"],
    ["past", "passed"],
    ["quiet", "quite"],
    ["their", "there"],
  ]) {
    const set = setFor(a);
    assert.ok(set, `no set contains "${a}"`);
    assert.ok(set!.includes(b), `"${a}" and "${b}" must share a set`);
  }
});

test("a set is reported when any one member appears", () => {
  const sets = findConfusables("She spread their across the table.", "en");
  assert.ok(sets.some((s) => s.includes("there")));
});

test("sets absent from the text are not reported", () => {
  const sets = findConfusables("She spread their across the table.", "en");
  assert.ok(!sets.some((s) => s.includes("stationery")));
});

test("curly apostrophes match the same set as straight ones", () => {
  // Manuscripts are full of these; "it’s" must not read as a different word.
  const curly = findConfusables("It’s gone.", "en");
  assert.ok(curly.some((s) => s.includes("it's")), "curly apostrophe missed");
});

test("matching is whole-word, not substring", () => {
  // "theirs" and "therefore" contain set members but are not them.
  const sets = findConfusables("Theirs, therefore, remained.", "en");
  assert.ok(!sets.some((s) => s.includes("their")));
});

test("non-English manuscripts get nothing — the sets are English words", () => {
  // "to" and "so" occur in Danish and German too, and English advice about
  // them would be noise at best.
  assert.equal(findConfusables("Det var to sole over byen.", "da").length, 0);
  assert.equal(findConfusables("Er ist zu weit past.", "de").length, 0);
});

test("the number of sets is bounded so the prompt cannot grow without limit", () => {
  const everyWord = CONFUSABLE_SETS.flatMap((s) => [...s]).join(" ");
  assert.equal(findConfusables(everyWord, "en", { maxSets: 5 }).length, 5);
  assert.ok(findConfusables(everyWord, "en").length <= 40);
});

test("the most-confused sets survive the cap", () => {
  const everyWord = CONFUSABLE_SETS.flatMap((s) => [...s]).join(" ");
  const capped = findConfusables(everyWord, "en", { maxSets: 3 });
  assert.ok(capped[0].includes("their"), "their/there/they're must not be dropped");
});

test("the hint block tells the model that appearing on the list is not a reason to edit", () => {
  const block = buildConfusableHintBlock([["their", "there", "they're"]]);
  assert.match(block, /their \/ there \/ they're/);
  // Without this the block is an invitation to rewrite correct prose — the
  // exact failure the comma rules produced.
  assert.match(block, /not itself a reason to change a word/);
  assert.match(block, /Most occurrences are already correct/);
});

test("an empty list produces no block at all", () => {
  assert.equal(buildConfusableHintBlock([]), "");
});
