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

// ── Comma guardrails ──
//
// Benchmarking the cloud model (Qwen3.5-397B) on already-clean prose produced
// 39 false positives, every one a comma inserted where none belongs:
// "a long, jagged, shore", "formidable, and private", "cliffs, and, quiet
// coves". The comma rules told the model what a missing comma looks like and
// the PUNCTUATION RECALL block told it to flag those patterns even when the
// sentence reads fine — with nothing anywhere saying what the pattern is NOT.
// The local models never tripped on this, so nothing caught it. These assert
// the boundaries survive future edits to the prompt.

const ADJECTIVE_NOUN_GUARD = "NEVER put a comma between the LAST adjective and the noun itself";
const CLAUSE_GUARD = 'NEVER put a comma before "and" when it joins two adjectives';
const OXFORD_GUARD = "This rule can only ever ADD one comma to a list.";
// Two rounds of benchmarking to arrive at this phrasing. Naming only the
// "extra comma" direction made the model delete separators from correct lists
// instead; naming the deletion direction with a concrete broken example
// ("salt tar, and smoke is wrong") made it emit that exact string. The
// invariant — a list correction may only ADD — carries both directions
// without printing a broken form for the model to copy.
const OXFORD_DELETION_GUARD = "keep all of them, exactly where they are";
const RECALL_BOUNDARY = "These three patterns are the ONLY commas this directive licenses.";

test("the comma rules say where a comma does NOT go, not only where it does", () => {
  const p = buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS);
  assert.ok(p.includes(ADJECTIVE_NOUN_GUARD), "no adjective/noun boundary guard");
  assert.ok(p.includes(CLAUSE_GUARD), "no adjectives-vs-clauses guard");
  assert.ok(p.includes(OXFORD_GUARD), "no comma-after-'and' guard");
  assert.ok(p.includes(OXFORD_DELETION_GUARD), "no comma-deletion guard");
});

test("the high-recall punctuation push is bounded by what the patterns are not", () => {
  const p = buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS);
  // The block overrides "when in doubt, leave it alone", so it is the one
  // place a counter-example is load-bearing rather than decorative.
  assert.ok(p.includes("PUNCTUATION RECALL"), "expected the recall block");
  assert.ok(p.includes(RECALL_BOUNDARY), "recall block has no boundary");
});

test("the Oxford rule places the comma before the conjunction, and leaves finished lists alone", () => {
  const p = buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS);
  assert.ok(p.includes('immediately BEFORE the final "and"/"or"'));
  assert.ok(p.includes("fewer commas than the original"));
});

test("none of the English comma guardrails leak into a non-English manuscript", () => {
  const p = buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS, undefined, undefined, "da");
  for (const guard of [ADJECTIVE_NOUN_GUARD, CLAUSE_GUARD, OXFORD_GUARD, RECALL_BOUNDARY]) {
    assert.ok(!p.includes(guard), `English-only guidance leaked: ${guard}`);
  }
});

test("combined edit places the Oxford comma too — it is the mode most runs use", () => {
  const p = buildCombinedEditPrompt(DEFAULT_COPY_EDIT_OPTIONS, DEFAULT_LINE_EDIT_OPTIONS);
  assert.ok(p.includes('immediately BEFORE the final "and"/"or"'));
  assert.ok(p.includes("keep every comma the list already has"));
});
