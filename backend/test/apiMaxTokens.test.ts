// The External Betty API route caps max_tokens per call (the reviewer uses
// ~corrections×50+512). On DeepSeek, reasoning models spend that same budget
// on hidden chain-of-thought BEFORE emitting the visible answer, so a
// reviewer call against deepseek-reasoner came back truncated mid-line
// (finish_reason=length, 743/762 tokens spent reasoning) and every
// correction was flagged "not scored by reviewer". apiMaxTokens adds a
// reasoning budget on top of the requested cap for such models.

import { test } from "node:test";
import assert from "node:assert/strict";

import { apiMaxTokens } from "../src/llm.ts";

test("non-reasoning API model keeps the requested cap", () => {
  assert.equal(apiMaxTokens(762, "deepseek-chat"), 762);
});

test("reasoning model gets headroom for chain-of-thought", () => {
  // Reviewer cap for a 5-correction chunk; must leave room for the CoT.
  const cap = apiMaxTokens(762, "deepseek-reasoner");
  assert.ok(cap >= 762 + 16384, `cap ${cap} leaves too little CoT headroom`);
});

test("reasoning cap stays within DeepSeek's 65536 output limit", () => {
  assert.ok(apiMaxTokens(60000, "deepseek-reasoner") <= 65536);
});
