// The closed enum is the whole privacy design.
//
// Error strings routinely embed the text that caused them. SimonGrund/bethaniel
// is a PUBLIC repository and these rows are rendered into an issue on it, so a
// free-text reason would eventually publish a fragment of a paying author's
// unpublished book, world-readable and indexed. Anything unrecognised collapses
// to "other": the failure is still counted, the words never travel.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  coerceFailureReason,
  coerceProduct,
  FAILURE_PRODUCTS,
  FAILURE_REASONS,
} from "../src/db";

test("every known reason survives unchanged", () => {
  for (const r of FAILURE_REASONS) assert.equal(coerceFailureReason(r), r);
});

test("an unknown reason collapses to other", () => {
  assert.equal(coerceFailureReason("kaboom"), "other");
});

test("a reason carrying manuscript text collapses to other", () => {
  const smuggled =
    'translation rejected: "The ferry stopped running in October, and by November"';
  assert.equal(coerceFailureReason(smuggled), "other");
});

test("a reason that merely CONTAINS a known one is still rejected", () => {
  // Substring matching would be a hole straight through the design: an error
  // string beginning "empty_output while translating <the author's prose>"
  // must not be waved through because of its first word.
  assert.equal(coerceFailureReason("empty_output: The ferry stopped"), "other");
});

test("a non-string collapses to other", () => {
  assert.equal(coerceFailureReason(null), "other");
  assert.equal(coerceFailureReason(undefined), "other");
  assert.equal(coerceFailureReason(42), "other");
  assert.equal(coerceFailureReason({ reason: "empty_output" }), "other");
  assert.equal(coerceFailureReason(["empty_output"]), "other");
});

test("the enum is exactly the seven agreed reasons", () => {
  assert.deepEqual([...FAILURE_REASONS].sort(), [
    "echoed_source",
    "empty_output",
    "network",
    "other",
    "provider_5xx",
    "timeout",
    "truncated",
  ]);
});

test("a known product survives; anything else is unknown", () => {
  for (const p of FAILURE_PRODUCTS) assert.equal(coerceProduct(p), p);
  assert.equal(coerceProduct("Chapter 3 of my novel"), "unknown");
  assert.equal(coerceProduct(null), "unknown");
});
