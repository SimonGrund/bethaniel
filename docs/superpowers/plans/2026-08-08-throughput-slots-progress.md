# Honest Throughput, Auto-Fitted Slots, Job Progress & Auto-Retry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report aggregate rather than per-stream throughput, cap parallel slots by memory architecture, show word-weighted job progress that stays below 100% when a chapter fails, and retry transiently-failed chapters automatically.

**Architecture:** All new logic lands in two **pure modules** (`runStats.ts`, `retryPolicy.ts`) that take plain `TaskState[]` and return plain data — following the precedent set by `snapshot.ts`, which is deliberately pure so it can be tested without the stateful queue or the database. `queue.ts` and `llamaServer.ts` only *call* them. A new `run:stats` socket event carries the derived numbers, leaving the existing `queue:update` contract untouched.

**Tech Stack:** TypeScript, Node 22, `node:test` via the `tsx` loader (backend), React + Zustand + Socket.IO (frontend).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-08-throughput-slots-progress-design.md`.
- Backend tests run with `npm test` from `backend/` — `node --import tsx --test "test/**/*.test.ts"`. No new test dependencies.
- Test files import source with an explicit `.ts` extension: `from "../src/runStats.ts"`.
- Source files import each other with `.js` extensions (ESM/NodeNext): `from "./runStats.js"`.
- **No new `TaskStatus` value.** The spec described an `awaiting-retry` state; this plan instead reuses `"queued"` plus an `attempts` counter. `TaskStatus` is switched on across the frontend, the queue hydration path (`queued`/`editing` → `cancelled` on boot), and `isWorking` checks in `Sidebar.tsx`; reusing `"queued"` gets all of that behaviour correct for free and avoids auditing every consumer. Progress and the UI read `attempts`, not a status.
- Slot caps: **2** on unified memory (`process.platform === "darwin" && process.arch === "arm64"`), **3** elsewhere.
- Max automatic retries: **2** (3 runs total).
- The frontend has no test framework. Frontend tasks are verified by running the app.

---

### Task 1: Word-weighted job progress (pure)

**Files:**
- Create: `backend/src/runStats.ts`
- Test: `backend/test/runStats.test.ts`

**Interfaces:**
- Consumes: `TaskState` from `backend/src/types.ts` (fields used: `jobId`, `status`, `progress`, `wordCount`).
- Produces:
  - `export interface JobProgress { fraction: number; wordsDone: number; wordsTotal: number; failed: number }`
  - `export function computeJobProgress(tasks: Iterable<TaskState>): Record<string, JobProgress>`

- [ ] **Step 1: Write the failing test**

Create `backend/test/runStats.test.ts`:

```ts
// Job progress measures words SUCCESSFULLY EDITED, not words no longer
// pending. A failed chapter therefore holds the bar below 100% on purpose:
// the job did not fully succeed and the user needs to see that.

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeJobProgress } from "../src/runStats.ts";
import type { TaskState } from "../src/types.ts";

function task(p: Partial<TaskState>): TaskState {
  return {
    id: "t", jobId: "j", status: "queued", progress: 0, phase: "",
    name: "", source: "", mode: "copy_edit", wordCount: 100,
    submittedAt: 0, result: null,
    ...p,
  } as TaskState;
}

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/runStats.test.ts`
Expected: FAIL — `Cannot find module '../src/runStats.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/runStats.ts`:

```ts
// ── Derived run statistics ──
//
// Pure module, like snapshot.ts: takes plain TaskState values and returns plain
// data, so the maths can be tested without the stateful queue or the database.

import type { TaskState } from "./types.js";

export interface JobProgress {
  /** 0..1, share of the job's words successfully edited. */
  fraction: number;
  wordsDone: number;
  wordsTotal: number;
  /** Permanently failed tasks — the reason `fraction` may never reach 1. */
  failed: number;
}

/**
 * How much of each task's words count as edited.
 *
 * Only `done` counts fully. A failed or cancelled chapter counts zero: its
 * words were never edited, and a bar reading 100% over a failed chapter tells
 * the user the opposite of the truth.
 */
function editedFraction(t: TaskState): number {
  if (t.status === "done") return 1;
  if (t.status === "editing") return Math.min(1, Math.max(0, t.progress ?? 0));
  return 0;
}

export function computeJobProgress(
  tasks: Iterable<TaskState>,
): Record<string, JobProgress> {
  const byJob = new Map<string, TaskState[]>();
  for (const t of tasks) {
    const list = byJob.get(t.jobId);
    if (list) list.push(t);
    else byJob.set(t.jobId, [t]);
  }

  const out: Record<string, JobProgress> = {};
  for (const [jobId, list] of byJob) {
    const wordsTotal = list.reduce((n, t) => n + (t.wordCount || 0), 0);
    const failed = list.filter((t) => t.status === "error").length;

    if (wordsTotal === 0) {
      // Analysis-only jobs can carry no word counts. Fall back to task count
      // rather than dividing by zero.
      const done = list.reduce((n, t) => n + editedFraction(t), 0);
      out[jobId] = {
        fraction: list.length ? done / list.length : 0,
        wordsDone: 0,
        wordsTotal: 0,
        failed,
      };
      continue;
    }

    const wordsDone = list.reduce(
      (n, t) => n + (t.wordCount || 0) * editedFraction(t),
      0,
    );
    out[jobId] = {
      fraction: wordsDone / wordsTotal,
      wordsDone: Math.round(wordsDone),
      wordsTotal,
      failed,
    };
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --test test/runStats.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/runStats.ts backend/test/runStats.test.ts
git commit -m "feat(stats): word-weighted job progress that failures hold below 100%"
```

---

### Task 2: Aggregate throughput (pure)

**Files:**
- Modify: `backend/src/runStats.ts`
- Test: `backend/test/runStats.test.ts` (append)

**Interfaces:**
- Consumes: `TaskState` (`status`, `tokPerSec`).
- Produces:
  - `export interface RuntimeStats { activeStreams: number; aggregateTokPerSec: number; parallelSlots: number }`
  - `export function computeRuntime(tasks: Iterable<TaskState>, parallelSlots: number): RuntimeStats`

- [ ] **Step 1: Write the failing test**

Append to `backend/test/runStats.test.ts`:

```ts
import { computeRuntime } from "../src/runStats.ts";

test("aggregate throughput sums the running streams", () => {
  // The numbers a real 3-slot run produced; each stream looked like "6 tok/s"
  // while the machine was actually doing ~17.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/runStats.test.ts`
Expected: FAIL — `computeRuntime is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `backend/src/runStats.ts`:

```ts
export interface RuntimeStats {
  /** Tasks currently producing tokens. */
  activeStreams: number;
  /** Sum of the running streams' rates — what the machine is really doing. */
  aggregateTokPerSec: number;
  /** Slots llama-server was actually launched with. */
  parallelSlots: number;
}

export function computeRuntime(
  tasks: Iterable<TaskState>,
  parallelSlots: number,
): RuntimeStats {
  let activeStreams = 0;
  let aggregateTokPerSec = 0;

  for (const t of tasks) {
    if (t.status !== "editing") continue;
    const rate = Number(t.tokPerSec);
    // A task that has not emitted its first token yet has no rate. Counting it
    // as a stream doing 0 would understate what the machine is doing.
    if (!Number.isFinite(rate) || rate <= 0) continue;
    activeStreams++;
    aggregateTokPerSec += rate;
  }

  return {
    activeStreams,
    aggregateTokPerSec: Math.round(aggregateTokPerSec * 100) / 100,
    parallelSlots,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --test test/runStats.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/runStats.ts backend/test/runStats.test.ts
git commit -m "feat(stats): aggregate throughput across running streams"
```

---

### Task 3: Retry classification (pure)

**Files:**
- Create: `backend/src/retryPolicy.ts`
- Test: `backend/test/retryPolicy.test.ts`

**Interfaces:**
- Produces:
  - `export const MAX_AUTO_ATTEMPTS = 2`
  - `export function isRetryableHint(hintKey: string | undefined): boolean`
  - `export function shouldAutoRetry(opts: { hintKey?: string; attempts?: number }): boolean`

- [ ] **Step 1: Write the failing test**

Create `backend/test/retryPolicy.test.ts`:

```ts
// A chapter that failed transiently should try again by itself. One that failed
// for a reason which will recur identically should not — retrying a missing
// model file just burns time and fills the log.
//
// The hintKey values come from diagnoseEngineExit in logBus.ts; this classifies
// them rather than inventing a second error model.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_AUTO_ATTEMPTS,
  isRetryableHint,
  shouldAutoRetry,
} from "../src/retryPolicy.ts";

test("transient engine faults are retryable", () => {
  for (const k of [
    "log_hint_engine_crash_generic",
    "log_hint_engine_unreachable",
    "log_hint_timeout",
  ]) {
    assert.equal(isRetryableHint(k), true, `${k} should retry`);
  }
});

test("deterministic faults are not retryable", () => {
  for (const k of [
    "log_hint_model_missing",
    "log_hint_binary_missing",
    "log_hint_corrupt_model",
    "log_hint_context_too_large",
    "log_hint_oom",
    "log_hint_cancelled",
  ]) {
    assert.equal(isRetryableHint(k), false, `${k} must not retry`);
  }
});

test("unknown and missing hints are not retried", () => {
  // A chapter quietly retrying forever on an unrecognised fault is worse than
  // one that stops and says so.
  assert.equal(isRetryableHint("something_new"), false);
  assert.equal(isRetryableHint(undefined), false);
});

test("retries stop after the attempt budget", () => {
  assert.equal(MAX_AUTO_ATTEMPTS, 2);
  const hintKey = "log_hint_timeout";
  assert.equal(shouldAutoRetry({ hintKey, attempts: 0 }), true);
  assert.equal(shouldAutoRetry({ hintKey, attempts: 1 }), true);
  assert.equal(shouldAutoRetry({ hintKey, attempts: 2 }), false);
  assert.equal(shouldAutoRetry({ hintKey, attempts: 99 }), false);
});

test("a non-retryable hint is never retried regardless of attempts", () => {
  assert.equal(
    shouldAutoRetry({ hintKey: "log_hint_model_missing", attempts: 0 }),
    false,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/retryPolicy.test.ts`
Expected: FAIL — `Cannot find module '../src/retryPolicy.ts'`

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/retryPolicy.ts`:

```ts
// ── Automatic chapter retry policy ──
//
// Classifies the hintKey values diagnoseEngineExit (logBus.ts) already produces.
// Pure and dependency-free so the policy can be tested on its own.

/** Automatic attempts after the first failure — 3 runs in total. */
export const MAX_AUTO_ATTEMPTS = 2;

/**
 * Faults worth another go: the engine died, went unreachable, or stalled. A
 * fresh load usually clears them.
 *
 * Everything else is deterministic and would fail identically — a missing or
 * corrupt model, a missing binary, a context that does not fit, or a machine
 * that just ran out of memory (retrying that makes it worse, not better).
 * Cancellation is the user's decision. Unrecognised hints are not retried.
 */
const RETRYABLE = new Set([
  "log_hint_engine_crash_generic",
  "log_hint_engine_unreachable",
  "log_hint_timeout",
]);

export function isRetryableHint(hintKey: string | undefined): boolean {
  return hintKey != null && RETRYABLE.has(hintKey);
}

export function shouldAutoRetry(opts: {
  hintKey?: string;
  attempts?: number;
}): boolean {
  if (!isRetryableHint(opts.hintKey)) return false;
  return (opts.attempts ?? 0) < MAX_AUTO_ATTEMPTS;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --test test/retryPolicy.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add backend/src/retryPolicy.ts backend/test/retryPolicy.test.ts
git commit -m "feat(queue): classify which chapter failures are worth retrying"
```

---

### Task 4: Cap parallel slots by memory architecture

**Files:**
- Modify: `backend/src/llamaServer.ts` (`detectParallelSlots`, around line 360; add exports)
- Test: `backend/test/parallelSlots.test.ts`

**Interfaces:**
- Produces:
  - `export function slotCapFor(platform: string, arch: string): number`
  - `export function getCurrentParallelSlots(): number` — live slot count for `runStats`, 0 when no engine is loaded.

- [ ] **Step 1: Write the failing test**

Create `backend/test/parallelSlots.test.ts`:

```ts
// Decode on unified memory is bandwidth-bound: extra slots divide throughput
// rather than add it. Measured on an M1 Pro — 20.9 tok/s single-stream vs ~17.4
// aggregate across 3 slots. Slots earn their keep by overlapping prefill, and
// the second one captures most of that.

import { test } from "node:test";
import assert from "node:assert/strict";

import { slotCapFor } from "../src/llamaServer.ts";

test("Apple Silicon caps at 2", () => {
  assert.equal(slotCapFor("darwin", "arm64"), 2);
});

test("Intel Macs and other platforms keep 3", () => {
  assert.equal(slotCapFor("darwin", "x64"), 3);
  assert.equal(slotCapFor("linux", "x64"), 3);
  assert.equal(slotCapFor("win32", "x64"), 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/parallelSlots.test.ts`
Expected: FAIL — `slotCapFor is not a function`

- [ ] **Step 3: Write minimal implementation**

In `backend/src/llamaServer.ts`, add above `detectParallelSlots`:

```ts
/**
 * Ceiling on concurrent slots for this machine.
 *
 * On unified memory (Apple Silicon) decode is bandwidth-bound, so a third slot
 * subtracts from every other stream instead of adding capacity — measured at
 * ~17.4 tok/s aggregate across 3 slots against 20.9 single-stream on an M1 Pro.
 * The second slot still pays for itself by overlapping prefill.
 *
 * Uses the same platform test as detectNGL above, so the two cannot disagree
 * about what machine they are on.
 */
export function slotCapFor(platform: string, arch: string): number {
  return platform === "darwin" && arch === "arm64" ? 2 : 3;
}
```

Then inside `detectParallelSlots`, replace:

```ts
  const hardwareCap = Math.max(
    1,
    Math.min(3, ramSlots, cpuSlots, vramSlots),
  );
```

with:

```ts
  const hardwareCap = Math.max(
    1,
    Math.min(
      slotCapFor(process.platform, process.arch),
      ramSlots,
      cpuSlots,
      vramSlots,
    ),
  );
```

Also add, next to `getCurrentModel`:

```ts
/** Slots the running engine was launched with; 0 when nothing is loaded. */
export function getCurrentParallelSlots(): number {
  return currentParallelSlots ?? 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --test test/parallelSlots.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 5: Verify nothing else regressed, then commit**

Run: `cd backend && npm test`
Expected: all tests pass, 0 failures

```bash
git add backend/src/llamaServer.ts backend/test/parallelSlots.test.ts
git commit -m "feat(engine): cap parallel slots at 2 on unified memory"
```

---

### Task 5: Retry failed chapters automatically

**Files:**
- Modify: `backend/src/types.ts` (add `attempts` to `TaskState`)
- Modify: `backend/src/queue.ts` (task-level failure path, around line 2473)

**Interfaces:**
- Consumes: `shouldAutoRetry`, `MAX_AUTO_ATTEMPTS` from `./retryPolicy.js`.
- Produces: `TaskState.attempts?: number` — automatic attempts already spent.

- [ ] **Step 1: Add the field**

In `backend/src/types.ts`, inside `TaskState`, after `tokPerSec?: string;`:

```ts
  /** Automatic retries already spent on this task (see retryPolicy.ts). */
  attempts?: number;
```

- [ ] **Step 2: Wire the retry**

In `backend/src/queue.ts`, add the import near the other local imports:

```ts
import { shouldAutoRetry, MAX_AUTO_ATTEMPTS } from "./retryPolicy.js";
```

At the task-level failure site (the `status: "error"` assignment around line
2473 — the one that marks a whole chapter failed, not the chunk-level one at
line 544), replace the unconditional failure with:

```ts
        const attempts = t.attempts ?? 0;
        if (shouldAutoRetry({ hintKey, attempts }) && t.retrySpec) {
          // Reset in place rather than calling retryTask(), which mints a NEW
          // task id. A new task would leave the job holding both the failed
          // original and its replacement, double-counting that chapter's words
          // in the progress denominator.
          updateTask(t.id, {
            status: "queued",
            progress: 0,
            attempts: attempts + 1,
            phase: `retry ${attempts + 1}/${MAX_AUTO_ATTEMPTS}`,
          });
          appendLog({
            level: "warn",
            source: "engine",
            taskId: t.id,
            message: `${t.name} failed (${hintKey ?? "unknown"}) — retrying, attempt ${attempts + 1} of ${MAX_AUTO_ATTEMPTS}`,
          });
          pending.push(t.id);
          broadcast();
          return;
        }
```

immediately before the existing code that sets `status: "error"`.

> A task with no `retrySpec` cannot be re-run, so it falls through to the
> permanent failure path rather than looping on a retry it has no way to
> perform.

- [ ] **Step 3: Verify cancellation still wins**

Confirm `cancelJob` / `cancelAll` remove ids from `pending`. A retry pushes the
task back onto `pending`, so a cancelled job must not resurrect itself.

Run: `cd backend && grep -n "pending = pending.filter\|pending.length = 0" src/queue.ts`
Expected: at least one match in the cancel paths.

- [ ] **Step 4: Build and test**

Run: `cd backend && npm run build && npm test`
Expected: compiles clean, all tests pass

- [ ] **Step 5: Commit**

```bash
git add backend/src/types.ts backend/src/queue.ts
git commit -m "feat(queue): retry transiently-failed chapters in place"
```

---

### Task 6: Broadcast the stats and log progress

**Files:**
- Modify: `backend/src/queue.ts` (`flushBroadcast`, plus a throttled log line)

**Interfaces:**
- Consumes: `computeJobProgress`, `computeRuntime` from `./runStats.js`; `getCurrentParallelSlots` from `./llamaServer.js`.
- Produces: socket event `run:stats` with `{ jobProgress: Record<string, JobProgress>; runtime: RuntimeStats }`.

- [ ] **Step 1: Emit the event**

In `backend/src/queue.ts`, import:

```ts
import { computeJobProgress, computeRuntime } from "./runStats.js";
import { getCurrentParallelSlots } from "./llamaServer.js";
```

In `flushBroadcast`, after the existing `queue:update` emit, add:

```ts
  // Separate event so the queue:update contract (Record<id, ClientTaskState>)
  // stays untouched.
  const all = [...tasks.values()];
  io.emit("run:stats", {
    jobProgress: computeJobProgress(all),
    runtime: computeRuntime(all, getCurrentParallelSlots()),
  });
  maybeLogProgress(all);
```

- [ ] **Step 2: Add the throttled log line**

Add near the other module-level state in `queue.ts`:

```ts
let lastProgressLogAt = 0;
const PROGRESS_LOG_INTERVAL_MS = 30_000;

/**
 * One progress line per 30s, globally — the Diagnostics feed is a single ring
 * buffer that users read after the fact, and per-tick lines would push
 * everything else out of it.
 */
function maybeLogProgress(all: TaskState[]): void {
  try {
    const running = all.some((t) => t.status === "editing");
    if (!running) return;
    const now = Date.now();
    if (now - lastProgressLogAt < PROGRESS_LOG_INTERVAL_MS) return;
    lastProgressLogAt = now;

    const progress = computeJobProgress(all);
    const runtime = computeRuntime(all, getCurrentParallelSlots());

    for (const [jobId, p] of Object.entries(progress)) {
      if (p.fraction >= 1 && p.failed === 0) continue;
      const pct = Math.round(p.fraction * 100);
      const words = p.wordsTotal
        ? ` (${p.wordsDone.toLocaleString()} of ${p.wordsTotal.toLocaleString()} words)`
        : "";
      const rate = runtime.activeStreams
        ? ` · ${runtime.aggregateTokPerSec} tok/s across ${runtime.activeStreams} stream${runtime.activeStreams === 1 ? "" : "s"}`
        : "";
      const failed = p.failed
        ? ` · ${p.failed} chapter${p.failed === 1 ? "" : "s"} failed`
        : "";
      appendLog({
        level: "info",
        source: "engine",
        message: `Job progress: ${pct}%${words}${rate}${failed}`,
        jobId,
      });
    }
  } catch {
    // Best effort — a stats failure must never interrupt a run.
  }
}
```

> If `appendLog`'s entry type has no `jobId` field, drop that property; the job
> is identifiable from the message when several are active.

- [ ] **Step 3: Build and test**

Run: `cd backend && npm run build && npm test`
Expected: compiles clean, all tests pass

- [ ] **Step 4: Verify by hand**

Run: `cd backend && LANGUAGETOOL_DISABLED=1 npx tsx src/index.ts`, then in another
shell `curl -s localhost:4000/api/logs`. With no job running, expect no
`Job progress:` lines (the throttle only emits while work is active).

- [ ] **Step 5: Commit**

```bash
git add backend/src/queue.ts
git commit -m "feat(queue): broadcast run stats and log job progress"
```

---

### Task 7: Show it in the UI

**Files:**
- Modify: `frontend/src/types.ts` (add `JobProgress`, `RuntimeStats`, `attempts`)
- Modify: `frontend/src/store.ts` (transient `runStats` state — NOT persisted)
- Modify: `frontend/src/App.tsx:115` (socket listener)
- Modify: `frontend/src/components/BettyWorking.tsx` (bar + throughput)
- Modify: `frontend/src/i18n.ts` (four languages)
- Modify: `frontend/src/styles/global.css`

**Interfaces:**
- Consumes: socket event `run:stats` from Task 6.

- [ ] **Step 1: Add types**

Append to `frontend/src/types.ts`:

```ts
export interface JobProgress {
  fraction: number;
  wordsDone: number;
  wordsTotal: number;
  failed: number;
}

export interface RuntimeStats {
  activeStreams: number;
  aggregateTokPerSec: number;
  parallelSlots: number;
}
```

Add `attempts?: number;` to the frontend `TaskState` interface.

- [ ] **Step 2: Add transient store state**

In `frontend/src/store.ts`, add to the interface and the initial state:

```ts
  runStats: { jobProgress: Record<string, JobProgress>; runtime: RuntimeStats } | null;
  setRunStats: (s: AppState["runStats"]) => void;
```

```ts
      runStats: null,
      setRunStats: (runStats) => set({ runStats }),
```

Do **not** add `runStats` to `partialize` — it is live data, not a setting.

- [ ] **Step 3: Listen for the event**

In `frontend/src/App.tsx`, beside the existing `queue:update` handler:

```tsx
    socket.on("run:stats", (data: NonNullable<typeof runStats>) => {
      setRunStats(data);
    });
```

and in the cleanup beside `socket.off("queue:update")`:

```tsx
      socket.off("run:stats");
```

- [ ] **Step 4: Add the i18n keys**

In `frontend/src/i18n.ts`:

```ts
  run_progress_label: {
    en: "Overall progress",
    da: "Samlet fremgang",
    de: "Gesamtfortschritt",
    es: "Progreso total",
  },
  run_throughput: {
    en: "{rate} tok/s total · {streams} streams",
    da: "{rate} tok/s i alt · {streams} strømme",
    de: "{rate} Tok/s gesamt · {streams} Ströme",
    es: "{rate} tok/s en total · {streams} flujos",
  },
  run_chapters_failed: {
    en: "{count} chapter(s) failed",
    da: "{count} kapitel(er) mislykkedes",
    de: "{count} Kapitel fehlgeschlagen",
    es: "{count} capítulo(s) fallaron",
  },
```

- [ ] **Step 5: Render the bar**

In `frontend/src/components/BettyWorking.tsx`, inside the working view, using the
same markup shape as `ModelDownloadStrip.tsx`:

```tsx
{(() => {
  const stats = useStore.getState().runStats;
  const jobId = Object.values(tasks).find(
    (t) => t.status === "queued" || t.status === "editing",
  )?.jobId;
  const p = jobId ? stats?.jobProgress?.[jobId] : undefined;
  if (!p) return null;
  const pct = Math.round(p.fraction * 100);
  const rt = stats?.runtime;
  return (
    <div className="run-progress">
      <div className="run-progress-head">
        <span>{t("run_progress_label")}</span>
        <span>{pct}%</span>
      </div>
      <div
        className="run-progress-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="run-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="run-progress-sub">
        {rt && rt.activeStreams > 0 &&
          t("run_throughput")
            .replace("{rate}", String(rt.aggregateTokPerSec))
            .replace("{streams}", String(rt.activeStreams))}
        {p.failed > 0 &&
          ` · ${t("run_chapters_failed").replace("{count}", String(p.failed))}`}
      </div>
    </div>
  );
})()}
```

- [ ] **Step 6: Style it**

Append to `frontend/src/styles/global.css`, matching the parchment palette:

```css
/* ── Overall run progress (mirrors the model download bar) ── */
.run-progress {
  margin: 0.5rem 0 0.75rem;
}
.run-progress-head {
  display: flex;
  justify-content: space-between;
  font-size: 0.8rem;
  color: #6b5d47;
  margin-bottom: 0.25rem;
}
.run-progress-track {
  height: 6px;
  border-radius: 999px;
  background: #e6dcc6;
  overflow: hidden;
}
.run-progress-fill {
  height: 100%;
  background: #8a7050;
  transition: width 0.4s ease;
}
.run-progress-sub {
  font-size: 0.76rem;
  color: #8a7c64;
  margin-top: 0.25rem;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 7: Build and verify in the app**

Run: `cd frontend && npm run build`
Expected: compiles clean

Then `npm run dev`, upload a short multi-chapter document, start a run, and
confirm: the bar advances, the throughput line reads a total with a stream
count, and a `Job progress:` line appears in Diagnostics at most twice a minute.

- [ ] **Step 8: Commit**

```bash
git add frontend/src backend/public
git commit -m "feat(ui): overall run progress bar and honest throughput"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| 1. Honest throughput (`runtime` block, both surfaces) | 2, 6, 7 |
| 2. Auto-fit slots (cap 2 / 3, same platform test) | 4 |
| 3. Job progress (word-weighted, failures below 100%) | 1, 6, 7 |
| 4. Auto-retry (classification, 2 attempts, in place) | 3, 5 |
| Error handling (no streams, no `tokPerSec`, zero words, best-effort log, missing `retrySpec`, cancellation) | 1, 2, 5, 6 |
| Testing (progress maths, classification, slot cap, aggregation) | 1, 2, 3, 4 |

**Deviation from spec, deliberate:** no `awaiting-retry` `TaskStatus`; retries reuse
`"queued"` plus `attempts`. Rationale in Global Constraints. The spec should be
updated to match so the two do not drift.

**Type consistency:** `JobProgress` and `RuntimeStats` are defined in Task 1/2 and
re-declared identically in the frontend in Task 7. `computeJobProgress` and
`computeRuntime` keep the same names and signatures throughout.
`getCurrentParallelSlots` is defined in Task 4 and consumed in Task 6.
