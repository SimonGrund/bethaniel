// ── App shell ──

import { useEffect, useState } from "react";
import { useStore } from "./store";
import { useTranslation } from "./i18n";
import { getSocket } from "./socket";
import Sidebar from "./components/Sidebar";
import ManuscriptUpload from "./components/ManuscriptUpload";
import StyleGuideEditor from "./components/StyleGuideEditor";
import ScopeSelection from "./components/ScopeSelection";
import ModeSelector from "./components/ModeSelector";
import EditTrigger from "./components/EditTrigger";
import ReviewExport from "./components/ReviewExport";
import QueuePanel from "./components/QueuePanel";
import type { TaskState } from "./types";
import "./styles/global.css";

const BASE = import.meta.env.VITE_API_URL ?? "";

export default function App() {
  const { lang, setTasks, tasks } = useStore();
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
    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("connect_error");
      socket.off("queue:update");
    };
  }, [setTasks]);

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
        <div className="masthead">
          <div className="title">Bethaniel</div>
          <div className="subtitle">{t("subtitle")}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-layout">
      <Sidebar
        needsModel={!modelReady}
        onModelInstalled={() => setModelReady(true)}
      />
      <main className="main-content">
        <div className="masthead">
          <div className="title">Bethaniel</div>
          <div className="subtitle">{t("subtitle")}</div>
          <div className="rule" />
        </div>

        <div className="content-layout">
          <div className="main-col">
            <ManuscriptUpload />
            <ScopeSelection />
            <ModeSelector />
            <StyleGuideEditor />
            <EditTrigger />
            <ReviewExport />
          </div>
          <div className="queue-col">
            <QueuePanel />
          </div>
        </div>
      </main>
    </div>
  );
}
