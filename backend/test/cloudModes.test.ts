// The three cards on the task step are the paid product. If this list and
// that card set ever disagree, we are either advertising something we will
// not sell or hiding something we would.
//
// The card set cannot be imported here: the frontend has no test runner and
// the backend deliberately does not depend on frontend types (see the same
// note in cloudEstimate.test.ts). So this pins the backend half — the half
// that costs money if it is wrong — and names the frontend constant that
// must move with it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CLOUD_ALLOWED_MODES } from "../src/cloudEstimate.ts";

test("the sellable modes are exactly the three front cards, plus the merge target", () => {
  // Mirrors FRONT_CARD_MODES in frontend/src/types.ts. combined_edit is the
  // backend's merge of copy_edit + line_edit; no user ever selects it.
  const expected = [
    "copy_edit",
    "line_edit",
    "combined_edit",
    "proofread",
    "publication_scan",
    "translate",
  ];
  assert.deepEqual([...CLOUD_ALLOWED_MODES].sort(), expected.sort());
});

test("no experimental mode is sellable", () => {
  // These live behind the Experimental disclosure and are not benchmarked
  // well enough to charge for.
  for (const mode of [
    "developmental_edit",
    "character_catalog",
    "location_catalog",
    "timeline",
    "combined_analysis",
    "text_evaluator",
  ]) {
    assert.ok(
      !CLOUD_ALLOWED_MODES.includes(mode),
      `${mode} must not be sellable while it sits under Experimental`,
    );
  }
});
