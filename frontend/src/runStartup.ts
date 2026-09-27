// ── A run that has started but produced nothing yet ──
//
// A cloud run begins by waking a serverless model (see warmUpApiEndpoint in
// backend/src/queue.ts), and until its first words come back every chapter is
// "editing" at 0%: the bar stands still, there is no time left to show, and
// the chapter count does not move. On a cold start that lasts long enough to
// read as broken. A local run loading its model has the same stretch.
//
// While nothing has come back, the run panel and the rail show one of these
// messages over a bar that sweeps rather than one pinned at zero. The message
// advances with the time since the run started, so the screen visibly moves
// on — and all of it gives way to the ordinary percentage the moment there
// is any. Pure, and tested from backend/test/runStartup.test.ts.

export type StartupStage =
  | "run_start_cloud"
  | "run_start_local"
  | "run_start_wake"
  | "run_start_warm"
  | "run_start_long";

/** When each message takes over, in seconds since the run started. */
const WAKE_AFTER = 10;
const WARM_AFTER = 30;
const LONG_AFTER = 75;

export function startupStage({
  fraction,
  cloud,
  startedAt,
  now,
}: {
  /** The run's progress, 0-1 — the same figure the bar shows. */
  fraction: number;
  /** Betty in the cloud, rather than a model on this computer. */
  cloud: boolean;
  startedAt: number;
  now: number;
}): StartupStage | null {
  if (fraction > 0) return null;
  const seconds = Math.max(0, (now - startedAt) / 1000);
  if (seconds >= LONG_AFTER) return "run_start_long";
  if (seconds >= WARM_AFTER) return "run_start_warm";
  if (seconds >= WAKE_AFTER) return "run_start_wake";
  return cloud ? "run_start_cloud" : "run_start_local";
}

/** When a run began: its earliest task's submission. */
export function runStartedAt(tasks: { submittedAt?: number }[]): number | null {
  const times = tasks.map((task) => task.submittedAt).filter((t): t is number => t != null);
  return times.length > 0 ? Math.min(...times) : null;
}

/** Whether a task runs on Betty in the cloud. */
export const isCloudModel = (model?: string): boolean => !!model?.includes("bethaniel-cloud");
