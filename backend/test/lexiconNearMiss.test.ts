// A coinage one edit from a dictionary word the book uses far more often is
// a repeated typo, not a word.
//
// The lexicon already had this idea for NAMES — "Silverhnad beside forty
// Silverhands is the typo the author wants caught" — but a typo of an
// ordinary dictionary word was not covered, and that is the one the author
// makes: a find-and-replace slip, or a habitual misspelling.

import { test } from "node:test";
import assert from "node:assert/strict";

import { initSpellchecker } from "../src/spellcheck.ts";
import { isWordAnywhere } from "../src/wordKnowledge.ts";
import { harvestLexicon } from "../src/lexicon.ts";

function book(opts: { typo?: [string, number]; coinage?: [string, number] }): string {
  const common = Array.from(
    { length: 400 },
    (_, i) => `She went with him through the ${i} halls that evening.`,
  ).join(" ");
  const typo = opts.typo
    ? Array.from({ length: opts.typo[1] }, () => `He went ${opts.typo![0]} her.`).join(" ")
    : "";
  const coin = opts.coinage
    ? Array.from({ length: opts.coinage[1] }, () => `He raised the ${opts.coinage![0]} high.`).join(" ")
    : "";
  return `${common} ${typo} ${coin} ${common}`;
}

const lex = async (md: string) => {
  await initSpellchecker();
  return harvestLexicon(md, {
    lang: "en",
    isWord: isWordAnywhere("en", "american")!,
  });
};

test("a repeated typo of a common word is a near-miss, not a coinage", async () => {
  // "woth" x8 against "with" x800.
  const l = await lex(book({ typo: ["woth", 8] }));
  assert.equal(
    l.terms.some((t) => t.term.toLowerCase() === "woth"),
    false,
    "must not be protected as the author's word",
  );
  assert.equal(
    l.nearMisses.some((n) => n.term.toLowerCase() === "woth"),
    true,
    "must be reported as a near-miss of 'with'",
  );
});

test("the near-miss names the word it is one edit from", async () => {
  const l = await lex(book({ typo: ["woth", 8] }));
  const n = l.nearMisses.find((x) => x.term.toLowerCase() === "woth");
  assert.equal(n?.of.toLowerCase(), "with");
});

test("a genuine coinage is left alone", async () => {
  // "warhammer" is nothing's near-miss.
  const l = await lex(book({ coinage: ["warhammer", 8] }));
  assert.equal(
    l.terms.some((t) => t.term.toLowerCase() === "warhammer"),
    true,
  );
  assert.equal(
    l.nearMisses.some((n) => n.term.toLowerCase() === "warhammer"),
    false,
  );
});

test("a coinage one edit from a RARE word is still a coinage", async () => {
  // The ratio is what decides. "blackwood" is one edit from nothing frequent.
  const l = await lex(book({ coinage: ["blackwood", 8] }));
  assert.equal(
    l.terms.some((t) => t.term.toLowerCase() === "blackwood"),
    true,
  );
});
