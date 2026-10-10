// ── The review table: every copy-edit suggestion and what the author did ──
//
// Exported from Settings so an author can share their reviews with the
// developer. The responses live in the app (acceptances, the deck's log), the
// suggestions on the backend; reviewTable.ts joins them. Pure, tested here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewResponse, reviewTable, REVIEW_HEADER } from "../../frontend/src/reviewTable.ts";
import type { TaskResult } from "../../frontend/src/types.ts";

const task = (id: string, mode = "copy_edit") => ({
  id,
  name: "Chapter 1",
  source: "book.docx",
  mode,
  status: "done",
  finishedAt: Date.UTC(2026, 9, 10, 12),
  model: "custom:bethaniel-cloud",
  manuscriptLang: "en",
});

const result = (corrections: TaskResult["corrections"]): TaskResult => ({
  editedText: "",
  originalText: "It was a grey day. She walked to to the shop and bought bread.",
  corrections,
  skipped: [],
  errors: [],
});

test("the response: accepted, partly, the author's own fix, dismissed, unanswered", () => {
  const acc = new Set(["a", "b:0", "c"]);
  assert.equal(reviewResponse({ id: "a", original: "x", corrected: "y" }, acc, false), "accepted");
  assert.equal(reviewResponse({ id: "b", original: "x", corrected: "y" }, acc, false), "partly accepted");
  assert.equal(
    reviewResponse({ id: "c", original: "x", corrected: "y", reason: "author-correction" }, acc, true),
    "accepted (author's own fix)",
  );
  assert.equal(reviewResponse({ id: "d", original: "x", corrected: "y" }, acc, true), "dismissed");
  assert.equal(reviewResponse({ id: "e", original: "x", corrected: "y" }, acc, false), "not answered");
  assert.equal(reviewResponse({ id: "e", original: "x", corrected: "y" }, undefined, false), "not answered");
});

test("one row per suggestion of an edit task, with its context and the reviewer's view", () => {
  const rows = reviewTable(
    [task("t1"), task("t2", "translate"), { ...task("t3"), status: "error" }],
    {
      t1: result([
        { id: "c1", original: "to to", corrected: "to", reason: "duplicated word", confidence: 5, preApproved: true },
        { id: "c2", original: "grey", corrected: "gray", reason: "dialect", confidence: 2, flagged: true, reviewReason: "British is consistent" },
      ]),
      t2: result([{ id: "x", original: "a", corrected: "b" }]),
    },
    { t1: new Set(["c1"]) },
    [{ taskId: "t1", correctionId: "c2", wasAccepted: false }],
  );
  assert.deepEqual(rows[0], REVIEW_HEADER);
  assert.equal(rows.length, 3, "translate and failed tasks are not reviews");
  const col = (name: string) => REVIEW_HEADER.indexOf(name);
  const [, first, second] = rows;
  assert.equal(first[col("Original")], "to to");
  assert.equal(first[col("Suggestion")], "to");
  assert.match(first[col("Context")], /She walked to to the shop/);
  assert.equal(first[col("Response")], "accepted");
  assert.equal(first[col("Pre-approved")], "yes");
  assert.equal(first[col("Reviewer score (1-5)")], "5");
  assert.equal(second[col("Response")], "dismissed");
  assert.equal(second[col("Answered in review deck")], "yes");
  assert.equal(second[col("Reviewer note")], "British is consistent");
  assert.equal(second[col("Flagged")], "yes");
  assert.equal(second[col("Finished")], "2026-10-10");
  assert.ok(rows.every((r) => r.length === REVIEW_HEADER.length));
});

test("each row says which run it came from, and runs are kept apart and in order", () => {
  const at = (h: number) => new Date(2026, 9, 10, h, 5).getTime();
  const t = (id: string, jobId: string, submittedAt: number, unitIndex: number) => ({
    ...task(id),
    jobId,
    submittedAt,
    unitIndex,
    name: `Chapter ${unitIndex + 1}`,
  });
  const r = result([{ id: "c", original: "to to", corrected: "to" }]);
  const rows = reviewTable(
    // The later run first, and its chapters out of order.
    [t("b2", "bbbbbbbb-2", at(15), 1), t("b1", "bbbbbbbb-2", at(15), 0), t("a1", "aaaaaaaa-1", at(9), 0)],
    { a1: r, b1: r, b2: r },
    {},
    [],
  );
  const run = REVIEW_HEADER.indexOf("Run");
  const chapter = REVIEW_HEADER.indexOf("Chapter");
  assert.deepEqual(
    rows.slice(1).map((x) => [x[run], x[chapter]]),
    [
      ["2026-10-10 09:05 · aaaaaaaa", "Chapter 1"],
      ["2026-10-10 15:05 · bbbbbbbb", "Chapter 1"],
      ["2026-10-10 15:05 · bbbbbbbb", "Chapter 2"],
    ],
  );
});
