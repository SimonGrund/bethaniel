// ── Two shapes of suggestion that are never right ──
//
// A capital taken off a sentence's first word, and "no dictionary knows
// this" for a word the book uses again and again. Measured on a real novel
// (noiseGates.ts); these hold the line.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  dropRecurringUnknowns,
  dropSentenceStartLowercasing,
  lowercasesSentenceStart,
  recurringUnknownWords,
} from "../src/noiseGates.ts";

const text =
  "The ship was gone. We waited by the shore. “And then?” she asked. " +
  "He said, “And then nothing.” They met the King at noon.";

test("a capital taken off a sentence's first word is dropped", () => {
  assert.equal(lowercasesSentenceStart({ original: "We waited", corrected: "we waited" }, text), true);
  assert.equal(lowercasesSentenceStart({ original: "The ship", corrected: "the ship" }, text), true);
  // Inside an opening quote, still the start of a sentence.
  assert.equal(lowercasesSentenceStart({ original: "“And then?”", corrected: "“and then?”" }, text), true);
  // A rewrite that also lowercases its first word.
  assert.equal(
    lowercasesSentenceStart({ original: "We waited by", corrected: "we stood by the" }, text),
    true,
  );
});

test("lowercasing mid-sentence, or any other change, is left to the reviewer", () => {
  // After "He said," the quote continues the sentence.
  assert.equal(lowercasesSentenceStart({ original: "said, “And then", corrected: "said, “and then" }, text), false);
  assert.equal(lowercasesSentenceStart({ original: "the King at", corrected: "the king at" }, text), false);
  assert.equal(lowercasesSentenceStart({ original: "We waited", corrected: "We stood" }, text), false);
  // Not in the text: nothing to judge.
  assert.equal(lowercasesSentenceStart({ original: "Nowhere", corrected: "nowhere" }, text), false);
  const { kept, dropped } = dropSentenceStartLowercasing(
    [
      { original: "We waited", corrected: "we waited" },
      { original: "the King at", corrected: "the king at" },
    ],
    text,
  );
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].why, /start of a sentence/);
});

test("the unknown words a book uses three times or more", () => {
  const known = new Set(["the", "arena", "was", "full", "aaron", "Aaron", "it"]);
  const isWord = (w: string) => known.has(w);
  const words = recurringUnknownWords(
    ["The colosseum was full. The colosseum, the Colosseum.", "Aaron, Aaron, Aaron. Outsail it, outsail."],
    isWord,
  );
  assert.deepEqual(words, ["colosseum"], "three uses in any casing; two is not enough; Aaron is a word");
  assert.deepEqual(recurringUnknownWords(["x x x"], null), [], "no dictionary, nothing to say");
});

test("only the no-guess finding is withheld for them, never a fix", () => {
  const recurring = new Set(["colosseum"]);
  const { kept, dropped } = dropRecurringUnknowns(
    [
      { original: "colosseum", corrected: "colosseum", reason: "spell-check-unknown" },
      { original: "Colosseum,", corrected: "Colosseum,", reason: "spell-check-unknown" },
      { original: "colosseum", corrected: "coliseum", reason: "spell-check" },
      { original: "outsail", corrected: "outsail", reason: "spell-check-unknown" },
    ],
    recurring,
  );
  assert.equal(dropped.length, 2);
  assert.deepEqual(
    kept.map((c) => c.corrected),
    ["coliseum", "outsail"],
  );
});

test("a spelling guess on the book's own recurring word is dropped when it cannot be a repeated typo", () => {
  const recurring = new Set(["blackskull", "tua’na", "darkwood", "definately"]);
  const { kept, dropped } = dropRecurringUnknowns(
    [
      // A name: capitalised.
      { original: "of Blackskull,", corrected: "of Black skull,", reason: "grammar:typos" },
      { original: "Tua’na has", corrected: "Tua’NBA has", reason: "grammar:typos" },
      // Only split.
      { original: "darkwood facades", corrected: "dark wood facades", reason: "grammar:typos" },
      // A lowercase word written wrongly three times keeps its guess.
      { original: "definately", corrected: "definitely", reason: "spell-check" },
      // A pre-approved fix is the author's or confirmed twice.
      { original: "Blackskull", corrected: "Black skull", reason: "spell-check", preApproved: true },
      // Not a spelling source.
      { original: "Blackskull", corrected: "Black skull", reason: "copy" },
    ],
    recurring,
  );
  assert.equal(dropped.length, 3);
  assert.deepEqual(
    kept.map((c) => c.corrected),
    ["definitely", "Black skull", "Black skull"],
  );
});
