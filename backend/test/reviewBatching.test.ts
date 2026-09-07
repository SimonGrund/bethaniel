// The reviewer answers with one JSONL line per correction, so what it must
// write grows with the correction count while the room it has shrinks by the
// same prompt that lists them. Past a certain density the two cross and the
// reply is truncated — and a correction past the cut is indistinguishable
// from one the reviewer deliberately passed.
//
// Measured before batching, on a chunk with 95 corrections: an 8k-context
// local model could cover about two thirds at best, while a 128k-context
// cloud model covered all of them. That made review look like a model-quality
// difference when it was a budget one. Batching makes coverage a property of
// the pipeline instead of the machine it happens to run on.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planReviewBatches } from "../src/llm.ts";
import type { Correction } from "../src/types.ts";

const LOCAL = "Qwen3.5-4B-Q4_K_M.gguf"; // num_ctx 8192
const CLOUD = "custom:bethaniel-cloud"; // num_ctx 128000

const chunk = "Sie oeffnete die Mappe. ".repeat(300);
const mkCorrections = (n: number): Correction[] =>
  Array.from({ length: n }, (_, i) => ({
    original: `fehlerhafte Stelle Nummer ${i}`,
    corrected: `korrigierte Stelle Nummer ${i}`,
  }));

function covers(batches: [number, number][], n: number): boolean {
  let next = 0;
  for (const [s, e] of batches) {
    if (s !== next || e <= s) return false;
    next = e;
  }
  return next === n;
}

test("every correction lands in exactly one batch", () => {
  for (const n of [1, 7, 40, 95, 300]) {
    const b = planReviewBatches(LOCAL, chunk, mkCorrections(n), "review this");
    assert.ok(covers(b, n), `n=${n} not covered exactly once: ${JSON.stringify(b)}`);
  }
});

test("a dense chunk is split on a small-context model", () => {
  const b = planReviewBatches(LOCAL, chunk, mkCorrections(95), "review this");
  assert.ok(b.length > 1, "95 corrections must not be asked for in one call at 8k");
});

test("a roomy model still gets to ask in one go", () => {
  const b = planReviewBatches(CLOUD, chunk, mkCorrections(95), "review this");
  assert.equal(b.length, 1, "128k context has no reason to split 95 corrections");
});

test("coverage does not depend on context size — only the batch count does", () => {
  const cs = mkCorrections(95);
  const small = planReviewBatches(LOCAL, chunk, cs, "review this");
  const large = planReviewBatches(CLOUD, chunk, cs, "review this");
  assert.ok(covers(small, 95));
  assert.ok(covers(large, 95));
  assert.ok(small.length > large.length);
});

test("no correction is left out even when a single one is oversized", () => {
  const huge: Correction[] = [
    { original: "x".repeat(40000), corrected: "y".repeat(40000) },
    { original: "teh", corrected: "the" },
  ];
  const b = planReviewBatches(LOCAL, chunk, huge, "review this");
  assert.ok(covers(b, 2), `oversized correction must still be covered: ${JSON.stringify(b)}`);
});

test("no corrections means no reviewer call at all", () => {
  assert.deepEqual(planReviewBatches(LOCAL, chunk, [], "review this"), []);
});
