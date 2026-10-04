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
  also: "Betty also suggested: {change}",
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

test("the comment gives the reason first, then how sure Betty is", () => {
  assert.equal(
    noteFor(c("a", "b", { confidence: 5, reviewReason: "Common misspelling." }), false, S),
    // A top score reads 82%: the calibrated figure the deck card shows.
    "Common misspelling.\nBetty would accept this (82% sure)",
  );
});

test("a suggestion the reviewer doubted says Betty would leave it, after the argument", () => {
  const note = noteFor(
    c("which made", "that made", {
      confidence: 1,
      flagged: true,
      reviewReason: "'That made' is standard grammar; this change is unnecessary.",
    }),
    false,
    S,
  );
  const [reason, verdict] = note.split("\n");
  assert.equal(reason, "'That made' is standard grammar; this change is unnecessary.");
  assert.ok(verdict.startsWith("Betty would leave this"), note);
});

test("with no reason, the comment is the verdict alone", () => {
  const note = noteFor(c("a", "b", { confidence: 1, flagged: true }), false, S);
  assert.ok(note.startsWith("Betty would leave this") && !note.includes("\n"), note);
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

// ── Overlaps are not lost ──

const S2 = S;

test("the winner's comment lists the suggestion it displaced", () => {
  const word = c("slow", "slowly", { id: "w", confidence: 5 });
  const sentence = c("walked slow to", "made her way to", { id: "s", confidence: 5 });
  const out = buildReviewExport(
    [{ originalText: "She walked slow to the door.", items: [{ correction: word, accepted: false }, { correction: sentence, accepted: false }] }],
    S2,
  );
  assert.equal(out.pairs[0].edited, "She made her way to the door.");
  const winner = out.notes[0][1].text;
  assert.ok(winner.endsWith("Betty also suggested: “slow” → “slowly”"), winner);
  // The displaced one's own note says nothing about the winner.
  assert.ok(!out.notes[0][0].text.includes("also suggested"));
});

test("along a chain of overlaps, the last winner lists every one it outlasted", () => {
  const a = c("slow", "slowly");
  const b = c("walked slow", "walked slowly");
  const d = c("She walked slow to", "She went to");
  const out = buildReviewExport(
    [{ originalText: "She walked slow to the door.", items: [a, b, d].map((x) => ({ correction: x, accepted: false })) }],
    S2,
  );
  const last = out.notes[0][2].text;
  assert.ok(last.includes("“walked slow” → “walked slowly”"), last);
  assert.ok(last.includes("“slow” → “slowly”"), last);
});

test("a suggestion displaced in one place still stands where it is alone", () => {
  // "slow" loses in the first sentence but is the only suggestion in the second.
  const word = c("slow", "slowly");
  const sentence = c("walked slow to", "made her way to");
  const out = buildReviewExport(
    [{ originalText: "She walked slow to it. He ran slow.", items: [word, sentence].map((x) => ({ correction: x, accepted: false })) }],
    S2,
  );
  assert.equal(out.pairs[0].edited, "She made her way to it. He ran slowly.");
});
