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
import EngineStatus, { useEngineFeed } from "./EngineStatus";
import ModelDownloadStrip from "./ModelDownloadStrip";

export default function Sidebar() {
  const { lang, tasks, sessionStartedAt } = useStore();
  const engineDevice = useStore((s) => s.engineDevice);
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
