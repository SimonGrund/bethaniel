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

test("a non-English manuscript never gets the English sets", () => {
  // "to" and "past" occur in Danish and German too, and English advice about
  // them would be noise at best. This was previously enforced by returning
  // nothing at all for non-English; now each language has its own table, so
  // the guarantee is that the ENGLISH words never leak across.
  const da = findConfusables("Det var to sole over byen.", "da");
  const de = findConfusables("Er ist zu weit past.", "de");
  for (const sets of [da, de]) {
    assert.ok(!sets.some((s) => s.includes("past")), "English set leaked");
    assert.ok(!sets.some((s) => s.includes("too")), "English set leaked");
  }
});

test("each language gets its own confusable sets", () => {
  // The gap this closed: wrong-word recall was 12% in Danish against 53% in
  // English, because nothing looked for nogen/nogle at all.
  const da = findConfusables("Der var nogen der kom, og han gik ad trappen.", "da");
  assert.ok(da.some((s) => s.includes("nogen") && s.includes("nogle")));
  assert.ok(da.some((s) => s.includes("ad") && s.includes("af")));

  const de = findConfusables("Er sagte, das er seit gestern hier war.", "de");
  assert.ok(de.some((s) => s.includes("das") && s.includes("dass")));
  assert.ok(de.some((s) => s.includes("seit") && s.includes("seid")));

  const es = findConfusables("No se si el vino, mas tarde lo veremos.", "es");
  assert.ok(es.some((s) => s.includes("si") && s.includes("sí")));
  assert.ok(es.some((s) => s.includes("mas") && s.includes("más")));
});

test("a language with no table returns nothing rather than English advice", () => {
  assert.deepEqual(findConfusables("Þetta er íslenskur texti.", "is"), []);
});

test("regional tags resolve to their base language", () => {
  // manuscriptLang arrives as "da" here but "en_US"/"en-GB" elsewhere.
  assert.ok(findConfusables("han gik ad trappen", "da-DK").length > 0);
  assert.ok(findConfusables("their coat", "en_US").length > 0);
  assert.ok(findConfusables("their coat", "en-GB").length > 0);
});

test("a multi-word member is matched on its first token", () => {
  // "a ver" / "si no" cannot be found by whole-token lookup; noticing "a" or
  // "si" is enough, because the editor agent reads the sentence anyway.
  const es = findConfusables("Vamos a ver que pasa.", "es");
  assert.ok(es.some((s) => s.includes("a ver")));
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
