// ── Sidebar — the command rail: setup steps, queue, engine log, session ──

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import StepBar from "./StepBar";
import EditTrigger from "./EditTrigger";
import EngineStatus from "./EngineStatus";

const BASE = import.meta.env.VITE_API_URL ?? "";

export default function Sidebar() {
  const { lang, completedSteps, setWizardStep, resetAll, showEngineStatus } =
    useStore();
  const t = useTranslation(lang);
  const [confirmReset, setConfirmReset] = useState(false);

  // Arm-to-confirm for "Start over": auto-disarm if the second click never comes.
  useEffect(() => {
    if (!confirmReset) return;
    const id = setTimeout(() => setConfirmReset(false), 3000);
    return () => clearTimeout(id);
  }, [confirmReset]);

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
        {completedSteps.length > 0 && (
          <button
            type="button"
            className={`btn-start-over${confirmReset ? " btn-start-over-armed" : ""}`}
            onClick={() => {
              if (!confirmReset) {
                setConfirmReset(true);
                return;
              }
              setConfirmReset(false);
              resetAll();
              fetch(`${BASE}/api/logs`, { method: "DELETE" }).catch(() => {});
            }}
            title={t("start_over_help")}
          >
            {confirmReset ? t("start_over_confirm") : t("start_over")}
          </button>
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
