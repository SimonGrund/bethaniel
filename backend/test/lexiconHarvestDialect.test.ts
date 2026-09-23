// The harvest and the speller must ask one question. This pins the half of
// that contract that lives in the harvest: a word either English knows is not
// a coinage, whichever dialect the manuscript declares.

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
  return `${filler} ${Array.from({ length: times }, () => `Then ${word} spoke again.`).join(" ")} ${filler}`;
}

test("a word only en_GB knows is not harvested as a coinage", async () => {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const lex = harvestLexicon(bookWith("Tobias", 12), { lang: "en", isWord });
  assert.equal(
    lex.terms.some((t) => t.term === "Tobias"),
    false,
    "en_GB knows Tobias, so it is not the author's coinage",
  );
});

test("a word neither English knows still is", async () => {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const lex = harvestLexicon(bookWith("Ricko", 12), { lang: "en", isWord });
  assert.equal(
    lex.terms.some((t) => t.term === "Ricko"),
    true,
  );
});
