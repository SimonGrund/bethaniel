# Honest throughput, auto-fitted slots, and overall job progress

**Date:** 2026-08-08
**Status:** Approved, ready for implementation planning

## Context

A user watching a real run saw "6 tokens per second" and reasonably concluded
something was broken. Nothing was. Three llama-server slots were decoding
concurrently:

```
slot 2 | task 619 | n_decoded = 780  | tg = 6.47 t/s
slot 0 | task 3   | n_decoded = 1384 | tg = 5.18 t/s
slot 1 | task 98  | n_decoded = 1296 | tg = 5.73 t/s
```

That is ~17.4 tok/s aggregate. The same model measured **20.9 tok/s**
single-stream on the same machine (M1 Pro, 32 GB), with `-ngl 999`, no swap and
69% memory free — so the engine was healthy and near its ceiling. The UI simply
reported each stream's share without saying there were three of them.

Two further problems surfaced from the same investigation:

1. Decode on unified memory is **bandwidth-bound**. Three slots produced *less*
   total decode throughput than one (17.4 vs 20.9). Slots earn their keep by
   overlapping prefill, not by adding decode capacity — so the current cap of 3
   is wrong for Apple Silicon.
2. During a 76-task run there was no way to see how far along the job was. The
   only signal was a queue list, and the Diagnostics history kept nothing about
   pace — which is precisely what was missing when trying to diagnose a slow run
   after the fact.

## Goals

- Report throughput in a way that cannot be misread.
- Choose a slot count suited to the machine's memory architecture.
- Show overall job progress live, and leave a record of it in the log.

## Non-goals

- Adaptive/self-calibrating slot selection. Considered and explicitly rejected in
  favour of a predictable static policy (see Alternatives).
- Changing chunking, run modes, or the reviewer pipeline.
- Making the 9B faster. It is bandwidth-bound on this hardware; that is physics,
  not a bug.

## Design

### 1. Honest throughput

`tokPerSec` on `TaskState` (`backend/src/types.ts`) is **per stream**, computed
per task at `backend/src/queue.ts:1712`. It stays as-is — it is correct at task
scope and the queue panel shows it per task.

Add a `runtime` block to the queue snapshot (`backend/src/snapshot.ts`):

```ts
runtime: {
  activeStreams: number;        // tasks currently `editing`
  aggregateTokPerSec: number;   // sum of their tokPerSec
  parallelSlots: number;        // what llama-server was actually launched with
}
```

Computed once in the backend rather than derived in the frontend. The backend
already owns the Diagnostics feed, so deriving it in both places would mean two
implementations that can disagree; one source of truth means the bar and the log
line cannot contradict each other.

Rendered in both surfaces as:

```
17.2 tok/s total · 3 streams
```

`parallelSlots` comes from the live supervisor state
(`backend/src/llamaServer.ts` already tracks `currentParallelSlots`).

### 2. Auto-fit the slot count

In `detectParallelSlots` (`backend/src/llamaServer.ts`), replace the flat
`Math.min(3, ...)` cap with one that depends on memory architecture:

| Machine | Cap | Why |
|---|---|---|
| Unified memory (Apple Silicon) | **2** | Decode is bandwidth-bound; extra slots divide throughput rather than add it. The second slot captures most of the prefill-overlap benefit. |
| Everything else | **3** | KV caches live in their own memory; the trade-off differs. |

"Unified memory" is detected with the same test `detectNGL` already uses in this
file — `process.platform === "darwin" && process.arch === "arm64"` — rather than
a new heuristic, so the two functions cannot disagree about what machine they are
on.

Unchanged:

- Never allocate more slots than there are queued tasks (`desiredSlots`).
- The existing RAM / CPU / VRAM fits still apply — this only lowers the ceiling.
- The advanced-settings `parallel` override still wins.

**Known limitation, deliberately accepted:** this cap is calibrated on a single
machine (M1 Pro, 32 GB). It is a defensible default, not a measured law across
the Apple Silicon range — an M3 Max has substantially more memory bandwidth and
might well do better with 3. The adaptive alternative would have discovered that
per-machine; predictability was chosen over self-tuning. If this proves wrong on
other hardware, the follow-up is Alternative A below.

### 3. Overall job progress

Weighted by words, per job:

The bar measures **words successfully edited**, not words no longer pending:

```
progress = Σ(task.wordCount × fraction) / Σ(task.wordCount)

fraction = 1                 for done
         = task.progress     for editing    (existing 0..1)
         = 0                 for queued, awaiting-retry, error, cancelled
```

`wordCount` is already on `TaskState`. A permanently failed chapter therefore
holds the bar **below 100%** — deliberately. The job is not finished if a chapter
did not get edited, and a bar that reads 100% over a failed chapter tells the
user the opposite of the truth. The shortfall is the point.

Because a bar stuck at 94% is only useful if you can see why, the run view and
the log line both name the count:

```
94% · 2 chapters failed
```

Cancelled tasks also count 0 for the same reason — the words were not edited —
but the user cancelled deliberately, so this needs no extra signalling beyond the
existing task status.

Weighting by words rather than task count matters because chapter lengths vary
several-fold; a task-count bar stalls on long chapters and races through short
ones.

Exposed on the snapshot as `jobProgress: Record<jobId, number>` (0..1) alongside
`runtime`, so a snapshot covering several jobs carries a figure for each rather
than one blended number. The run view shows the entry for the job it is
displaying.

### 4. Automatic retry of failed chapters

A chapter that fails for a transient reason should try again by itself. One that
fails for a reason which will recur identically should not — retrying a missing
model file just burns time and fills the log.

**Classification** reuses the `hintKey` taxonomy `diagnoseEngineExit` already
produces (`backend/src/logBus.ts`). No new error model:

| Retry | `hintKey` | Reasoning |
|---|---|---|
| yes | `log_hint_engine_crash_generic` | The engine died; a fresh load usually works. |
| yes | `log_hint_engine_unreachable` | Supervisor restart or a lost socket. |
| yes | `log_hint_timeout` | Slow load or a stalled request. |
| no | `log_hint_model_missing` | Deterministic. Needs a download. |
| no | `log_hint_binary_missing` | Deterministic. Broken install. |
| no | `log_hint_corrupt_model` | Deterministic. Needs a re-download. |
| no | `log_hint_context_too_large` | Recurs identically with the same settings. |
| no | `log_hint_oom` | Retrying a machine that just ran out of memory makes it worse, not better. |
| no | `log_hint_cancelled` | The user's decision. |

Anything unrecognised is treated as **not** retryable: a chapter that quietly
retries forever on an unknown fault is worse than one that stops and says so.

**Policy.** Up to **2** automatic attempts after the first failure (3 runs
total), with the existing backoff style — the queue already does this at chunk
level (`queue.ts:594`) and for reviewer calls, so this is the same idea one level
up. Between attempts the task sits in an `awaiting-retry` state, visible in the
queue with `retry 1/2`, and counts 0 toward progress since its words are not yet
edited.

**In place, not as a new task.** `retryTask` (`queue.ts:2733`) mints a *new* task
id, which is right for the manual "retry" button but wrong here: the job would
then hold both the failed original and its replacement, double-counting that
chapter's words and skewing the very progress figure this design adds. Automatic
retry instead resets the existing task — status back to queued, attempt counter
incremented — so a chapter stays one row with one word count however many times
it is tried. The manual button keeps its current behaviour.

Attempts are tracked with a new `attempts?: number` on `TaskState`, alongside the
existing `retrySpec` that already carries everything needed to re-run.

#### Surfaces

**`frontend/src/components/BettyWorking.tsx`** — a progress bar reusing the
visual language of `ModelDownloadStrip.tsx` (percentage label, `role="progressbar"`
with `aria-valuenow`, width-driven fill), plus the throughput line.

**Diagnostics feed** — a periodic line via `appendLog`:

```
Job progress: 42% (31,400 of 74,900 words) · 17.2 tok/s across 3 streams
Job progress: 94% (70,300 of 74,900 words) · 2 chapters failed
```

Throttled globally to **at most one line per 30 s** across all jobs (not per
job — the feed is a single shared stream), and emitted only while at least one
task is running. The Diagnostics feed is a ring buffer that users read after the
fact; unthrottled per-chunk lines would push everything else out of it. When
several jobs are active the line names the job it refers to.

## Error handling

- No active streams → `aggregateTokPerSec: 0`, `activeStreams: 0`; surfaces hide
  the throughput line rather than printing "0 tok/s".
- A task with no `tokPerSec` yet (before its first token) contributes 0 and is
  not counted as an active stream, so the average is not dragged down at start.
- `Σ wordCount === 0` (possible for analysis-only jobs) → fall back to
  task-count progress rather than dividing by zero.
- The progress log line is best-effort: a failure to compute it must never
  interrupt the run.
- A task whose `retrySpec` is missing cannot be re-run; it fails permanently
  rather than looping on a retry it has no way to perform.
- Automatic retries do not reset the queue's own cancellation: cancelling a job
  must stop pending retries too, or a cancelled job would resurrect itself.

## Testing

Backend (`backend/test/`, node:test via tsx — the existing pattern):

- `jobProgress`: word-weighted maths; a long chapter moves the bar more than a
  short one; a permanently failed chapter holds the total below 100%; a chapter
  that fails and then succeeds on retry reaches 100% and is counted once, not
  twice; zero-word job falls back to task count; empty job does not divide by
  zero.
- Retry classification: each `hintKey` maps to the retry decision in the table
  above; an unrecognised key is not retried.
- Retry policy: stops after 2 automatic attempts; a task retried in place keeps
  its id and word count; a non-retryable failure is not retried at all.
- `detectParallelSlots`: unified memory caps at 2, discrete GPU at 3, queue depth
  still narrows both, existing RAM/CPU/VRAM fits still bind.
- `runtime` aggregation: sums only `editing` tasks; ignores tasks without a
  `tokPerSec` yet.

The throttle and the UI have no automated coverage — the frontend has no test
setup. Verify the bar and the log cadence by running a multi-chapter job.

## Alternatives considered

**A. Measure and adapt.** Record aggregate tok/s per (model, slot count) using
the existing `recordThroughputSample` / `ThroughputProfile` plumbing and converge
on the fastest. Genuinely self-tuning and would have found the 3-vs-1 result
without being told. Rejected for now: needs a deliberate try-another-count step,
so early jobs are exploratory and pace varies run to run.

**B. One-off calibration at model load.** Benchmark 1/2/3 slots on first load and
cache the winner per model+machine. Accurate and settles immediately, but adds
30–60 s to an already slow cold start.

**C. Frontend-derived numbers.** Zero new plumbing, but the Diagnostics line is
written backend-side, so the calculation would exist twice and drift.
