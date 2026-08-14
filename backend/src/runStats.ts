// ── Derived run statistics ──
//
// Pure module, like snapshot.ts: takes plain TaskState values and returns plain
// data, so the maths can be tested without the stateful queue or the database.

import type { TaskState } from "./types.js";

/**
 * Tasks that ride along on a job but are not chapters. Excluded from progress
 * so a pending summary cannot hold the bar below 100%. Mirrors the list
 * CurrentRunHeader.tsx has always used — the two must agree, or the bar and the
 * log line would report different numbers for the same job.
 */
const META_MODES = new Set(["analysis_summary", "blurb", "text_evaluator"]);

export interface JobProgress {
  /** 0..1, share of the job's words successfully edited. */
  fraction: number;
  wordsDone: number;
  wordsTotal: number;
  /** Permanently failed tasks — the reason `fraction` may never reach 1. */
  failed: number;
  /** Tasks the user stopped. Their own decision, not a fault to report back. */
  cancelled: number;
  /**
   * Nothing queued and nothing in flight: the run is over, however it ended.
   *
   * Without this a finished job's row is indistinguishable from a live one, and
   * a run stopped at 70% reads as a run stuck at 70%.
   */
  settled: boolean;
}

export interface RuntimeStats {
  /** Tasks currently producing tokens. */
  activeStreams: number;
  /** Sum of the running streams' rates — what the machine is really doing. */
  aggregateTokPerSec: number;
  /** Slots llama-server was actually launched with. */
  parallelSlots: number;
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
  for (const [jobId, all] of byJob) {
    // Fall back to the full list for jobs that are *only* meta tasks, so such a
    // job still reports rather than vanishing.
    const chapters = all.filter((t) => !META_MODES.has(t.mode));
    const list = chapters.length > 0 ? chapters : all;

    const wordsTotal = list.reduce((n, t) => n + (t.wordCount || 0), 0);
    const failed = list.filter((t) => t.status === "error").length;
    const cancelled = list.filter((t) => t.status === "cancelled").length;
    // Judged over ALL the job's tasks, including meta ones: a pending summary
    // still means the run is going, even though it is excluded from the bar.
    const settled = !all.some(
      (t) => t.status === "queued" || t.status === "editing",
    );

    if (wordsTotal === 0) {
      // Analysis-only jobs can carry no word counts. Fall back to task count
      // rather than dividing by zero.
      const done = list.reduce((n, t) => n + editedFraction(t), 0);
      out[jobId] = {
        fraction: list.length ? done / list.length : 0,
        wordsDone: 0,
        wordsTotal: 0,
        failed,
        cancelled,
        settled,
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
      cancelled,
      settled,
    };
  }
  return out;
}

/**
 * Only the runs that are actually running.
 *
 * Diagnostics shows a live readout, not a history: a finished job's row sitting
 * in the panel at 70% is indistinguishable from a stalled one. This resets it
 * at the end of a run, and — because initQueue rewrites interrupted tasks to
 * cancelled when it hydrates — on restart too, with the same rule.
 */
export function liveJobProgress(
  tasks: Iterable<TaskState>,
): Record<string, JobProgress> {
  const all = computeJobProgress(tasks);
  const out: Record<string, JobProgress> = {};
  for (const [jobId, p] of Object.entries(all)) {
    if (!p.settled) out[jobId] = p;
  }
  return out;
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
