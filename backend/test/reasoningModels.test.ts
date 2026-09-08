// A reasoning model spends max_tokens on hidden chain-of-thought before it says
// anything visible, so it needs headroom on top of the requested output cap.
// Deciding that from the model's NAME missed Qwen3.5-9B, which reasons and is
// called none of "reason", "think" or "r1": served through OVHcloud it returned
// content: null with all 120 completion tokens in reasoning_content, which
// reached the pipeline as "0 content tokens" and cost a paid line-edit run every
// one of its LLM corrections.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  apiMaxTokens,
  noteReasoningModel,
  isKnownReasoningModel,
} from "../src/llm.ts";

test("a model named as a reasoner still gets headroom on the name alone", () => {
  assert.ok(apiMaxTokens(1000, "deepseek-reasoner") > 1000);
  assert.ok(apiMaxTokens(1000, "some-thinking-model") > 1000);
  assert.ok(apiMaxTokens(1000, "deepseek-r1") > 1000);
});

test("the r1 test is a whole word, not a substring", () => {
  // "war1ock" contains r1; it is not a reasoning model.
  assert.equal(apiMaxTokens(1000, "war1ock-7b"), 1000);
});

test("an unremarkable name gets no headroom until it is observed", () => {
  assert.equal(apiMaxTokens(1000, "Qwen3.5-9B-unseen"), 1000);
});

test("a model observed emitting chain-of-thought gets headroom by name", () => {
  const name = "Qwen3.5-9B-observed";
  assert.equal(apiMaxTokens(1000, name), 1000);
  noteReasoningModel(name);
  assert.ok(isKnownReasoningModel(name));
  assert.ok(apiMaxTokens(1000, name) > 1000, "the next call must get CoT room");
});

test("observation is also matched on the catalog key the pipeline calls it by", () => {
  // chatStream records the model key it was given (custom:bethaniel-cloud),
  // while the request carries the provider's own model name. Either identifies
  // the same model, so either must grant headroom.
  const key = "custom:bethaniel-cloud";
  noteReasoningModel(key);
  assert.ok(
    apiMaxTokens(1000, "Qwen3.5-9B", key) > 1000,
    "the entry id must count as observation too",
  );
});

test("headroom stays inside the provider output ceiling", () => {
  assert.equal(apiMaxTokens(60000, "deepseek-reasoner"), 65536);
});
