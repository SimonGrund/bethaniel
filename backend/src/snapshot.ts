// ── Client-facing task snapshots ──
// The full TaskState carries megabytes of payload per task (retrySpec embeds
// the chapter text; result embeds original/edited text plus every correction).
// Broadcasting that on every queue:update made the socket ship the entire run
// history per progress tick. Client snapshots strip the heavy fields and
// replace `result` with a count summary; the frontend hydrates full results
// lazily via GET /queue/job/:jobId/results / /queue/task/:taskId/result.
//
// Pure module (types only) so tests can exercise the shaping without touching
// the stateful queue or the database.

import type { TaskState, TaskResult } from "./types.js";

export interface ResultMeta {
  corrections: number;
  skipped: number;
  errors: number;
  hasStructured: boolean;
  hasText: boolean;
}

export type ClientTaskState = Omit<
  TaskState,
  "retrySpec" | "analysisCheckpoint"
> & {
  resultMeta: ResultMeta | null;
};

export function makeResultMeta(
  result: TaskResult | null | undefined,
): ResultMeta | null {
  if (!result) return null;
  return {
    corrections: result.corrections?.length ?? 0,
    skipped: result.skipped?.length ?? 0,
    errors: result.errors?.length ?? 0,
    hasStructured: result.structuredData != null,
    hasText: Boolean(result.editedText || result.originalText),
  };
}

export function shapeClientTask(task: TaskState): ClientTaskState {
  const { retrySpec: _r, analysisCheckpoint: _c, result, ...rest } = task;
  return { ...rest, result: null, resultMeta: makeResultMeta(result) };
}

export function buildClientSnapshot(
  tasks: Iterable<TaskState>,
): Record<string, ClientTaskState> {
  const snap: Record<string, ClientTaskState> = {};
  for (const t of tasks) snap[t.id] = shapeClientTask(t);
  return snap;
}
