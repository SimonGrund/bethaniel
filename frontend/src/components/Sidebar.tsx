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
import StepBar from "./StepBar";
import EditTrigger from "./EditTrigger";
import EngineStatus, { useEngineFeed } from "./EngineStatus";
import ModelDownloadStrip from "./ModelDownloadStrip";

const SETUP_STEPS = ["model", "edits", "upload", "style"];

export default function Sidebar() {
  const { lang, tasks, wizardStep, sessionStartedAt } = useStore();
  const engineDevice = useStore((s) => s.engineDevice);
  // Empty feed → no dock. Reserving the rail for an amber box with nothing in
  // it is exactly the space the setup block is scrolling to find.
  const engineFeed = useEngineFeed();
  const engineVisible = engineFeed.warming || engineFeed.lines.length > 0;
  const t = useTranslation(lang);
  const [confirm, setConfirm] = useState(false);
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

  // ── Setup collapse ──
  // Once a run is under way the step cards are settled history: the user is
  // watching the engine, not reconfiguring. Fold them so the log gets the rail.
  const hasCurrentRun = Object.values(tasks).some(
    (task) => (task.submittedAt ?? 0) >= sessionStartedAt,
  );
  const [setupOpen, setSetupOpen] = useState(!hasCurrentRun);
  const prevHasRun = useRef(hasCurrentRun);
  useEffect(() => {
    if (hasCurrentRun === prevHasRun.current) return;
    prevHasRun.current = hasCurrentRun;
    // Launching folds the rail; "New run" (which resets the session boundary)
    // unfolds it again.
    setSetupOpen(!hasCurrentRun);
  }, [hasCurrentRun]);

  // Something opened a setup menu (the advanced-mode toggle jumps straight to
  // the model step) — the rail must show which card is current.
  useEffect(() => {
    if (SETUP_STEPS.includes(wizardStep)) setSetupOpen(true);
  }, [wizardStep]);

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

      <div className="sidebar-section">
        <button
          type="button"
          className="sidebar-setup-toggle"
          onClick={() => setSetupOpen((open) => !open)}
          aria-expanded={setupOpen}
        >
          <span className="sidebar-label">{t("sidebar_setup")}</span>
          <span className="sidebar-setup-chevron" aria-hidden>
            {setupOpen ? "▾" : "▸"}
          </span>
        </button>

        {setupOpen && <StepBar />}

        {/* Download progress and the run button stay put: they are the two
            things you still need while a run is folded away. */}
        <ModelDownloadStrip />
        <EditTrigger />
      </div>

      {engineVisible && (
        <div className={`sidebar-engine${isWorking ? " sidebar-engine-active" : ""}`}>
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

      {/* Only rendered when there is something to stop — an empty bordered
          footer would just eat rail the engine log can use. */}
      {isWorking && (
        <div className="sidebar-session">
          <button
            type="button"
            className={`btn-start-over${confirm ? " btn-start-over-armed" : ""}`}
            onClick={handleStopJob}
            disabled={stopping}
            title={t("stop_job_help")}
          >
            {stopping ? "…" : confirm ? `${t("stop_job")}?` : t("stop_job")}
          </button>
        </div>
      )}
    </aside>
  );
}
