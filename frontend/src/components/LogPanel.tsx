// ── Diagnostic log panel ──
// Floating bottom-right drawer showing engine + task diagnostics streamed
// from the backend via Socket.IO. Surfaces things like model crashes
// (likely OOM or corrupt model) so the user can take action.

import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import type { LogEntry } from "../types";

const BASE = import.meta.env.VITE_API_URL ?? "";

function levelIcon(level: LogEntry["level"]): string {
  if (level === "error") return "✕";
  if (level === "warn") return "!";
  return "i";
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export default function LogPanel() {
  const lang = useStore((s) => s.lang);
  const t = useTranslation(lang);
  const logs = useStore((s) => s.logs);
  const open = useStore((s) => s.logPanelOpen);
  const setOpen = useStore((s) => s.setLogPanelOpen);
  const unread = useStore((s) => s.unreadLogCount);
  const clearLocal = useStore((s) => s.clearLogs);

  // Initial hydrate via REST (covers cases where socket connected before
  // the snapshot handler was attached).
  useEffect(() => {
    if (logs.length === 0) {
      fetch(`${BASE}/api/logs`)
        .then((r) => r.json())
        .then((d) => {
          if (Array.isArray(d.logs) && d.logs.length > 0) {
            useStore.getState().setLogs(d.logs);
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listRef = useRef<HTMLDivElement | null>(null);
  // Auto-scroll to bottom when new entries arrive and panel is open.
  useEffect(() => {
    if (open && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [open, logs.length]);

  const hasErrors = useMemo(
    () => logs.some((e) => e.level === "error"),
    [logs],
  );

  const clearAll = async () => {
    try {
      await fetch(`${BASE}/api/logs`, { method: "DELETE" });
    } catch {
      /* fall through — clear locally anyway */
    }
    clearLocal();
  };

  return (
    <>
      <button
        type="button"
        className={
          "log-fab" +
          (hasErrors ? " log-fab-error" : "") +
          (open ? " open" : "")
        }
        onClick={() => setOpen(!open)}
        aria-label={t("logs_title")}
        title={t("logs_title")}
      >
        <span className="log-fab-icon">⚙</span>
        <span className="log-fab-label">{t("logs_title")}</span>
        {unread > 0 && !open && (
          <span className="log-fab-badge">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>

      {open && (
        <div className="log-panel" role="dialog" aria-label={t("logs_title")}>
          <div className="log-panel-header">
            <strong>{t("logs_title")}</strong>
            <div className="log-panel-actions">
              <button
                type="button"
                className="log-panel-btn"
                onClick={clearAll}
                disabled={logs.length === 0}
              >
                {t("logs_clear")}
              </button>
              <button
                type="button"
                className="log-panel-btn"
                onClick={() => setOpen(false)}
                aria-label={t("logs_hide")}
              >
                ✕
              </button>
            </div>
          </div>

          <div className="log-panel-body" ref={listRef}>
            {logs.length === 0 ? (
              <div className="log-empty">{t("logs_empty")}</div>
            ) : (
              logs.map((e) => {
                const hintKey = e.hintKey;
                const hint = hintKey ? t(hintKey) : e.hint;
                return (
                  <div key={e.id} className={`log-entry log-${e.level}`}>
                    <div className="log-entry-head">
                      <span className={`log-badge log-badge-${e.level}`}>
                        {levelIcon(e.level)}
                      </span>
                      <span className="log-source">{e.source}</span>
                      <span className="log-time">{formatTs(e.ts)}</span>
                    </div>
                    <div className="log-message">{e.message}</div>
                    {hint && hint !== hintKey && (
                      <div className="log-hint">→ {hint}</div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </>
  );
}
