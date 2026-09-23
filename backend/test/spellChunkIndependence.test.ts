// The spell layer must not care where the chunk boundaries fell.
//
// collectMidSentenceCapitals protects a capitalised word appearing
// mid-sentence in THE TEXT IT IS HANDED, and queue.ts hands it one ~2,500
// word chunk. A name that happens to sit only at sentence starts inside one
// chunk is unprotected there and protected next door. Chunk boundaries move
// when the text changes — and it changes between runs, because the author
// accepted the last run's corrections — so a second run surfaced findings the
// first did not, from code with no randomness in it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initSpellchecker,
  getSpellCorrections,
  collectMidSentenceCapitals,
} from "../src/spellcheck.ts";
import { splitIntoChunks } from "../src/chunking.ts";

// "Vashti" opens every sentence it appears in near the top, and appears
// mid-sentence only much later — so a chunk cut between the two sees an
// unprotected name.
const HEAD = Array.from(
  { length: 40 },
  (_, i) => `Vashti walked on through the ${i} quiet halls of the keep.`,
).join("\n\n");
const TAIL = Array.from(
  { length: 40 },
  (_, i) => `The captain greeted Vashti warmly on the ${i} morning of the voyage.`,
).join("\n\n");
const BOOK = `${HEAD}\n\n${TAIL}`;

function chunkedFindings(words: number): string[] {
  const names = collectMidSentenceCapitals(BOOK, "en");
  const out: string[] = [];
  for (const ch of splitIntoChunks(BOOK, words, 1)) {
    for (const c of getSpellCorrections(
      (ch as unknown as { body: string }).body,
      "en_US",
      { protectedNames: names },
    )) {
      out.push(c.original.trim());
    }
  }
  return [...new Set(out)].sort();
}

test("the same text yields the same findings at any chunk size", async () => {
  await initSpellchecker();
  const a = chunkedFindings(1500);
  const b = chunkedFindings(2500);
  const c = chunkedFindings(5000);
  assert.deepEqual(a, b, "1500 vs 2500");
  assert.deepEqual(b, c, "2500 vs 5000");
});

test("a name seen mid-sentence anywhere in the book is protected everywhere", async () => {
  await initSpellchecker();
  assert.equal(
    chunkedFindings(1500).includes("Vashti"),
    false,
    "Vashti appears mid-sentence later in the book",
  );
});

test("the manuscript-wide set is what makes that true", async () => {
  await initSpellchecker();
  const names = collectMidSentenceCapitals(BOOK, "en");
  assert.equal(names.has("vashti"), true);
  // The head alone never shows it mid-sentence.
  assert.equal(collectMidSentenceCapitals(HEAD, "en").has("vashti"), false);
});
