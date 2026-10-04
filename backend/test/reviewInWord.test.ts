// ── Review in Word: what goes into the document ──
//
// Pure, and tested from here because the frontend has no test runner.
//
// The rule pinned hardest: where two suggestions claim the same words, the
// later one wins, because Word can show only one revision in one place.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyLastWins,
  buildReviewExport,
  noteFor,
} from "../../frontend/src/reviewInWord.ts";

const S = {
  wouldAccept: "Betty would accept this",
  unsure: "Betty is unsure of this one",
  wouldLeave: "Betty would leave this",
  sure: "{pct}% sure",
  accepted: "You accepted this in Betty.",
};

const c = (original: string, corrected: string, extra: object = {}) => ({
  original,
  corrected,
  ...extra,
});

test("every suggestion is applied, at each place its words occur", () => {
  assert.equal(
    applyLastWins("He sudenly left. She sudenly stayed.", [c("sudenly", "suddenly")]),
    "He suddenly left. She suddenly stayed.",
  );
});

test("where two suggestions overlap, the later one wins", () => {
  const word = c("slow", "slowly");
  const sentence = c("walked slow to", "made her way to");
  assert.equal(applyLastWins("She walked slow to the door.", [word, sentence]), "She made her way to the door.");
  assert.equal(applyLastWins("She walked slow to the door.", [sentence, word]), "She walked slowly to the door.");
});

test("suggestions that do not overlap are all applied", () => {
  assert.equal(
    applyLastWins("the the cat sat on teh mat", [c("the the", "the"), c("teh", "the")]),
    "the cat sat on the mat",
  );
});

test("a word is not changed inside a longer word", () => {
  assert.equal(applyLastWins("The students and the student.", [c("the student", "a student")]), "The students and a student.");
});

test("a finding with no fix changes nothing", () => {
  assert.equal(applyLastWins("Odd sentence.", [c("Odd", "Odd")]), "Odd sentence.");
});

test("the comment says how sure Betty is and why", () => {
  assert.equal(
    noteFor(c("a", "b", { confidence: 5, reviewReason: "Common misspelling." }), false, S),
    // A top score reads 82%: the calibrated figure the deck card shows.
    "Betty would accept this (82% sure)\nCommon misspelling.",
  );
});

test("a suggestion the reviewer doubted says Betty would leave it", () => {
  const note = noteFor(c("a", "b", { confidence: 1, flagged: true }), false, S);
  assert.ok(note.startsWith("Betty would leave this"), note);
});

test("an accepted suggestion says so", () => {
  assert.ok(noteFor(c("a", "b", { confidence: 5 }), true, S).endsWith("You accepted this in Betty."));
});

test("the export carries one pair and one list of notes per chapter, in order", () => {
  const out = buildReviewExport(
    [
      { originalText: "He sudenly left.", items: [{ correction: c("sudenly", "suddenly", { confidence: 5 }), accepted: false }] },
      { originalText: "Nothing here.", items: [] },
    ],
    S,
  );
  assert.deepEqual(out.pairs, [
    { original: "He sudenly left.", edited: "He suddenly left." },
    { original: "Nothing here.", edited: "Nothing here." },
  ]);
  assert.equal(out.notes.length, 2);
  assert.equal(out.notes[0][0].original, "sudenly");
  assert.deepEqual(out.notes[1], []);
});
