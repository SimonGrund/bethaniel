// When a chapter fails and then succeeds on retry, its earlier complaints
// describe a state that is no longer true. They are removed so the panel only
// carries problems that still need attention.
//
// The trade-off was made knowingly: this discards the record of a transient
// failure, so a run that recovered leaves no trace of why it was slow. Errors
// not tied to a task (engine-wide faults) carry no taskId and must survive.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  appendLog,
  clearLogs,
  getLogSnapshot,
  resolveLogsForTask,
} from "../src/logBus.ts";

beforeEach(() => clearLogs());

test("a task's errors are dropped once it succeeds", () => {
  appendLog({ level: "error", source: "task", message: "boom", taskId: "t1" });
  appendLog({ level: "warn", source: "task", message: "hmm", taskId: "t1" });

  const removed = resolveLogsForTask("t1");

  assert.equal(removed, 2);
  assert.equal(getLogSnapshot().length, 0);
});

test("other tasks' entries are untouched", () => {
  appendLog({ level: "error", source: "task", message: "mine", taskId: "t1" });
  appendLog({ level: "error", source: "task", message: "theirs", taskId: "t2" });

  resolveLogsForTask("t1");

  const left = getLogSnapshot();
  assert.equal(left.length, 1);
  assert.equal(left[0].taskId, "t2");
});

test("engine-wide errors survive — they are not any task's fault to clear", () => {
  appendLog({ level: "error", source: "engine", message: "engine died" });
  appendLog({ level: "error", source: "task", message: "boom", taskId: "t1" });

  resolveLogsForTask("t1");

  const left = getLogSnapshot();
  assert.equal(left.length, 1);
  assert.equal(left[0].source, "engine");
});

test("the task's own progress narration is kept", () => {
  // Removing "Editing Chapter 3…" would tear holes in the timeline; only the
  // complaints go.
  appendLog({ level: "info", source: "task", message: "Editing…", taskId: "t1" });
  appendLog({ level: "error", source: "task", message: "boom", taskId: "t1" });

  resolveLogsForTask("t1");

  const left = getLogSnapshot();
  assert.equal(left.length, 1);
  assert.equal(left[0].level, "info");
});

test("resolving a task with nothing to clear is a no-op", () => {
  appendLog({ level: "error", source: "task", message: "boom", taskId: "t1" });
  assert.equal(resolveLogsForTask("t2"), 0);
  assert.equal(resolveLogsForTask(""), 0);
  assert.equal(getLogSnapshot().length, 1);
});
