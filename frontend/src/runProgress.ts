// ── How far through a run we are ──
//
// One answer, computed one way, for every bar that shows it.
//
// There were two. The rail averaged each task's progress unweighted, so a
// 300-word title page counted for as much as a 5,000-word chapter; Betty's
// panel used the backend's word-weighted figure. On a book with uneven
// chapters the two bars disagreed by a wide margin, and the one in the rail
// was the wrong one.
//
// The weighting is what makes the number mean anything: a task's `progress`
// is tokens emitted over tokens estimated for it, so weighting by word count
// turns per-task token progress into progress through the run's whole token
// cost. An unweighted mean answers "how far through the chapter list", which
// moves in steps and stalls for minutes inside a long chapter.
//
// Mirrors backend/src/runStats.ts — computeJobProgress is the authority while
// a job is live, and this must not disagree with it when it takes over.

import type { TaskState } from "./types";

/** Tasks that are about the run rather than part of it; excluded from the bar. */
const META_MODES = new Set(["analysis_summary", "blurb", "text_evaluator"]);

/**
 * How much of a task's words count as edited. Only `done` counts fully —
 * a failed or cancelled chapter counts zero, because its words were never
 * edited and a bar reading full over a failed chapter says the opposite of
 * the truth.
 */
function editedFraction(task: TaskState): number {
  if (task.status === "done") return 1;
  if (task.status === "editing")
    return Math.min(1, Math.max(0, task.progress ?? 0));
  return 0;
}

/**
 * Progress through a set of tasks, 0-1, weighted by each task's share of the
 * words. Falls back to a plain mean when no task carries a word count, which
 * is the analysis-only case.
 */
export function weightedProgress(tasks: TaskState[]): number {
  const chapters = tasks.filter((task) => !META_MODES.has(task.mode));
  const list = chapters.length > 0 ? chapters : tasks;
  if (list.length === 0) return 0;

  const wordsTotal = list.reduce((n, task) => n + (task.wordCount || 0), 0);
  if (wordsTotal === 0)
    return list.reduce((n, task) => n + editedFraction(task), 0) / list.length;

  const wordsDone = list.reduce(
    (n, task) => n + (task.wordCount || 0) * editedFraction(task),
    0,
  );
  return wordsDone / wordsTotal;
}

/** The same figure as a whole percentage, for display. */
export function progressPercent(fraction: number): number {
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}
