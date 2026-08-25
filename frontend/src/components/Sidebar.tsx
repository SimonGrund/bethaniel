// ── Sidebar — the command rail: setup steps, queue, engine log, session ──

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { cancelJob } from "../api";
import StepBar from "./StepBar";
import EditTrigger from "./EditTrigger";
import EngineStatus from "./EngineStatus";
import RunModeSlider from "./RunModeSlider";
import ModelDownloadStrip from "./ModelDownloadStrip";
import StorageSettings from "./StorageSettings";
import Modal from "./Modal";

const BASE = import.meta.env.VITE_API_URL ?? "";

export default function Sidebar() {
  const { lang, completedSteps, setWizardStep, resetAll, showEngineStatus, tasks } =
    useStore();
  const engineDevice = useStore((s) => s.engineDevice);
  const t = useTranslation(lang);
  const [confirm, setConfirm] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [storageOpen, setStorageOpen] = useState(false);

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
        {/* Quality vs. time — the one advanced knob every user has a view on,
            so it sits next to the button that starts the wait. */}
        <RunModeSlider />
        <ModelDownloadStrip />
        <EditTrigger />
      </div>

      {showEngineStatus && (
        <div className="sidebar-engine">
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
        <button
          type="button"
          className="btn-former-runs"
          onClick={() => setStorageOpen(true)}
        >
          {t("storage_title")}
        </button>
      </div>

      <Modal
        open={storageOpen}
        onClose={() => setStorageOpen(false)}
        labelledBy="storage-title"
        className="storage-dialog"
      >
        <StorageSettings />
        <div className="model-confirm-actions">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setStorageOpen(false)}
          >
            {t("btn_close")}
          </button>
        </div>
      </Modal>
    </aside>
  );
}
