// Translation is refused on a locally-run model. Every other pass degrades
// gracefully on a small model — a missed correction is a missed correction —
// but a weak translation is fluent, confident and wrong, and an author who
// does not read both languages cannot see it. Since the reviewer passes were
// removed, nothing downstream compares the output against its source either.
//
// The exemption matters as much as the rule: a hosted model is fine, including
// a user's own External Betty key. It is the bundled engine that is blocked.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOCAL_BLOCKED_MODES,
  partitionLocalModes,
  partitionCloudModes,
} from "../src/cloudEstimate.ts";
import { isApiModel } from "../src/modelCatalog.ts";

test("translation is the only pass a local model may not run", () => {
  assert.deepEqual([...LOCAL_BLOCKED_MODES], ["translate"]);
});

test("a local selection keeps everything except translation", () => {
  const { allowed, rejected } = partitionLocalModes([
    "copy_edit",
    "line_edit",
    "proofread",
    "publication_scan",
    "language_analysis",
    "translate",
  ]);
  assert.deepEqual(rejected, ["translate"]);
  assert.equal(allowed.includes("translate"), false);
  assert.equal(allowed.length, 5);
});

test("an edit-only selection is not blocked at all", () => {
  assert.deepEqual(partitionLocalModes(["copy_edit", "line_edit"]).rejected, []);
});

test("hosted models are exempt — the cloud entry and an External Betty key", () => {
  // Both are "custom:" identifiers that are not a custom GGUF path, which is
  // what the route's gate tests. If this ever stops being true, translation
  // silently becomes unavailable to paying cloud users.
  assert.equal(isApiModel("custom:bethaniel-cloud"), true);
  assert.equal(isApiModel("custom:deepseek"), true);
  assert.equal(isApiModel("custom:gguf:/Users/x/model.gguf"), false);
  assert.equal(isApiModel("betty-normal.gguf"), false);
});

test("the cloud still runs translation — the two gates are not the same list", () => {
  // A mirror gate that blocked the same modes both ways would leave
  // translation unrunnable anywhere.
  assert.deepEqual(partitionCloudModes(["translate"]).rejected, []);
});
