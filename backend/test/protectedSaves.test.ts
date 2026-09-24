// ── What the names & terms list kept out of the review ──
//
// 1,180 of 1,288 set-aside corrections on real runs were this: the lexicon
// refusing to let the spell-checker split the author's own coinages. The list
// itself was shown collapsed as "N skipped", read as work that got dropped,
// and could not be accepted or acted on. This is what replaced it — one
// sentence, and the count behind it.
//
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  protectedSaves,
  protectedSavesAcross,
} from "../../frontend/src/protectedSaves.ts";

const save = (protectedTerm: string) => ({ protectedTerm });

test("counts the suggestions that were never raised", () => {
  const out = protectedSaves([save("Worldsea"), save("Worldsea"), save("Akamu")]);
  assert.equal(out.count, 3);
});

test("the busiest term comes first", () => {
  // The sentence names three, so the three that did the most work are the
  // three worth naming.
  const out = protectedSaves([
    save("Akamu"),
    save("Blacksteel"),
    save("Blacksteel"),
    save("Blacksteel"),
    save("Worldsea"),
    save("Worldsea"),
  ]);
  assert.deepEqual(out.terms, ["Blacksteel", "Worldsea", "Akamu"]);
});

test("a tie is broken by name, not by chance", () => {
  // Otherwise the sentence reshuffles itself between renders of the same run.
  const out = protectedSaves([save("Roak"), save("Kindra"), save("Tua")]);
  assert.deepEqual(out.terms, ["Kindra", "Roak", "Tua"]);
});

test("only the lexicon's own saves count", () => {
  // The set-aside list holds four other kinds — duplicates of an applied
  // edit, typography, safety vetoes, wording not in the manuscript. None is
  // this, and counting them would overstate what the author's list did.
  const out = protectedSaves([
    { protectedTerm: "Worldsea" },
    { protectedTerm: undefined },
    {},
  ]);
  assert.equal(out.count, 1);
  assert.deepEqual(out.terms, ["Worldsea"]);
});

test("nothing protected says nothing", () => {
  // The sentence is not drawn at all on a run with no saves, so zero has to
  // be distinguishable rather than rendered as "prevented 0 suggestions".
  assert.deepEqual(protectedSaves([]), { count: 0, terms: [] });
  assert.deepEqual(protectedSaves([{}, {}]), { count: 0, terms: [] });
});

test("summed across a job's chapters", () => {
  // One line for the whole run, not one per chapter: the list is the book's.
  const out = protectedSavesAcross([
    { skipped: [save("Worldsea"), save("Akamu")] },
    { skipped: [save("Worldsea")] },
    { skipped: [] },
    undefined,
    null,
    {},
  ]);
  assert.equal(out.count, 3);
  assert.deepEqual(out.terms, ["Worldsea", "Akamu"]);
});

test("a run from before the field still counts", () => {
  // Runs already on disk carry only the English prose in `reason`. An author
  // looking at yesterday's work should not be told their list did nothing.
  const out = protectedSaves([
    { reason: 'left alone: "Worldsea" is in your names & terms' },
    { reason: 'left alone: "Worldsea" is in your names & terms' },
    { reason: 'left alone: "Blacksteel" is in your names & terms' },
  ]);
  assert.equal(out.count, 3);
  assert.deepEqual(out.terms, ["Worldsea", "Blacksteel"]);
});

test("the other set-aside reasons are not mistaken for saves", () => {
  // The legacy read is a whole-string match, not a substring hunt: the four
  // other kinds must not be counted as the author's list doing work.
  for (const reason of [
    "merged into an overlapping rewrite",
    "overlaps a larger applied edit",
    "typography-only change (quote/dash style)",
    "introduces misspelled word: Tobias's",
    "not found",
  ]) {
    assert.deepEqual(protectedSaves([{ reason }]), { count: 0, terms: [] }, reason);
  }
});

test("the structured field wins over the prose", () => {
  const out = protectedSaves([
    {
      protectedTerm: "Akamu",
      reason: 'left alone: "Worldsea" is in your names & terms',
    },
  ]);
  assert.deepEqual(out.terms, ["Akamu"]);
});
