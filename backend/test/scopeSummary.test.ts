// ── The one line the collapsed Scope row shows ──
//
// Scope used to sit open on the manuscript column at full height — three
// radios, a chapter list and a word box — beside the settings that actually
// need an answer. Collapsed, it has to say in one line what it would have
// shown, or folding it just hides the job's shape.
//
// Pure and tested from here, the frontend having no runner of its own; the
// same arrangement as codeBalanceNote.

import { test } from "node:test";
import assert from "node:assert/strict";

import { scopeSummary } from "../../frontend/src/scopeSummary.ts";

const strings = {
  whole_book: "Whole book",
  selected_chapters: "Selected chapters",
  first_n_words: "First words",
  lbl_words: "words",
  lbl_chapter: "chapter",
  lbl_chapters: "chapters",
};
const t = (key: string) => strings[key as keyof typeof strings] ?? key;

test("the whole book says so, with its size", () => {
  assert.equal(
    scopeSummary(t, { scopeMode: "whole_book", unitCount: 32, totalWords: 80717 }),
    "Whole book · 80,717 words · 32 chapters",
  );
});

test("a selection counts what was selected, not what exists", () => {
  assert.equal(
    scopeSummary(t, { scopeMode: "selected_chapters", unitCount: 3, totalWords: 9120 }),
    "Selected chapters · 9,120 words · 3 chapters",
  );
});

test("one chapter is a chapter, not 1 chapters", () => {
  const out = scopeSummary(t, {
    scopeMode: "selected_chapters",
    unitCount: 1,
    totalWords: 2480,
  });
  // Checked on the count itself, not the whole line: the scope's own label
  // ("Selected chapters") legitimately carries the plural.
  assert.equal(out.split(" · ").pop(), "1 chapter");
});

test("a manuscript with no chapters detected counts words only", () => {
  // buildUnits falls back to one synthetic "Manuscript" unit, and calling
  // that "1 chapter" would be a claim about the book that is not true.
  assert.equal(
    scopeSummary(t, {
      scopeMode: "whole_book",
      unitCount: 1,
      totalWords: 19710,
      chaptersDetected: false,
    }),
    "Whole book · 19,710 words",
  );
});

test("a first-N-words scope is words, whatever it landed on", () => {
  // The cut is by word count, so the chapter tally it happens to produce is
  // noise — the author asked for a number of words.
  assert.equal(
    scopeSummary(t, { scopeMode: "first_n_words", unitCount: 2, totalWords: 5000 }),
    "First words · 5,000 words",
  );
});

test("an empty selection says nothing was selected rather than 0 chapters", () => {
  assert.equal(
    scopeSummary(t, { scopeMode: "selected_chapters", unitCount: 0, totalWords: 0 }),
    "Selected chapters",
  );
});
