// Combined (copy + line) edits ask the model to label each correction with a
// "kind" so the review UI can separate copy edits from line edits. The parser
// captures that label as `editType`; single-mode prompts never request it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCorrectionsJson } from "../src/llm.ts";
import {
  buildCombinedEditPrompt,
  buildCopyEditCorrectionsPrompt,
} from "../src/prompts.ts";
import {
  DEFAULT_COPY_EDIT_OPTIONS,
  DEFAULT_LINE_EDIT_OPTIONS,
} from "../src/types.ts";

test("parseCorrectionsJson captures the kind label as editType", () => {
  const raw = [
    '{"original": "she ran quick", "corrected": "she ran quickly", "kind": "copy"}',
    '{"original": "at this moment in time", "corrected": "now", "kind": "line"}',
    '{"original": "teh cat", "corrected": "the cat"}',
  ].join("\n");
  const cs = parseCorrectionsJson(raw);
  assert.equal(cs.length, 3);
  assert.equal(cs[0].editType, "copy");
  assert.equal(cs[1].editType, "line");
  assert.equal(cs[2].editType, undefined, "unlabeled correction stays untyped");
});

test("combined prompt requests a kind label; single-mode prompts do not", () => {
  const combined = buildCombinedEditPrompt(
    DEFAULT_COPY_EDIT_OPTIONS,
    DEFAULT_LINE_EDIT_OPTIONS,
  );
  assert.ok(combined.includes('add a "kind" field'), "kind rule present");
  assert.ok(
    combined.includes('"original", "corrected", and "kind"'),
    "keys clause updated for combined",
  );

  const copy = buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS);
  assert.ok(!copy.includes('"kind"'), "copy prompt must not request a kind");
  assert.ok(
    copy.includes("exactly the two keys"),
    "copy prompt keeps the two-key contract",
  );
});
