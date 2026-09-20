// The retry is only worth running if it asks a different question.
//
// With a fixed seed a deterministic model reproduces the same empty or echoed
// response, and the retry costs a full re-translation to arrive back exactly
// where it started. The chunk loop passes `attempt` into the seed for this
// reason; these pin it, because it is the kind of argument that gets dropped
// in a refactor without anything going red.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveSeed } from "../src/llm.ts";

test("a retried chunk asks with a different seed", () => {
  const first = deriveSeed("translate", "Chapter 1", 0, "rewrite", 1);
  const second = deriveSeed("translate", "Chapter 1", 0, "rewrite", 2);
  assert.notEqual(first, second);
});

test("the same attempt derives the same seed — runs stay reproducible", () => {
  assert.equal(
    deriveSeed("translate", "Chapter 1", 0, "rewrite", 1),
    deriveSeed("translate", "Chapter 1", 0, "rewrite", 1),
  );
});

test("different chunks of one chapter do not collide", () => {
  assert.notEqual(
    deriveSeed("translate", "Chapter 1", 0, "rewrite", 1),
    deriveSeed("translate", "Chapter 1", 1, "rewrite", 1),
  );
});

test("the upgrade pass does not collide with the draft it polishes", () => {
  // Both run inside one chunk. Sharing a seed would have the polish pass
  // sample identically to the draft it is supposed to improve on.
  assert.notEqual(
    deriveSeed("translate", "Chapter 1", 0, "rewrite", 1),
    deriveSeed("translate", "Chapter 1", 0, "upgrade", 1),
  );
});
