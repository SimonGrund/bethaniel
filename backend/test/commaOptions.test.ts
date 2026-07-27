// The introductory-comma toggle mirrors the Oxford-comma option: OFF (default)
// tells the editor to leave the author's punctuation after introductory words
// alone ("Finally she turned"); ON enforces the missing comma. It governs the
// LLM prompts (corrections + rewrite). LanguageTool is handled separately.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCopyEditCorrectionsPrompt,
  buildCombinedEditPrompt,
  buildCopyEditRewritePrompt,
} from "../src/prompts.ts";
import {
  DEFAULT_COPY_EDIT_OPTIONS,
  DEFAULT_LINE_EDIT_OPTIONS,
} from "../src/types.ts";

const SUPPRESS = "do NOT add a comma after an introductory";
const ENFORCE = "Missing comma after an introductory";

test("default (introductoryComma off) suppresses introductory commas in the corrections prompt", () => {
  const p = buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS);
  assert.ok(p.includes(SUPPRESS), "expected suppression instruction");
  assert.ok(!p.includes(ENFORCE), "must not also enforce");
});

test("introductoryComma on enforces the introductory comma instead", () => {
  const p = buildCopyEditCorrectionsPrompt({
    ...DEFAULT_COPY_EDIT_OPTIONS,
    introductoryComma: true,
  });
  assert.ok(p.includes(ENFORCE), "expected enforcement instruction");
  assert.ok(!p.includes(SUPPRESS), "must not also suppress");
});

test("combined-edit prompt honors the off default (suppress)", () => {
  const p = buildCombinedEditPrompt(DEFAULT_COPY_EDIT_OPTIONS, DEFAULT_LINE_EDIT_OPTIONS);
  assert.ok(p.includes(SUPPRESS));
});

test("rewrite prompt honors the off default (suppress)", () => {
  const p = buildCopyEditRewritePrompt(DEFAULT_COPY_EDIT_OPTIONS);
  assert.ok(p.includes(SUPPRESS));
});
