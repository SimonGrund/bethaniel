// ── Sidebar — the command rail: setup steps, queue, engine log, session ──

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { cancelJob } from "../api";
import StepBar from "./StepBar";
import EditTrigger from "./EditTrigger";
import EngineStatus from "./EngineStatus";

const BASE = import.meta.env.VITE_API_URL ?? "";

export default function Sidebar() {
  const { lang, completedSteps, setWizardStep, resetAll, showEngineStatus, tasks } =
    useStore();
  const t = useTranslation(lang);
  const [confirm, setConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);

  // Distinct jobs with work still queued/running. While any exist the footer
  // button becomes "Stop job" instead of "Start over".
  const activeJobIds = [
    ...new Set(
      Object.values(tasks)
        .filter((task) => task.status === "queued" || task.status === "editing")
        .map((task) => task.jobId),
    ),
  ];
  const isWorking = activeJobIds.length > 0;

  // Arm-to-confirm for the destructive footer action (stop or reset):
  // auto-disarm if the second click never comes.
  useEffect(() => {
    if (!confirm) return;
    const id = setTimeout(() => setConfirm(false), 3000);
    return () => clearTimeout(id);
  }, [confirm]);

  // Disarm when the run ends so a stale confirm doesn't carry into "Start over".
  useEffect(() => {
    if (!isWorking) setConfirm(false);
  }, [isWorking]);

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

  const handleStartOver = () => {
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setConfirm(false);
    resetAll();
    fetch(`${BASE}/api/logs`, { method: "DELETE" }).catch(() => {});
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <img src="/logo-icon.svg" alt="Bethaniel" />
      </div>

      <div className="sidebar-section">
        <span className="sidebar-label">{t("sidebar_setup")}</span>
        <StepBar />
        <EditTrigger />
      </div>

      {showEngineStatus && (
        <div className="sidebar-engine">
          <span className="sidebar-label">{t("sidebar_engine")}</span>
          <EngineStatus />
        </div>
      )}

      <div className="sidebar-session">
        {isWorking ? (
          <button
            type="button"
            className={`btn-start-over${confirm ? " btn-start-over-armed" : ""}`}
            onClick={handleStopJob}
            disabled={stopping}
            title={t("stop_job_help")}
          >
            {stopping ? "…" : confirm ? `${t("stop_job")}?` : t("stop_job")}
          </button>
        ) : (
          completedSteps.length > 0 && (
            <button
              type="button"
              className={`btn-start-over${confirm ? " btn-start-over-armed" : ""}`}
              onClick={handleStartOver}
              title={t("start_over_help")}
            >
              {confirm ? t("start_over_confirm") : t("start_over")}
            </button>
          )
        )}
        <button
          type="button"
          className="btn-former-runs"
          onClick={() => setWizardStep("done")}
        >
          {t("former_runs")}
        </button>
      </div>
    </aside>
  );
}
