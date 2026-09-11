// A publication scan's proofread pass must be reviewed whatever the job asked
// for, because the readiness verdict only lists corrections a reviewer
// confirmed. See reviewModeForTask.
import test from "node:test";
import assert from "node:assert/strict";
import { reviewModeForTask } from "../src/runModePresets.ts";

const SCAN = ["proofread", "publication_scan"];

test("scan: proofread is reviewed even when the job turned review off", () => {
  assert.equal(reviewModeForTask("proofread", SCAN, false), true);
});

test("scan: proofread stays reviewed when the job asked for it", () => {
  assert.equal(reviewModeForTask("proofread", SCAN, true), true);
});

test("scan: the deterministic scan task itself is not forced", () => {
  // It runs no LLM at all, so the knob is meaningless — but it must not be
  // silently rewritten either.
  assert.equal(reviewModeForTask("publication_scan", SCAN, false), false);
});

test("a plain proofread run still honours review being off", () => {
  assert.equal(reviewModeForTask("proofread", ["proofread"], false), false);
});

test("other modes in a scan job are untouched", () => {
  assert.equal(
    reviewModeForTask("copy_edit", ["copy_edit", "publication_scan"], false),
    false,
  );
});
