// ── A run that has started but produced nothing yet ──
//
// A cloud run begins by waking a serverless model, and until its first words
// come back every chapter is "editing" at 0%: the bar stands still, there is
// no time left to show, the chapter count does not move. On a cold start
// that lasts long enough to read as broken.
//
// startupStage says which of a few messages to show while nothing has come
// back, advancing with the time since the run started so the screen visibly
// moves on — and returns null the moment any progress exists.

import { test } from "node:test";
import assert from "node:assert/strict";

import { startupStage, runStartedAt } from "../../frontend/src/runStartup.ts";

const at = (seconds: number) => ({ startedAt: 1_000_000, now: 1_000_000 + seconds * 1000 });

test("nothing is shown once the run has made any progress", () => {
  assert.equal(startupStage({ fraction: 0.01, cloud: true, ...at(5) }), null);
  assert.equal(startupStage({ fraction: 0.4, cloud: false, ...at(300) }), null);
});

test("the first message says where Betty is starting", () => {
  assert.equal(startupStage({ fraction: 0, cloud: true, ...at(2) }), "run_start_cloud");
  assert.equal(startupStage({ fraction: 0, cloud: false, ...at(2) }), "run_start_local");
});

test("the message moves on while the wait goes on", () => {
  const stages = [0, 9, 10, 29, 30, 74, 75, 600].map((s) =>
    startupStage({ fraction: 0, cloud: true, ...at(s) }),
  );
  assert.deepEqual(stages, [
    "run_start_cloud",
    "run_start_cloud",
    "run_start_wake",
    "run_start_wake",
    "run_start_warm",
    "run_start_warm",
    "run_start_long",
    "run_start_long",
  ]);
});

test("a clock that disagrees with the backend's never shows a negative wait", () => {
  assert.equal(startupStage({ fraction: 0, cloud: true, startedAt: 2000, now: 1000 }), "run_start_cloud");
});

test("the run started when its earliest task did", () => {
  assert.equal(
    runStartedAt([
      { submittedAt: 3000, startedAt: 5000 },
      { submittedAt: 2000 },
      { submittedAt: 4000, startedAt: 4500 },
    ]),
    2000,
  );
  assert.equal(runStartedAt([]), null);
});
