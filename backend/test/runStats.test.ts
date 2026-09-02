// Job progress measures words SUCCESSFULLY EDITED, not words no longer
// pending. A failed chapter therefore holds the bar below 100% on purpose:
// the job did not fully succeed and the user needs to see that.
//
// Throughput is reported in aggregate. A real 3-slot run showed each stream at
// ~6 tok/s, which read as "Betty is broken" when the machine was in fact doing
// ~17 — near its measured single-stream ceiling of 20.9.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeJobProgress,
  computeRuntime,
  liveJobProgress,
} from "../src/runStats.ts";
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

// ── Estimated time remaining ──

test("estimatedSecondsRemaining is the longest ETA among running streams", () => {
  // Job isn't done until the slowest of what's actually running finishes.
  const r = computeRuntime(
    [
      task({ id: "a", status: "editing", tokPerSec: "10", etaSeconds: 30 }),
      task({ id: "b", status: "editing", tokPerSec: "8", etaSeconds: 90 }),
    ],
    2,
  );
  assert.equal(r.estimatedSecondsRemaining, 90);
});

test("estimatedSecondsRemaining ignores non-editing tasks", () => {
  const r = computeRuntime(
    [
      task({ id: "a", status: "editing", tokPerSec: "10", etaSeconds: 20 }),
      task({ id: "b", status: "done", tokPerSec: "99", etaSeconds: 999 }),
      task({ id: "c", status: "queued", etaSeconds: 500 }),
    ],
    2,
  );
  assert.equal(r.estimatedSecondsRemaining, 20);
});

test("estimatedSecondsRemaining is undefined when nothing running has an ETA yet", () => {
  const r = computeRuntime([task({ id: "a", status: "editing", tokPerSec: "10" })], 1);
  assert.equal(r.estimatedSecondsRemaining, undefined);
});

// ── Is the run over? ──
//
// A row reading "13,774 of 19,710 words / 70%" is identical whether the run is
// grinding away or ended five hours ago. Reported from live use as "a remnant
// of a former run still stuck" — it was neither stuck nor running: the user had
// cancelled five chapters, and cancelled words correctly count zero.

test("a job with work still queued or in flight is not settled", () => {
  const running = computeJobProgress([
    task({ jobId: "j", status: "done" }),
    task({ jobId: "j", status: "editing", progress: 0.5 }),
  ]);
  assert.equal(running.j.settled, false);

  const waiting = computeJobProgress([
    task({ jobId: "j", status: "done" }),
    task({ jobId: "j", status: "queued" }),
  ]);
  assert.equal(waiting.j.settled, false);
});

test("a job whose tasks have all reached a terminal state is settled", () => {
  const p = computeJobProgress([
    task({ jobId: "j", status: "done" }),
    task({ jobId: "j", status: "cancelled" }),
    task({ jobId: "j", status: "error" }),
  ]);
  assert.equal(p.j.settled, true);
});

test("cancelled chapters are counted, and apart from failures", () => {
  // The user stopping a run is not the same event as a chapter failing, and
  // telling them "5 not completed" about their own decision is wrong.
  const p = computeJobProgress([
    task({ jobId: "j", status: "done" }),
    task({ jobId: "j", status: "cancelled" }),
    task({ jobId: "j", status: "cancelled" }),
    task({ jobId: "j", status: "error" }),
  ]);
  assert.equal(p.j.cancelled, 2);
  assert.equal(p.j.failed, 1);
});

test("the live shape of the reported run", () => {
  // 14 chapters done, 5 cancelled — 13,774 of 19,710 words, settled at 70%.
  const done = Array.from({ length: 14 }, () =>
    task({ jobId: "j", status: "done", wordCount: 984 }),
  );
  const cancelled = Array.from({ length: 5 }, () =>
    task({ jobId: "j", status: "cancelled", wordCount: 1187 }),
  );
  const p = computeJobProgress([...done, ...cancelled]);
  assert.equal(p.j.settled, true);
  assert.equal(p.j.cancelled, 5);
  assert.equal(p.j.failed, 0);
  assert.ok(
    Math.round(p.j.fraction * 100) === 70,
    `expected 70%, got ${Math.round(p.j.fraction * 100)}%`,
  );
});

// ── What diagnostics actually shows ──
//
// Run progress is a live readout, not a history. It resets when the program
// restarts and when a run ends — asked for after a finished job's row sat in
// the panel looking like a stalled one. Hydration on startup already marks
// interrupted tasks cancelled, so "settled" covers both cases with one rule.

test("liveJobProgress omits runs that have ended", () => {
  const p = liveJobProgress([
    task({ id: "a", jobId: "over", status: "done" }),
    task({ id: "b", jobId: "over", status: "cancelled" }),
    task({ id: "c", jobId: "going", status: "editing", progress: 0.5 }),
  ]);
  assert.deepEqual(Object.keys(p), ["going"]);
});

test("liveJobProgress keeps a run with work still queued", () => {
  const p = liveJobProgress([
    task({ id: "a", jobId: "j", status: "done" }),
    task({ id: "b", jobId: "j", status: "queued" }),
  ]);
  assert.ok(p.j, "a job with queued work is still running");
});

test("after a restart nothing is live", () => {
  // initQueue rewrites queued/editing tasks to cancelled on hydrate, so every
  // task from a previous session is terminal by the time this runs.
  const p = liveJobProgress([
    task({ id: "a", jobId: "old", status: "done" }),
    task({ id: "b", jobId: "old", status: "cancelled" }),
    task({ id: "c", jobId: "older", status: "error" }),
  ]);
  assert.deepEqual(Object.keys(p), []);
});
