// The precision pass is a second, narrower audit of proposed corrections —
// see prompts.ts's buildPrecisionPassPrompt and reviewResilience.ts's
// applyPrecisionPass. Its output format is deliberately identical to the
// main reviewer's (index/confidence/reason JSONL) so it reuses
// parseReviewScores unchanged; these tests confirm that contract holds and
// that the prompt actually asks the narrower question it's meant to.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPrecisionPassPrompt } from "../src/prompts.ts";
import { parseReviewScores } from "../src/llm.ts";

test("buildPrecisionPassPrompt asks whether a fix was needed, not whether it's well-formed", () => {
  const p = buildPrecisionPassPrompt();
  assert.match(p, /original text actually needed fixing at all/i);
  assert.match(p, /unforced rewording/i);
  assert.match(p, /unwanted punctuation/i);
  assert.match(p, /wording change/i);
  assert.match(p, /not.*your job|not re-score/i);
});

test("buildPrecisionPassPrompt's output format is parseable by the shared review-score parser", () => {
  const p = buildPrecisionPassPrompt();
  const jsonlLine = /\{"index":\s*\d+,\s*"confidence":\s*\d,\s*"reason":\s*"[^"]+"\}/;
  assert.match(p, jsonlLine, "prompt must demonstrate the exact JSONL shape parseReviewScores expects");

  const sampleOutput = [
    '{"index": 0, "confidence": 5, "reason": "Original had a real typo"}',
    '{"index": 1, "confidence": 1, "reason": "Original was already correct"}',
  ].join("\n");
  const scores = parseReviewScores(sampleOutput);
  assert.equal(scores.get(0)?.confidence, 5);
  assert.equal(scores.get(1)?.confidence, 1);
});

test("buildPrecisionPassPrompt includes the manuscript language block when given one", () => {
  const p = buildPrecisionPassPrompt(undefined, "da");
  assert.match(p, /MANUSCRIPT LANGUAGE: Danish/);
});

test("buildPrecisionPassPrompt includes the style guide when given one", () => {
  const p = buildPrecisionPassPrompt("Character names: Wren, Constance.");
  assert.match(p, /Wren, Constance/);
});
