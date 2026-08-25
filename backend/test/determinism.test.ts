// Tests for the reproducible-sampling changes: deriveSeed (a stable,
// content-based seed so re-running the same job samples the same corrections
// per chunk instead of a fresh roll every time) and buildLocalChatBody
// (confirms the seed and forced temperature actually reach the request body
// llama-server sees).

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveSeed, buildLocalChatBody } from "../src/llm.ts";
import type { ModelSettings } from "../src/modelConfig.ts";

const CFG: ModelSettings = {
  system: "",
  num_ctx: 8192,
  num_predict: 4096,
  temperature: 0.1,
  top_p: 0.8,
  top_k: 20,
  repeat_penalty: 1.05,
  no_mmap: false,
};

// ── deriveSeed ──

test("deriveSeed: identical inputs always produce the same seed", () => {
  const a = deriveSeed("Chapter One", 2, "editor", 1);
  const b = deriveSeed("Chapter One", 2, "editor", 1);
  assert.equal(a, b);
});

test("deriveSeed: a different retry attempt produces a different seed", () => {
  // Load-bearing: without this, a retry after a bad output would resample
  // with the identical seed+prompt and likely reproduce the identical bad
  // output, defeating the whole point of retrying.
  const attempt1 = deriveSeed("Chapter One", 2, "editor", 1);
  const attempt2 = deriveSeed("Chapter One", 2, "editor", 2);
  assert.notEqual(attempt1, attempt2);
});

test("deriveSeed: different agent/reviewer indices produce different seeds", () => {
  const editor0 = deriveSeed("Chapter One", 2, "editor:0", 1);
  const editor1 = deriveSeed("Chapter One", 2, "editor:1", 1);
  assert.notEqual(editor0, editor1);
});

test("deriveSeed: different chapters or chunk indices produce different seeds", () => {
  const chapterOne = deriveSeed("Chapter One", 0, "editor", 1);
  const chapterTwo = deriveSeed("Chapter Two", 0, "editor", 1);
  const chunkTwo = deriveSeed("Chapter One", 1, "editor", 1);
  assert.notEqual(chapterOne, chapterTwo);
  assert.notEqual(chapterOne, chunkTwo);
});

test("deriveSeed: always returns a non-negative 32-bit integer", () => {
  for (let i = 0; i < 20; i++) {
    const seed = deriveSeed("some manuscript", i, "editor", 1);
    assert.ok(Number.isInteger(seed));
    assert.ok(seed >= 0 && seed <= 0xffffffff);
  }
});

// ── buildLocalChatBody ──

test("buildLocalChatBody: includes seed when provided", () => {
  const body = buildLocalChatBody(CFG, [{ role: "user", content: "hi" }], {
    seed: 12345,
  });
  assert.equal(body.seed, 12345);
});

test("buildLocalChatBody: omits seed entirely when not provided", () => {
  const body = buildLocalChatBody(CFG, [{ role: "user", content: "hi" }], {});
  assert.equal("seed" in body, false);
});

test("buildLocalChatBody: an explicit temperature override wins over the model config", () => {
  const body = buildLocalChatBody(CFG, [{ role: "user", content: "hi" }], {
    temperature: 0,
  });
  assert.equal(body.temperature, 0);
});

test("buildLocalChatBody: temperature falls back to the model config when not overridden", () => {
  const body = buildLocalChatBody(CFG, [{ role: "user", content: "hi" }], {});
  assert.equal(body.temperature, CFG.temperature);
});
