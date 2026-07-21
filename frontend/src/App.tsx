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
import type { TaskState, Lang } from "./types";
import "./styles/global.css";

const BASE = import.meta.env.VITE_API_URL ?? "";

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
  const t = useTranslation(lang);
  const [modelReady, setModelReady] = useState<boolean | null>(null);

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
    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("queue:update");
      socket.off("log:snapshot");
      socket.off("log:append");
      socket.off("log:clear");
      socket.off("model:warming");
    };
  }, [setTasks, setLogs, appendLog, clearLogsLocal, setWarming]);

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
  const isFolded = wizardStep === "folded";
  const hasActiveTasks = Object.values(tasks).some(
    (t) => (t.status === "queued" || t.status === "editing") && (t.submittedAt ?? 0) >= sessionStartedAt,
  );
  const hasCompletedTasks = Object.values(tasks).some(
    (t) => (t.status === "done" || t.status === "error" || t.status === "cancelled") && (t.submittedAt ?? 0) >= sessionStartedAt,
  );

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        {/* Header */}
        <div className="title-header">
          <img src="/title-wide.svg" alt="Bethaniel" className="title-svg" />
          <BettyWorking />
          <div className="lang-toggle" style={{ marginLeft: "auto" }}>
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
            <div className={`wizard-content${isFolded ? " wizard-content-collapsed" : ""}`}>
              <button
                type="button"
                className="btn-minimize-step"
                onClick={() => setWizardStep("folded")}
                title={t("minimize")}
              >
                −
              </button>
              {wizardStep === "model" && (
                <ModelSelector onModelInstalled={() => setModelReady(true)} />
              )}

              {wizardStep === "edits" && <ModeSelector />}

              {wizardStep === "upload" && (
                <div className="top-row">
                  <ManuscriptUpload />
                </div>
              )}

              {wizardStep === "style" && (
                <div className="wizard-style-only">
                  <StyleGuideEditor />
                </div>
              )}

            </div>

            {/* ── Task progress / results (below wizard content) ── */}
            {(hasActiveTasks || hasCompletedTasks) && (
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
