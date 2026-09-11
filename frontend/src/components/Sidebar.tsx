// ── Sidebar — the command rail: setup steps, run button, engine log ──
//
// Layout contract: the rail is a fixed-height flex column that never scrolls
// as a whole. The setup block scrolls inside itself, the engine log takes
// whatever is left (with a floor), and the session footer is pinned last in
// flow — so on a short window the engine log shrinks instead of sliding out of
// sight underneath the footer.

import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { cancelJob } from "../api";
import { weightedProgress } from "../runProgress";
import EngineStatus, { useEngineFeed } from "./EngineStatus";

export default function Sidebar() {
  const { lang, tasks, sessionStartedAt } = useStore();
  const engineDevice = useStore((s) => s.engineDevice);
  const engineFeed = useEngineFeed();
  const engineVisible = engineFeed.warming || engineFeed.lines.length > 0;
  const t = useTranslation(lang);
  const setSessionStartedAt = useStore((s) => s.setSessionStartedAt);
  const setWizardStep = useStore((s) => s.setWizardStep);
  const [confirm, setConfirm] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [stopping, setStopping] = useState(false);

  // Distinct jobs with work still queued/running — while any exist the footer
  // offers "Stop job".
  const activeJobIds = [
    ...new Set(
      Object.values(tasks)
        .filter((task) => task.status === "queued" || task.status === "editing")
        .map((task) => task.jobId),
    ),
  ];
  const isWorking = activeJobIds.length > 0;

  // This session's run, reduced to what fits a rail: how far through it is,
  // whether it finished, and whether it was stopped rather than completed.
  const sessionTasks = Object.values(tasks).filter(
    (task) => (task.submittedAt ?? 0) >= sessionStartedAt,
  );
  const isTerminal = (status: string) =>
    status === "done" || status === "error" || status === "cancelled";
  const hasFinishedRun =
    !isWorking && sessionTasks.some((task) => isTerminal(task.status));
  // Weighted by words, like Betty's panel and the backend — this used to be a
  // plain mean over tasks, which let the two bars on screen disagree.
  const runProgress = weightedProgress(sessionTasks);
  // Only chapters that actually landed. Counting a failed one as done put
  // "13/13" over a bar the same reckoning held short of full.
  const doneCount = sessionTasks.filter(
    (task) => task.status === "done",
  ).length;
  const wasStopped = sessionTasks.some((task) => task.status === "cancelled");

  // Starting a new job moves the session boundary, and moving it is what files
  // the finished run under Former Runs. The warning has to say so before it
  // happens, not leave the reader to notice their results have gone.
  const handleNewJob = () => {
    if (!confirmNew) {
      setConfirmNew(true);
      return;
    }
    setConfirmNew(false);
    setSessionStartedAt(Date.now());
    setWizardStep("upload");
  };

  // Arm-to-confirm for stopping a job: auto-disarm if the second click never
  // comes, and on the run ending so a stale confirm can't carry over.
  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(id);
  }, [confirm]);

  useEffect(() => {
    if (!isWorking) setConfirm(false);
  }, [isWorking]);

  useEffect(() => {
    if (!confirmNew) return;
    const id = setTimeout(() => setConfirmNew(false), 4000);
    return () => clearTimeout(id);
  }, [confirmNew]);

  const handleStopJob = async () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setConfirm(false);
    setStopping(true);
    try {
      await Promise.all(activeJobIds.map((id) => cancelJob(id)));
    } catch (err) {
      console.error("Failed to stop job:", err);
      alert(`Failed to stop job: ${err instanceof Error ? err.message : err}`);
    }
    setStopping(false);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <img src="/logo-icon.svg" alt="Bethaniel" />
      </div>

      <div className={`sidebar-engine sidebar-engine-solo${isWorking ? " sidebar-engine-active" : ""}`}>
          <div className="sidebar-engine-header">
            <span className="sidebar-label">{t("sidebar_engine")}</span>
            {engineDevice?.running && (
              <span
                className={`engine-device-badge engine-device-badge-${engineDevice.device}`}
                title={t(
                  engineDevice.device === "gpu"
                    ? "engine_device_gpu_help"
                    : engineDevice.device === "cpu"
                      ? "engine_device_cpu_help"
                      : "engine_device_unknown_help",
                )}
              >
                {t(
                  engineDevice.device === "gpu"
                    ? "engine_device_gpu"
                    : engineDevice.device === "cpu"
                      ? "engine_device_cpu"
                      : "engine_device_unknown",
                )}
              </span>
            )}
          </div>
          {engineVisible ? (
            <EngineStatus />
          ) : (
            <p className="sidebar-engine-idle">
              {t("engine_log_idle", "Betty's engine will report here while she works.")}
            </p>
          )}
        </div>

      {/* Standing, for as long as the run lasts. The same fact was already in
          the pre-purchase accordion, which is the wrong place for it: a
          warning about closing the app is worth nothing to someone who has
          already closed it, and everything to someone watching a progress bar
          and wondering whether they can go and do something else. */}
      {isWorking && (
        <p className="sidebar-keep-open">
          {t(
            "keep_open_while_running",
            "Keep Betty open until this finishes — the run is driven from this computer.",
          )}
        </p>
      )}

      {/* ── Run footer ──
           Pinned to the bottom for the whole life of a run and after it: while
           Betty works this is where the progress and the way to stop her live,
           and once she is done it is where the finished bar sits and the way
           on to the next job. One place, so the reader never hunts for either.
           Both actions arm on the first press and act on the second — the one
           destroys work in flight, the other files the results away. */}
      {(isWorking || hasFinishedRun) && (
        <div className="sidebar-run">
          <div className="sidebar-run-head">
            <span className="sidebar-label">
              {isWorking
                ? t("current_run")
                : wasStopped
                  ? t("run_stopped")
                  : t("run_finished")}
            </span>
            <span className="sidebar-run-count">
              {doneCount}/{sessionTasks.length}
            </span>
          </div>
          <div className="q-bar sidebar-run-bar">
            <div
              className={`q-fill${isWorking ? " qs-editing" : " qs-done"}`}
              style={{ width: `${Math.round(runProgress * 100)}%` }}
            />
          </div>

          {isWorking ? (
            <button
              type="button"
              className={`btn-run sidebar-run-action${confirm ? " sidebar-run-action-armed" : ""}`}
              onClick={handleStopJob}
              disabled={stopping}
            >
              <span className="btn-run-label">
                {stopping ? "…" : t("stop_job")}
              </span>
              <span className="btn-run-meta">
                {confirm
                  ? t("stop_job_confirm", "Press again — the chapters still running are lost")
                  : t("stop_job_help")}
              </span>
            </button>
          ) : (
            <button
              type="button"
              className={`btn-run sidebar-run-action${confirmNew ? " sidebar-run-action-armed" : ""}`}
              onClick={handleNewJob}
            >
              <span className="btn-run-label">{t("new_job", "New job")}</span>
              <span className="btn-run-meta">
                {confirmNew
                  ? t(
                      "new_job_confirm",
                      "Press again — this run moves to Former Runs",
                    )
                  : t("new_job_help", "Start again with a new manuscript")}
              </span>
            </button>
          )}
        </div>
      )}

    </aside>
  );
}
