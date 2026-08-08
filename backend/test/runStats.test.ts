// Job progress measures words SUCCESSFULLY EDITED, not words no longer
// pending. A failed chapter therefore holds the bar below 100% on purpose:
// the job did not fully succeed and the user needs to see that.
//
// Throughput is reported in aggregate. A real 3-slot run showed each stream at
// ~6 tok/s, which read as "Betty is broken" when the machine was in fact doing
// ~17 — near its measured single-stream ceiling of 20.9.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeJobProgress, computeRuntime } from "../src/runStats.ts";
import type { TaskState } from "../src/types.ts";

function task(p: Partial<TaskState>): TaskState {
  return {
    id: "t",
    jobId: "j",
    status: "queued",
    progress: 0,
    phase: "",
    name: "",
    source: "",
    mode: "copy_edit",
    wordCount: 100,
    submittedAt: 0,
    result: null,
    ...p,
  } as TaskState;
}

// ── Job progress ──

test("a long chapter moves the bar more than a short one", () => {
  const r = computeJobProgress([
    task({ id: "a", wordCount: 900, status: "done" }),
    task({ id: "b", wordCount: 100, status: "queued" }),
  ]);
  assert.equal(r.j.wordsTotal, 1000);
  assert.equal(r.j.wordsDone, 900);
  assert.equal(r.j.fraction, 0.9);
});

test("a running task contributes its partial progress", () => {
  const r = computeJobProgress([
    task({ id: "a", wordCount: 100, status: "editing", progress: 0.5 }),
  ]);
  assert.equal(r.j.fraction, 0.5);
});

test("a failed chapter holds the bar below 100% and is counted", () => {
  const r = computeJobProgress([
    task({ id: "a", wordCount: 900, status: "done" }),
    task({ id: "b", wordCount: 100, status: "error" }),
  ]);
  assert.equal(r.j.fraction, 0.9, "failed words must not count as done");
  assert.equal(r.j.failed, 1);
});

test("a cancelled chapter also counts zero", () => {
  const r = computeJobProgress([
    task({ id: "a", wordCount: 500, status: "done" }),
    task({ id: "b", wordCount: 500, status: "cancelled" }),
  ]);
  assert.equal(r.j.fraction, 0.5);
  assert.equal(r.j.failed, 0, "cancelled is deliberate, not a failure");
});

test("jobs are reported separately", () => {
  const r = computeJobProgress([
    task({ id: "a", jobId: "j1", wordCount: 100, status: "done" }),
    task({ id: "b", jobId: "j2", wordCount: 100, status: "queued" }),
  ]);
  assert.equal(r.j1.fraction, 1);
  assert.equal(r.j2.fraction, 0);
});

test("a zero-word job falls back to task count instead of dividing by zero", () => {
  const r = computeJobProgress([
    task({ id: "a", wordCount: 0, status: "done" }),
    task({ id: "b", wordCount: 0, status: "queued" }),
  ]);
  assert.equal(r.j.fraction, 0.5);
  assert.ok(Number.isFinite(r.j.fraction));
});

test("no tasks yields no entries", () => {
  assert.deepEqual(computeJobProgress([]), {});
});

test("a meta task carrying words does not hold the bar back", () => {
  // The real risk: a summary/blurb task that reports a word count would
  // otherwise sit in the denominator and keep a finished job below 100%.
  // CurrentRunHeader has always excluded these from its own maths; the backend
  // must agree or the bar and the log line would disagree.
  const r = computeJobProgress([
    task({ id: "a", wordCount: 1000, status: "done", mode: "copy_edit" }),
    task({
      id: "s",
      wordCount: 500,
      status: "queued",
      mode: "analysis_summary",
    }),
  ]);
  assert.equal(r.j.fraction, 1, "the pending summary must not count");
});

test("a job of only meta tasks still reports rather than vanishing", () => {
  const r = computeJobProgress([
    task({ id: "s", wordCount: 500, status: "done", mode: "analysis_summary" }),
  ]);
  assert.equal(r.j.fraction, 1);
});

// ── Aggregate throughput ──

test("aggregate throughput sums the running streams", () => {
  // The numbers a real 3-slot run produced.
  const r = computeRuntime(
    [
      task({ id: "a", status: "editing", tokPerSec: "6.47" }),
      task({ id: "b", status: "editing", tokPerSec: "5.18" }),
      task({ id: "c", status: "editing", tokPerSec: "5.73" }),
    ],
    3,
  );
  assert.equal(r.activeStreams, 3);
  assert.equal(Math.round(r.aggregateTokPerSec * 10) / 10, 17.4);
  assert.equal(r.parallelSlots, 3);
});

test("only running tasks count toward throughput", () => {
  const r = computeRuntime(
    [
      task({ id: "a", status: "editing", tokPerSec: "10" }),
      task({ id: "b", status: "done", tokPerSec: "99" }),
      task({ id: "c", status: "queued" }),
    ],
    2,
  );
  assert.equal(r.activeStreams, 1);
  assert.equal(r.aggregateTokPerSec, 10);
});

test("a task with no tokens yet is not counted as a stream", () => {
  // Otherwise the very start of a run reports a stream doing 0 tok/s and
  // drags the displayed figure down.
  const r = computeRuntime([task({ id: "a", status: "editing" })], 1);
  assert.equal(r.activeStreams, 0);
  assert.equal(r.aggregateTokPerSec, 0);
});

test("unparsable tokPerSec is ignored rather than producing NaN", () => {
  const r = computeRuntime(
    [task({ id: "a", status: "editing", tokPerSec: "n/a" })],
    1,
  );
  assert.equal(r.aggregateTokPerSec, 0);
  assert.ok(Number.isFinite(r.aggregateTokPerSec));
});
