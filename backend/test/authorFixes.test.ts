// ── The author's own text over Betty's suggestion ──
//
// The deck's third answer (Edit) writes the author's text over a correction.
// The result it lives in is not persisted, so the text is kept on its own and
// laid back over the result after a restart — otherwise the export would
// apply Betty's text, still ticked, in place of the author's.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyAuthorFixes,
  withAuthorFix,
  withoutAuthorFix,
  AUTHOR_FIX_REASON,
} from "../../frontend/src/authorFixes.ts";
import type { TaskResult } from "../../frontend/src/types.ts";

const result = (corrections: TaskResult["corrections"]): TaskResult => ({
  editedText: "",
  originalText: "He walked slow to the house.",
  corrections,
  skipped: [],
  errors: [],
});

test("a result from the backend gets the author's text back, Betty's kept beside it", () => {
  const r = result([
    { id: "a", original: "walked slow", corrected: "walked slowly", reason: "adverb", flagged: true, reviewReason: "fine" },
    { id: "b", original: "the house", corrected: "the home" },
  ]);
  const out = applyAuthorFixes(r, { a: "ambled" });
  const [a, b] = out.corrections;
  assert.equal(a.corrected, "ambled");
  assert.equal(a.reason, AUTHOR_FIX_REASON);
  assert.equal(a.suggested, "walked slowly");
  assert.equal(a.suggestedReason, "adverb");
  assert.equal(a.flagged, false);
  assert.equal(a.reviewReason, undefined);
  assert.equal(b, r.corrections[1], "an untouched correction is the same object");
});

test("no fixes, or fixes already applied, return the result unchanged", () => {
  const r = result([{ id: "a", original: "x", corrected: "y" }]);
  assert.equal(applyAuthorFixes(r, undefined), r);
  assert.equal(applyAuthorFixes(r, {}), r);
  const once = applyAuthorFixes(r, { a: "z" });
  assert.equal(applyAuthorFixes(once, { a: "z" }), once);
});

test("a second edit is still an edit of Betty's text", () => {
  const c = { id: "a", original: "x", corrected: "y", reason: "typo" };
  const twice = withAuthorFix(withAuthorFix(c, "first"), "second");
  assert.equal(twice.corrected, "second");
  assert.equal(twice.suggested, "y");
  assert.equal(twice.suggestedReason, "typo");
});

test("Back puts Betty's suggestion back as it was", () => {
  const c = { id: "a", original: "x", corrected: "y", reason: "typo" };
  const back = withoutAuthorFix(withAuthorFix(c, "z"));
  assert.equal(back.corrected, "y");
  assert.equal(back.reason, "typo");
  assert.equal("suggested" in back, false);
  // A finding that proposed nothing goes back to proposing nothing.
  const word = { id: "w", original: "Havnsø", corrected: "Havnsø", reason: "spell-check-unknown" };
  assert.equal(withoutAuthorFix(withAuthorFix(word, "Havnsö")).corrected, "Havnsø");
  // Not the author's: left alone.
  assert.equal(withoutAuthorFix(c), c);
});
