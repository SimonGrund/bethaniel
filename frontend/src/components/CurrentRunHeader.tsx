// ── Current-run header card ──
// The "colophon" of the active job: overall weighted progress, chapter counts,
// live elapsed time, mode/model context, and a stop button. Rendered by
// ReviewExport above the job list for the current session (never for old
// results). Also the scroll target (#current-run-header) for the header
// working badge and the StepBar "View current run" button.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { cancelJob } from "../api";
import type { Lang, TaskState } from "../types";

// Meta tasks ride along on a job but aren't chapters — exclude them from the
// progress math so a pending summary doesn't hold the bar below 100%.
const META_MODES = new Set(["analysis_summary", "blurb", "text_evaluator"]);

interface CurrentRunHeaderProps {
  jobId: string;
  /** All tasks of the job, including queued ones. */
  jobTasks: TaskState[];
  modelNames: Record<string, string>;
  lang: Lang;
}

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export default function CurrentRunHeader({
  jobId,
  jobTasks,
  modelNames,
  lang,
}: CurrentRunHeaderProps) {
  const t = useTranslation(lang);
  const [now, setNow] = useState(Date.now());
  const [armed, setArmed] = useState(false);
  const [stopping, setStopping] = useState(false);

  const isActive = jobTasks.some(
    (task) => task.status === "queued" || task.status === "editing",
  );

  useEffect(() => {
    if (!isActive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isActive]);

  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);

  const chapters = jobTasks.filter((task) => !META_MODES.has(task.mode));
  const chapterTasks = chapters.length > 0 ? chapters : jobTasks;

  // Only `done` counts. A failed or cancelled chapter counts zero, so the bar
  // stays below 100% and the user can see the job did not fully succeed —
  // a bar reading 100% over a failed chapter says the opposite of the truth.
  const frac = (task: TaskState): number =>
    task.status === "done"
      ? 1
      : task.status === "editing"
        ? Math.min(Math.max(task.progress ?? 0, 0), 1)
        : 0;
  const weight = (task: TaskState): number => Math.max(task.wordCount ?? 0, 1);
  const totalWeight = chapterTasks.reduce((sum, task) => sum + weight(task), 0);
  const localOverall =
    chapterTasks.reduce((sum, task) => sum + weight(task) * frac(task), 0) /
    Math.max(totalWeight, 1);

  // Prefer the backend's figure while the job is live: it is the same number
  // the diagnostics log line reports, so the two cannot disagree. Finished and
  // former runs have no live stats, hence the local fallback.
  const liveProgress = useStore((s) => s.runStats)?.jobProgress?.[jobId];
  const overall = liveProgress?.fraction ?? localOverall;
  const pct = Math.round(overall * 100);

  const failedCount =
    liveProgress?.failed ??
    chapterTasks.filter((task) => task.status === "error").length;

  const doneCount = chapterTasks.filter(
    (task) => task.status === "done",
  ).length;
  const chaptersDone = t("chapters_done")
    .replace("{n}", String(doneCount))
    .replace("{m}", String(chapterTasks.length));

  const title = isActive
    ? t("current_run")
    : jobTasks.some((task) => task.status === "cancelled")
      ? t("run_stopped")
      : t("run_finished");

  const modes = [...new Set(chapterTasks.map((task) => task.mode))];
  const modelText = [
    ...new Set(
      jobTasks.map((task) => task.model).filter((m): m is string => !!m),
    ),
  ]
    .map((m) => modelNames[m] ?? m)
    .join(", ");
  // Aggregate, not the first stream's share. Several chapters decode at once
  // and each sees a fraction of the machine's bandwidth, so showing one
  // stream's rate made a healthy 3-slot run look ~3x slower than it was.
  const runtime = useStore((s) => s.runStats)?.runtime;
  const throughput =
    runtime && runtime.activeStreams > 0
      ? t("run_throughput")
          .replace("{rate}", String(runtime.aggregateTokPerSec))
          .replace("{streams}", String(runtime.activeStreams))
      : null;

  const start = Math.min(
    ...jobTasks.map((task) => task.startedAt ?? task.submittedAt ?? Date.now()),
  );
  const end = isActive
    ? now
    : Math.max(...jobTasks.map((task) => task.finishedAt ?? task.submittedAt ?? 0));
  const elapsedText = formatElapsed(end - start);

  const handleStop = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
    setStopping(true);
    try {
      await cancelJob(jobId);
    } catch (err) {
      console.error("Failed to stop job:", err);
      alert(
        `Failed to stop job: ${err instanceof Error ? err.message : err}`,
      );
    }
    setStopping(false);
  };

  return (
    <div className="current-run-header" id="current-run-header">
      <div className="crh-top">
        <span className="crh-title">{title}</span>
        {modes.map((mode) => (
          <span key={mode} className="crh-mode-pill">
            {t(`mode_${mode}`)}
          </span>
        ))}
        {isActive && (
          <button
            type="button"
            className={`crh-stop${armed ? " crh-stop-armed" : ""}`}
            onClick={handleStop}
            disabled={stopping}
            title={t("stop_job_help")}
          >
            {stopping ? "…" : armed ? `${t("stop_job")}?` : `⊘ ${t("stop_job")}`}
          </button>
        )}
      </div>
      <div className="crh-bar">
        <div className="crh-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="crh-stats">
        <span className="crh-stat">{pct}%</span>
        <span className="crh-stat">{chaptersDone}</span>
        <span className="crh-stat">
          {t("elapsed")}: {elapsedText}
        </span>
        {modelText && <span className="crh-stat">{modelText}</span>}
        {throughput && <span className="crh-stat crh-tok">{throughput}</span>}
        {failedCount > 0 && (
          <span className="crh-stat crh-failed">
            {t("run_chapters_failed").replace("{count}", String(failedCount))}
          </span>
        )}
      </div>
    </div>
  );
}
