// ── App shell ──

import { useEffect, useState } from "react";
import { useStore } from "./store";
import { useTranslation } from "./i18n";
import { getSocket } from "./socket";
import Sidebar from "./components/Sidebar";
import ModelSelector from "./components/ModelSelector";
import ManuscriptUpload from "./components/ManuscriptUpload";
import StyleGuideEditor from "./components/StyleGuideEditor";
import ScopeSelection from "./components/ScopeSelection";
import ModeSelector from "./components/ModeSelector";
import EditTrigger from "./components/EditTrigger";
import ReviewExport from "./components/ReviewExport";
import BettyWorking from "./components/BettyWorking";
import LogPanel from "./components/LogPanel";
import type { TaskState, Lang } from "./types";
import "./styles/global.css";

const BASE = import.meta.env.VITE_API_URL ?? "";

export default function App() {
  const { lang, setLang, setTasks, tasks } = useStore();
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
        // If endpoint doesn't exist (dev/Ollama mode), skip the gate
        setModelReady(true);
      });
  }, []);

  // Socket.IO connection for real-time queue updates
  useEffect(() => {
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
      console.log("[Socket] queue:update", Object.keys(data).length, "tasks");
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

  return (
    <div className="app-layout">
      <Sidebar />
      <main className="main-content">
        <div className="title-header">
          <img src="/title-wide.svg" alt="Bethaniel" className="title-svg" />
          <BettyWorking />
          <div className="lang-toggle">
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

        <ModelSelector onModelInstalled={() => setModelReady(true)} />

        <ModeSelector />

        <div className="section-label">
          <span className="num">III.</span> {t("sec_content")}
        </div>

        <div className="top-row">
          <ManuscriptUpload />
          <StyleGuideEditor />
        </div>

        <ScopeSelection />
        <EditTrigger />

        <div className="section-label">
          <span className="num">IV.</span> {t("sec_output")}
        </div>

        <div className="bottom-row">
          <div className="results-col">
            <ReviewExport />
          </div>
        </div>

        <footer className="app-footer">
          <img src="/logo-icon.svg" alt="" className="footer-logo" />
          <span className="footer-text">
            © {new Date().getFullYear()} Bethaniel · v{__APP_VERSION__} · All
            rights reserved.
          </span>
        </footer>
      </main>
      <LogPanel />
    </div>
  );
}
