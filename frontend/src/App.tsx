// ── App shell — wizard-guided flow ──

import { useEffect, useState } from "react";
import { useStore } from "./store";
import { useTranslation } from "./i18n";
import { getSocket } from "./socket";
import { getDocument } from "./api";
import { useModelRuntime } from "./useModelRuntime";
import Sidebar from "./components/Sidebar";
import ModelSelector from "./components/ModelSelector";
import ManuscriptUpload from "./components/ManuscriptUpload";
import StyleGuideEditor from "./components/StyleGuideEditor";
import ModeSelector from "./components/ModeSelector";
import ReviewExport from "./components/ReviewExport";
import BettyWorking from "./components/BettyWorking";
import LogPanel from "./components/LogPanel";
import OnboardingGuide from "./components/OnboardingGuide";
import ModelIntroModal from "./components/ModelIntroModal";
import ModelReadyModal from "./components/ModelReadyModal";
import PerfAdviceModal from "./components/PerfAdviceModal";
import type {
  TaskState,
  Lang,
  DownloadProgress,
  PerfAdvice,
  RunStats,
} from "./types";
import "./styles/global.css";

const BASE = import.meta.env.VITE_API_URL ?? "";

// Friendly title + one-line intro shown at the top of each open setup menu.
const MENU_INTRO: Record<string, { nameKey: string; briefKey: string }> = {
  upload: { nameKey: "step_name_upload", briefKey: "upload_step_brief" },
  edits: { nameKey: "step_name_edits", briefKey: "edits_step_brief" },
  model: { nameKey: "step_name_model", briefKey: "model_step_brief" },
  style: { nameKey: "step_name_style", briefKey: "style_step_brief" },
};

export default function App() {
  const {
    lang,
    setLang,
    setTasks,
    tasks,
    wizardStep,
    setWizardStep,
    model,
    sessionStartedAt,
  } = useStore();
  const setLogs = useStore((s) => s.setLogs);
  const appendLog = useStore((s) => s.appendLog);
  const clearLogsLocal = useStore((s) => s.clearLogs);
  const setWarming = useStore((s) => s.setWarming);
  const setDownloadProgress = useStore((s) => s.setDownloadProgress);
  const clearDownload = useStore((s) => s.clearDownload);
  const bumpDownloadDone = useStore((s) => s.bumpDownloadDone);
  const setDownloadError = useStore((s) => s.setDownloadError);
  const setIntroOpen = useStore((s) => s.setIntroOpen);
  const advancedMode = useStore((s) => s.advancedMode);
  const setAdvancedMode = useStore((s) => s.setAdvancedMode);
  const setPerfAdvice = useStore((s) => s.setPerfAdvice);
  const setModelReadyOpen = useStore((s) => s.setModelReadyOpen);
  const t = useTranslation(lang);
  const [modelReady, setModelReady] = useState<boolean | null>(null);

  // Model catalog, auto-selection, pre-warm and tuning. Lives here rather than
  // in ModelSelector because the model step is hidden for most users and a
  // component that never mounts cannot run any of it.
  useModelRuntime();

  // First-run: open the intro guide once, keyed off the persisted flag.
  useEffect(() => {
    if (!useStore.getState().hasSeenIntro) setIntroOpen(true);
  }, [setIntroOpen]);

  // Check if a model is installed
  useEffect(() => {
    fetch(`${BASE}/api/models/installed`)
      .then((r) => r.json())
      .then((data) => {
        setModelReady((data.installed ?? []).length > 0);
      })
      .catch(() => {
        setModelReady(true);
      });
  }, []);

  // Rehydrate document text on page refresh (metadata is persisted, md is not)
  useEffect(() => {
    const { document: docMeta, documentMd, setDocumentMd, setDocument } = useStore.getState();
    if (docMeta && !documentMd) {
      getDocument(docMeta.id)
        .then((full: { md: string }) => {
          setDocumentMd(full.md);
          // Refresh metadata in case chapters were re-detected
          setDocument({ ...docMeta, chapters: full.md ? docMeta.chapters : [] });
        })
        .catch(() => {});
    }
  }, []);

  // Socket.IO connection for real-time queue updates
  useEffect(() => {
    // Pre-fetch tasks via HTTP so Old Results are available immediately
    fetch(`${BASE}/api/queue/status`)
      .then((r) => r.json())
      .then((data: Record<string, TaskState>) => setTasks(data))
      .catch(() => {});

    const socket = getSocket();
    socket.on("connect", () => {
      console.log("[Socket] connected:", socket.id);
    });
    socket.on("disconnect", (reason) => {
      console.log("[Socket] disconnected:", reason);
    });
    socket.on("connect_error", (err) => {
      console.error("[Socket] connect_error:", err.message);
    });
    socket.on("queue:update", (data: Record<string, TaskState>) => {
      setTasks(data);
    });
    // Separate from queue:update so that event's shape stays untouched.
    socket.on("run:stats", (data: RunStats) => {
      useStore.getState().setRunStats(data);
    });
    socket.on("log:snapshot", (entries) => {
      setLogs(entries ?? []);
    });
    socket.on("log:append", (entry) => {
      appendLog(entry);
    });
    socket.on("log:clear", () => {
      clearLogsLocal();
    });
    // A task came good — drop the problems it reported on the way.
    socket.on("log:resolve", (d: { taskId: string }) => {
      useStore.getState().resolveLogsForTask(d.taskId);
    });
    socket.on(
      "model:warming",
      (evt: { model: string; status: "warming" | "ready" | "error" }) => {
        setWarming(evt.model, evt.status);
      },
    );
    // Model-download progress. Lives here (always-mounted App) rather than in
    // ModelSelector so downloads keep updating the store while the user is on
    // any other setup menu. LogPanel renders the persistent readout.
    socket.on("model:download", (data: DownloadProgress) => {
      if (data.status === "done") {
        clearDownload(data.modelId);
        bumpDownloadDone();
        // Only announce the download the first-run popup started. A power user
        // pulling a second model in the selector already knows it finished.
        if (useStore.getState().awaitingFirstModel) {
          useStore.getState().setAwaitingFirstModel(false);
          setModelReadyOpen(true);
        }
      } else if (data.status === "error") {
        clearDownload(data.modelId);
        setDownloadError(data.error ?? "Download failed");
      } else if (data.status === "cancelled") {
        clearDownload(data.modelId);
      } else {
        setDownloadProgress(data);
      }
    });

    // Measured throughput disagreeing with the model in use — either "a smaller
    // Betty would serve you better" or "this will be slow, here's how slow".
    // Advice the user already waved away never comes back.
    socket.on("model:perf-advice", (advice: PerfAdvice) => {
      const key = `${advice.from}:${advice.kind}`;
      if (useStore.getState().dismissedAdvice.includes(key)) return;
      setPerfAdvice(advice);
    });

    // Re-sync any in-flight downloads (covers a full page reload — the backend
    // keeps downloading regardless).
    fetch(`${BASE}/api/models/download/status`)
      .then((r) => r.json())
      .then((d: { downloads?: DownloadProgress[] }) => {
        for (const dl of d.downloads ?? []) setDownloadProgress(dl);
      })
      .catch(() => {});

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("queue:update");
      socket.off("run:stats");
      socket.off("log:snapshot");
      socket.off("log:append");
      socket.off("log:clear");
      socket.off("log:resolve");
      socket.off("model:warming");
      socket.off("model:download");
      socket.off("model:perf-advice");
    };
  }, [
    setTasks,
    setLogs,
    appendLog,
    clearLogsLocal,
    setWarming,
    setDownloadProgress,
    clearDownload,
    bumpDownloadDone,
    setDownloadError,
    setPerfAdvice,
    setModelReadyOpen,
  ]);

  // Warn before unload if tasks are active
  useEffect(() => {
    const hasActive = Object.values(tasks).some(
      (t) => t.status === "queued" || t.status === "editing",
    );
    if (hasActive) {
      const handler = (e: BeforeUnloadEvent) => {
        e.preventDefault();
      };
      window.addEventListener("beforeunload", handler);
      return () => window.removeEventListener("beforeunload", handler);
    }
  }, [tasks]);

  // Loading state
  if (modelReady === null) {
    return (
      <div
        className="app-layout"
        style={{ justifyContent: "center", alignItems: "center" }}
      >
        <div className="splash">
          <img
            src="/logo-full.svg"
            alt="Bethaniel"
            className="splash-logo splash-pulse"
          />
          <span className="splash-text">Loading Betty…</span>
        </div>
      </div>
    );
  }

  const isSetupPhase = wizardStep !== "done";
  // A step menu is open only for the setup steps; every other state (folded, or
  // a stray "run") means no menu is open. The model step exists only in
  // advanced mode, so leaving that mode while sitting on it must not strand the
  // user on an empty panel.
  const menuOpen =
    (wizardStep === "model" && advancedMode) ||
    wizardStep === "edits" ||
    wizardStep === "upload" ||
    wizardStep === "style";
  const hasActiveTasks = Object.values(tasks).some(
    (t) => (t.status === "queued" || t.status === "editing") && (t.submittedAt ?? 0) >= sessionStartedAt,
  );
  const hasCompletedTasks = Object.values(tasks).some(
    (t) => (t.status === "done" || t.status === "error" || t.status === "cancelled") && (t.submittedAt ?? 0) >= sessionStartedAt,
  );

  return (
    <div className="app-layout">
      <OnboardingGuide />
      <ModelIntroModal />
      <ModelReadyModal />
      <PerfAdviceModal />
      <Sidebar />
      <main className="main-content">
        {/* Header */}
        <div className="title-header">
          <img src="/title-wide.svg" alt="Bethaniel" className="title-svg" />
          <BettyWorking />
          <div className="lang-toggle" style={{ marginLeft: "auto" }}>
            {/* Reveals the model step and its advanced settings. Most users
                never touch it — they get a recommendation instead of a
                decision — but nothing is hidden from anyone who wants it. */}
            <button
              type="button"
              className={`btn-model-settings${advancedMode ? " btn-model-settings-on" : ""}`}
              aria-pressed={advancedMode}
              onClick={() => {
                const next = !advancedMode;
                setAdvancedMode(next);
                // Leaving advanced mode while the model step is open would
                // otherwise leave an empty panel behind.
                if (!next && wizardStep === "model") setWizardStep("folded");
                if (next) setWizardStep("model");
              }}
            >
              {advancedMode
                ? t("hide_model_selector")
                : t("activate_model_selector")}
            </button>
            <button
              type="button"
              className="btn-rerun-intro"
              onClick={() => setIntroOpen(true)}
            >
              {t("rerun_introguide")}
            </button>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value as Lang)}
            >
              <option value="en">English</option>
              <option value="da">Dansk</option>
              <option value="de">Deutsch</option>
              <option value="es">Español</option>
            </select>
          </div>
        </div>

        {/* Wizard setup phase — step navigation lives in the sidebar rail */}
        {isSetupPhase && (
          <div className="wizard-layout">
            {/* The collapsible step menu is only mounted while a step is open,
                so no empty box lingers on the idle dashboard. */}
            {menuOpen && (
              <div className="wizard-content">
                <button
                  type="button"
                  className="btn-close-step"
                  onClick={() => setWizardStep("folded")}
                  title={t("close_menu")}
                  aria-label={t("close_menu")}
                >
                  ×
                </button>
                {MENU_INTRO[wizardStep] && (
                  <div className="wizard-menu-header">
                    <h2 className="wizard-menu-title">
                      {t(MENU_INTRO[wizardStep].nameKey)}
                    </h2>
                    <p className="wizard-menu-brief">
                      {t(MENU_INTRO[wizardStep].briefKey)}
                    </p>
                  </div>
                )}
                {wizardStep === "model" && advancedMode && <ModelSelector />}

                {wizardStep === "edits" && <ModeSelector />}

                {wizardStep === "upload" && (
                  <div className="wizard-upload-only">
                    <ManuscriptUpload />
                  </div>
                )}

                {wizardStep === "style" && (
                  <div className="wizard-style-only">
                    <StyleGuideEditor />
                  </div>
                )}
              </div>
            )}

            {/* Idle dashboard — no menu open, nothing running: the app-wide
                logo watermark (`.main-content::before`) is the only mark. */}
            {!menuOpen && !hasActiveTasks && !hasCompletedTasks && (
              <div className="dashboard-hero" aria-hidden="true" />
            )}

            {/* ── Task progress / results (below wizard content) ──
                Hidden while a setup menu is open; "See latest run" reopens it. */}
            {!menuOpen && (hasActiveTasks || hasCompletedTasks) && (
              <div className="bottom-row">
                <div className="results-col">
                  <ReviewExport />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Old Results view (explicitly accessed via header button) */}
        {!isSetupPhase && (
          <>
            <div className="results-header-bar">
              <button
                type="button"
                className="btn-back-to-setup"
                onClick={() => setWizardStep("folded")}
                title={t("new_run")}
              >
                ←
              </button>
              <span className="back-to-setup-label">
                {t("return_to_dashboard")}
              </span>
            </div>
            <div className="bottom-row">
              <div className="results-col">
                <ReviewExport isOldResults />
              </div>
            </div>
          </>
        )}

        <footer className="app-footer">
          <img src="/logo-icon.svg" alt="" className="footer-logo" />
          <span className="footer-text">
            © {new Date().getFullYear()} Bethaniel · v{__APP_VERSION__} · All
            rights reserved.
          </span>
          <a
            href="https://www.bethaniel.eu/contact"
            target="_blank"
            rel="noopener noreferrer"
            className="footer-feedback-link"
          >
            Give Feedback
          </a>
        </footer>
      </main>
      <LogPanel />
    </div>
  );
}
