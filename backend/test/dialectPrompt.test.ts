// The line editor must never change spelling (that's the copy editor's job).
// Without this, a combined copy+line pass Americanizes British spellings while
// "improving" prose, and the en_GB spell gate then drops those corrections as
// misspelled. These tests lock the prompt guidance in place.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildLineEditCorrectionsPrompt,
  buildLineEditRewritePrompt,
  buildCombinedEditPrompt,
} from "../src/prompts.ts";
import {
  DEFAULT_COPY_EDIT_OPTIONS,
  DEFAULT_LINE_EDIT_OPTIONS,
} from "../src/types.ts";

const NO_SPELLING = "Do NOT change spelling";

test("line-edit corrections prompt forbids spelling changes", () => {
  const p = buildLineEditCorrectionsPrompt(DEFAULT_LINE_EDIT_OPTIONS);
  assert.ok(p.includes(NO_SPELLING), "expected the no-spelling constraint");
});

test("line-edit rewrite prompt forbids spelling changes", () => {
  const p = buildLineEditRewritePrompt(DEFAULT_LINE_EDIT_OPTIONS);
  assert.ok(p.includes(NO_SPELLING), "expected the no-spelling constraint");
});

test("combined British: global dialect directive governs both passes", () => {
  const p = buildCombinedEditPrompt(
    { ...DEFAULT_COPY_EDIT_OPTIONS, englishDialect: "british" },
    DEFAULT_LINE_EDIT_OPTIONS,
  );
  assert.ok(
    p.includes("SPELLING DIALECT: This manuscript uses BRITISH English"),
    "expected the British spelling directive",
  );
  assert.ok(
    p.includes("Never change spelling while rephrasing"),
    "expected the line-section reinforcement",
  );
});

test("combined American: directive flips to American", () => {
  const p = buildCombinedEditPrompt(
    { ...DEFAULT_COPY_EDIT_OPTIONS, englishDialect: "american" },
    DEFAULT_LINE_EDIT_OPTIONS,
  );
  assert.ok(
    p.includes("SPELLING DIALECT: This manuscript uses AMERICAN English"),
    "expected the American spelling directive",
  );
});

test("combined with a non-English manuscript omits the dialect directive", () => {
  const p = buildCombinedEditPrompt(
    { ...DEFAULT_COPY_EDIT_OPTIONS, englishDialect: "british" },
    DEFAULT_LINE_EDIT_OPTIONS,
    undefined,
    undefined,
    "da",
  );
  assert.ok(
    !p.includes("SPELLING DIALECT"),
    "dialect directive should not apply to non-English manuscripts",
  );
});
