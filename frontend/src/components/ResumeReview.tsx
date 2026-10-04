// "Continue reviewing", on the dashboard.
//
// Leaving a review for the dashboard — its own Return button, or closing the
// app — files the run under Former Runs, and the dashboard then shows only a
// fresh setup. A user who had answered half the deck read that as the run
// being over, and the Run button as the way back in: it starts a new run. The
// answers were never lost (the decision log is persisted); the way back was
// just not on the page. This card is that way back, for the latest run only —
// older ones stay under Former Runs.
//
// Continuing moves the session boundary back to the run's start: the reverse
// of what Return to dashboard did, so the run is shown exactly as it was, and
// the deck picks up at the chapter it was left at (reviewCursor).

import { useMemo } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { EDIT_MODES } from "../types";
import type { TaskState } from "../types";
import { countUndecided } from "./ReviewDeck";
import { useResultHydration } from "../useResultHydration";

const TERMINAL = new Set(["done", "error", "cancelled"]);

export default function ResumeReview() {
  const lang = useStore((s) => s.lang);
  const tasks = useStore((s) => s.tasks);
  const decisionLog = useStore((s) => s.decisionLog);
  const showAllSuggestions = useStore((s) => s.showAllSuggestions);
  const setSessionStartedAt = useStore((s) => s.setSessionStartedAt);
  const t = useTranslation(lang);

  // The latest run, and only if it is one the deck reviews: finished, with
  // corrections to answer. A newer run of another kind (a translation, a
  // scan) means the edit run is no longer the last thing done, and bringing
  // it back would bring the newer one with it.
  const latest = useMemo(() => {
    const byJob = new Map<string, [string, TaskState][]>();
    for (const [tid, task] of Object.entries(tasks)) {
      const jid = task.jobId ?? "legacy";
      byJob.set(jid, [...(byJob.get(jid) ?? []), [tid, task]]);
    }
    let best: { jobId: string; entries: [string, TaskState][]; at: number } | null = null;
    for (const [jobId, entries] of byJob) {
      const at = Math.max(...entries.map(([, task]) => task.submittedAt ?? 0));
      if (!best || at > best.at) best = { jobId, entries, at };
    }
    if (!best) return null;
    const { entries } = best;
    if (!entries.every(([, task]) => TERMINAL.has(task.status))) return null;
    if (entries.some(([, task]) => task.mode === "publication_scan")) return null;
    // The same test that puts ReviewExport into deck mode.
    const edits = entries.filter(([, task]) => EDIT_MODES.includes(task.mode));
    if (edits.length === 0 || edits.some(([, task]) => task.mode === "translate")) return null;
    return {
      jobId: best.jobId,
      edits,
      source: edits[0][1].source,
      startedAt: Math.min(...entries.map(([, task]) => task.submittedAt ?? 0)),
    };
  }, [tasks]);

  // Counting needs the corrections themselves, which a snapshot does not
  // carry; fetch this one run's, the way opening it under Former Runs would.
  const eligible = useMemo(
    () => new Set(latest ? [latest.jobId] : []),
    [latest],
  );
  useResultHydration(tasks, eligible);

  if (!latest) return null;
  const hydrated = latest.edits.filter(([, task]) => task.result);
  // Not until every chapter is in: a partial count would understate what is left.
  if (hydrated.length < latest.edits.filter(([, task]) => task.resultMeta || task.result).length) {
    return null;
  }
  const { left, total } = countUndecided(hydrated, decisionLog, showAllSuggestions);
  if (left === 0) return null;

  return (
    <div className="resume-review" role="region" aria-label={t("resume_review_btn")}>
      <span className="resume-review-text">
        {t(total - left > 0 ? "resume_review_body_started" : "resume_review_body_new")
          .replace("{source}", latest.source)
          .replace("{left}", String(left))
          .replace("{total}", String(total))}
      </span>
      <button
        type="button"
        className="btn-primary btn-small"
        onClick={() => setSessionStartedAt(latest.startedAt)}
      >
        {t("resume_review_btn")}
      </button>
    </div>
  );
}
