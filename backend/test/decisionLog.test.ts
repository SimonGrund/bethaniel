// ── The deck's record of answers ──
//
// Pure, and tested from here because the frontend has no test runner — the
// same reach-across updateStatus.test.ts uses.
//
// The bug this pins (reported by a user): accepting "the same change
// elsewhere" switched the N other corrections on without logging them, so the
// deck's count stood still and the cards came round again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { recordDecisions, isAccepted } from "../../frontend/src/decisionLog.ts";

const empty = () => ({
  acceptedCorrections: {} as Record<string, Set<string>>,
  decisionLog: [] as { taskId: string; correctionId: string; wasAccepted: boolean }[],
  deckHistory: [] as { kind: "decide" | "postpone"; taskId: string; count?: number }[],
  deckPostponed: [] as string[],
});

test("a batch logs every card it answers, so the deck counts all of them", () => {
  const out = recordDecisions(empty(), [
    { taskId: "t1", correctionId: "a" },
    { taskId: "t1", correctionId: "b" },
    { taskId: "t2", correctionId: "c" },
  ]);
  assert.deepEqual(
    out.decisionLog.map((d) => `${d.taskId}/${d.correctionId}`),
    ["t1/a", "t1/b", "t2/c"],
  );
});

test("a batch is one step for Back, carrying how many answers it covers", () => {
  const st = empty();
  st.deckHistory.push({ kind: "decide", taskId: "t1" });
  const out = recordDecisions(st, [
    { taskId: "t1", correctionId: "a" },
    { taskId: "t2", correctionId: "b" },
  ]);
  assert.equal(out.deckHistory.length, 2);
  assert.deepEqual(out.deckHistory[1], { kind: "decide", taskId: "t1", count: 2 });
});

test("a single answer stays a plain step", () => {
  const out = recordDecisions(empty(), [{ taskId: "t1", correctionId: "a" }]);
  assert.deepEqual(out.deckHistory, [{ kind: "decide", taskId: "t1" }]);
});

test("each entry remembers whether its correction was on before", () => {
  const st = empty();
  st.acceptedCorrections.t1 = new Set(["a", "b:2"]);
  const out = recordDecisions(st, [
    { taskId: "t1", correctionId: "a" },
    { taskId: "t1", correctionId: "b" },
    { taskId: "t1", correctionId: "c" },
  ]);
  assert.deepEqual(
    out.decisionLog.map((d) => d.wasAccepted),
    [true, true, false],
  );
});

test("a card answered again keeps only its latest answer, at the end", () => {
  const st = empty();
  st.decisionLog.push(
    { taskId: "t1", correctionId: "a", wasAccepted: false },
    { taskId: "t1", correctionId: "x", wasAccepted: false },
  );
  const out = recordDecisions(st, [{ taskId: "t1", correctionId: "a" }]);
  assert.deepEqual(
    out.decisionLog.map((d) => d.correctionId),
    ["x", "a"],
  );
});

test("answered cards are no longer put off", () => {
  const st = empty();
  st.deckPostponed.push("t1\u0000a", "t1\u0000z");
  const out = recordDecisions(st, [{ taskId: "t1", correctionId: "a" }]);
  assert.deepEqual(out.deckPostponed, ["t1\u0000z"]);
});

test("nothing to answer changes nothing", () => {
  const st = empty();
  const out = recordDecisions(st, []);
  assert.equal(out.deckHistory.length, 0);
  assert.equal(out.decisionLog, st.decisionLog);
});

test("isAccepted counts a correction on by any of its occurrences", () => {
  assert.equal(isAccepted(new Set(["a:1"]), "a"), true);
  assert.equal(isAccepted(new Set(["ab"]), "a"), false);
  assert.equal(isAccepted(undefined, "a"), false);
});
