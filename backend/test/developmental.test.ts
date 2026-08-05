// The developmental review is a manuscript-level critique (structure, pacing,
// arcs, plot, POV) synthesized from the story read — a Markdown report, never
// the JSONL corrections contract.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEVELOPMENTAL_REVIEW_PROMPT } from "../src/prompts.ts";

test("developmental prompt targets manuscript-level concerns", () => {
  const p = DEVELOPMENTAL_REVIEW_PROMPT;
  assert.ok(p.includes("## Structure & shape"));
  assert.ok(p.includes("## Pacing"));
  assert.ok(p.includes("## Character arcs"));
  assert.ok(p.includes("## Plot & continuity"));
  assert.ok(p.includes("## Priority revisions"));
});

test("developmental prompt is a Markdown report, not JSONL corrections", () => {
  const p = DEVELOPMENTAL_REVIEW_PROMPT;
  assert.ok(p.includes("Output Markdown only"));
  assert.ok(!p.includes("JSONL"));
  assert.ok(!p.includes('"original"'));
});
