// A typo made three times used to disappear.
//
// harvestLexicon collects lowercase non-dictionary words occurring at least
// DEFAULT_MIN_COUNT times as the author's coinages, and gateProtectedTerms
// then removes any correction touching one. Hunspell flagged the typo every
// time; the gate deleted it. A typo repeated three times is not rarer than a
// coinage — it is a find-and-replace slip, a habitual misspelling, or a
// character's name consistently misspelled, which are the errors most worth
// catching.

import { test } from "node:test";
import assert from "node:assert/strict";

import { initSpellchecker } from "../src/spellcheck.ts";
import { isWordAnywhere } from "../src/wordKnowledge.ts";
import { harvestLexicon } from "../src/lexicon.ts";

function bookWith(word: string, times: number): string {
  const filler = Array.from(
    { length: 60 },
    (_, i) => `This is ordinary sentence number ${i} of the manuscript.`,
  ).join(" ");
  return `${filler} ${Array.from({ length: times }, () => `The ${word} was there.`).join(" ")} ${filler}`;
}

test("a coinage used three times is no longer protected", async () => {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const lex = harvestLexicon(bookWith("woth", 3), { lang: "en", isWord });
  assert.equal(
    lex.terms.some((t) => t.term.toLowerCase() === "woth"),
    false,
    "three occurrences is not enough to call it the author's word",
  );
});

test("a coinage used five times still is", async () => {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const lex = harvestLexicon(bookWith("warhammer", 5), { lang: "en", isWord });
  assert.equal(
    lex.terms.some((t) => t.term.toLowerCase() === "warhammer"),
    true,
  );
});

test("an explicit minCount still overrides the default", async () => {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const lex = harvestLexicon(bookWith("woth", 3), {
    lang: "en",
    isWord,
    minCount: 3,
  });
  assert.equal(
    lex.terms.some((t) => t.term.toLowerCase() === "woth"),
    true,
  );
});
