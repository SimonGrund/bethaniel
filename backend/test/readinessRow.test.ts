// ── How a publication blocker is written down ──
//
// The panel, the PDF and the Markdown report all describe a blocker, and they
// used to describe it three different ways. The panel's was wrong: it spliced
// the word diff into the author's sentence, so a comma-to-period swap came out
// as "Tobias said,." — the deletion and the insertion adjacent, in the middle
// of a passage that then looked mispunctuated. These are the functions all
// three now share, tested here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import { bracketedContext, sourceOf } from "../../frontend/src/readinessRow.ts";
import type { Correction } from "../../frontend/src/types.ts";

// The i18n keys, unresolved, so a test asserts on the key rather than on a
// translation that is free to change.
const t = (k: string) => k;

test("the span is bracketed inside the author's own sentence", () => {
  // Verbatim from the run that prompted this: the change is "said," → "said.",
  // and the context must show the comma the author typed, not the period.
  assert.equal(
    bracketedContext(
      "Tobias said,",
      "Tobias’s breathing was slow and uneven, and she became uncomfortably aware of her own heavy breaths.",
      "“This is the first time we’ve been alone for a very long time.”",
    ),
    "…Tobias’s breathing was slow and uneven, and she became uncomfortably " +
      "aware of her own heavy breaths. [Tobias said,] “This is the first time " +
      "we’ve been alone for a very long time.”…",
  );
});

test("no context on either side means no bracket at all", () => {
  // extractSentenceContext returns two empty strings when it could not place
  // the span. Bracketing anyway would point at words we did not find.
  assert.equal(bracketedContext("There’s", "", ""), undefined);
});

test("a span at the very start of a chapter keeps its one side", () => {
  assert.equal(
    bracketedContext("Teh", "", "morning came late."),
    "…[Teh] morning came late.…",
  );
  assert.equal(
    bracketedContext("the end", "And so came", ""),
    "…And so came [the end]…",
  );
});

test("line breaks in the passage collapse to single spaces", () => {
  // The context is one line in all three renderings; a paragraph break in the
  // manuscript must not become a gap in the middle of the row.
  assert.equal(
    bracketedContext("said,", "He stopped.\n\n  She waited.", "“Well?”"),
    "…He stopped. She waited. [said,] “Well?”…",
  );
});

const correction = (over: Partial<Correction>): Correction =>
  ({ original: "a", corrected: "b", ...over }) as Correction;

// `confidence` is the reviewer's 1-5 score, not a percentage — 5 reads as 82%.
test("a finding names the checker that made it", () => {
  assert.equal(
    sourceOf(correction({ reason: "spell-check", confidence: 5 }), t),
    "rr_src_dictionary · 82%",
  );
  assert.equal(
    sourceOf(correction({ reason: "grammar:UPPERCASE_SENTENCE_START", confidence: 4 }), t),
    "rr_src_grammar · UPPERCASE SENTENCE START · 70%",
  );
  assert.equal(
    sourceOf(correction({ reason: "retext:doubled-word", confidence: 4 }), t),
    "rr_src_text · doubled word · 70%",
  );
});

test("anything else is Betty's own reading", () => {
  // "Betty · 82%" — the row from the report the panel now mirrors.
  assert.equal(
    sourceOf(correction({ reason: "punctuation", confidence: 5 }), t),
    "rr_src_betty · 82%",
  );
});

test("an unreviewed correction says so instead of showing a score", () => {
  // A percentage no reviewer produced would be a number the reader trusts for
  // no reason.
  const out = sourceOf(correction({ reason: "punctuation" }), t);
  assert.ok(!out.includes("%"), `expected no percentage, got ${out}`);
});
