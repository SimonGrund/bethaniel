// Tests for the client-facing snapshot shaping: heavy fields (retrySpec,
// analysisCheckpoint, result) must never ride along on socket broadcasts /
// /queue/status; a resultMeta summary replaces the full result.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeResultMeta,
  shapeClientTask,
  buildClientSnapshot,
} from "../src/snapshot.ts";
import type { TaskState, TaskResult } from "../src/types.ts";

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "t1",
    jobId: "j1",
    status: "done",
    progress: 1,
    phase: "",
    name: "Chapter 1",
    source: "book.docx",
    mode: "copy_edit",
    wordCount: 1000,
    submittedAt: 1,
    result: null,
    ...overrides,
  };
}

const fullResult: TaskResult = {
  editedText: "edited text",
  originalText: "original text",
  corrections: [
    { original: "teh", corrected: "the" },
    { original: "adn", corrected: "and" },
  ],
  skipped: [{ original: "x", corrected: "y" }],
  errors: ["one error"],
};

test("shapeClientTask strips retrySpec, analysisCheckpoint, and result", () => {
  const task = makeTask({
    result: fullResult,
    retrySpec: {
      name: "Chapter 1",
      source: "book.docx",
      original: "full chapter text",
      wordCount: 1000,
      model: "m",
      mode: "copy_edit",
      prompt: "p",
      wpc: 2500,
      overlap: 1,
    },
    analysisCheckpoint: { big: "blob" },
  });
  const shaped = shapeClientTask(task);
  assert.equal(shaped.result, null);
  assert.ok(!("retrySpec" in shaped));
  assert.ok(!("analysisCheckpoint" in shaped));
  // Light fields survive
  assert.equal(shaped.name, "Chapter 1");
  assert.equal(shaped.status, "done");
});

test("resultMeta counts corrections, skipped, and errors", () => {
  const meta = makeResultMeta(fullResult);
  assert.ok(meta);
  assert.equal(meta!.corrections, 2);
  assert.equal(meta!.skipped, 1);
  assert.equal(meta!.errors, 1);
  assert.equal(meta!.hasStructured, false);
  assert.equal(meta!.hasText, true);
});

test("resultMeta flags structured data", () => {
  const meta = makeResultMeta({
    ...fullResult,
    structuredData: { characters: [] },
  });
  assert.equal(meta!.hasStructured, true);
});

test("resultMeta hasText for edited-only and original-only results", () => {
  const editedOnly = makeResultMeta({ ...fullResult, originalText: "" });
  assert.equal(editedOnly!.hasText, true);
  const originalOnly = makeResultMeta({ ...fullResult, editedText: "" });
  assert.equal(originalOnly!.hasText, true);
  const neither = makeResultMeta({
    ...fullResult,
    editedText: "",
    originalText: "",
  });
  assert.equal(neither!.hasText, false);
});

test("resultMeta is null for tasks without a result (queued/editing)", () => {
  assert.equal(makeResultMeta(null), null);
  assert.equal(makeResultMeta(undefined), null);
  const shaped = shapeClientTask(makeTask({ status: "queued", result: null }));
  assert.equal(shaped.resultMeta, null);
});

test("buildClientSnapshot keys by task id and shapes every task", () => {
  const snap = buildClientSnapshot([
    makeTask({ id: "a", result: fullResult }),
    makeTask({ id: "b", status: "queued" }),
  ]);
  assert.deepEqual(Object.keys(snap).sort(), ["a", "b"]);
  assert.equal(snap.a.result, null);
  assert.equal(snap.a.resultMeta!.corrections, 2);
  assert.equal(snap.b.resultMeta, null);
});
