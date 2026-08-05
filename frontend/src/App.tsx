// ── App shell — wizard-guided flow ──

import { useEffect, useState } from "react";
import { useStore } from "./store";
import { useTranslation } from "./i18n";
import { getSocket } from "./socket";
import { getDocument } from "./api";
import Sidebar from "./components/Sidebar";
import ModelSelector from "./components/ModelSelector";
import ManuscriptUpload from "./components/ManuscriptUpload";
import StyleGuideEditor from "./components/StyleGuideEditor";
import ModeSelector from "./components/ModeSelector";
import ReviewExport from "./components/ReviewExport";
import BettyWorking from "./components/BettyWorking";
import LogPanel from "./components/LogPanel";
import OnboardingGuide from "./components/OnboardingGuide";
import type { TaskState, Lang, DownloadProgress } from "./types";
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
  const t = useTranslation(lang);
  const [modelReady, setModelReady] = useState<boolean | null>(null);

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
    socket.on("log:snapshot", (entries) => {
      setLogs(entries ?? []);
    });
    socket.on("log:append", (entry) => {
      appendLog(entry);
    });
    socket.on("log:clear", () => {
      clearLogsLocal();
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
      } else if (data.status === "error") {
        clearDownload(data.modelId);
        setDownloadError(data.error ?? "Download failed");
      } else if (data.status === "cancelled") {
        clearDownload(data.modelId);
      } else {
        setDownloadProgress(data);
      }
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
      socket.off("log:snapshot");
      socket.off("log:append");
      socket.off("log:clear");
      socket.off("model:warming");
      socket.off("model:download");
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
  // A step menu is open only for the four setup steps; every other state
  // (folded, or a stray "run") means no menu is open.
  const menuOpen =
    wizardStep === "model" ||
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
      <Sidebar />
      <main className="main-content">
        {/* Header */}
        <div className="title-header">
          <img src="/title-wide.svg" alt="Bethaniel" className="title-svg" />
          <BettyWorking />
          <div className="lang-toggle" style={{ marginLeft: "auto" }}>
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
                {wizardStep === "model" && (
                  <ModelSelector onModelInstalled={() => setModelReady(true)} />
                )}

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
