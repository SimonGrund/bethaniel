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
  // The Diagnostics panel shows errors only — the full engine flow is rendered
  // in the sidebar's Engine section. Errors accumulate and persist here until
  // the user clears the log.
  const errorLogs = useStore((s) => s.errorLogs);
  const open = useStore((s) => s.logPanelOpen);
  const setOpen = useStore((s) => s.setLogPanelOpen);
  const unread = useStore((s) => s.unreadLogCount);
  const clearLocal = useStore((s) => s.clearLogs);
  const downloads = useStore((s) => s.downloads);

  const activeDownloads = useMemo(() => Object.values(downloads), [downloads]);

  // Run progress, shown the same way a download is: a labelled bar in the
  // diagnostics panel.
  //
  // Every job with a figure is listed, running or not — asked for explicitly so
  // the completion percentage is always readable here, rather than vanishing
  // the moment a run ends and leaving nothing to look back at. In-flight jobs
  // sort first so a live run is never buried under finished ones.
  const runStats = useStore((s) => s.runStats);
  const tasks = useStore((s) => s.tasks);
  const activeRuns = useMemo(() => {
    const live = new Set(
      Object.values(tasks)
        .filter((t) => t.status === "queued" || t.status === "editing")
        .map((t) => t.jobId),
    );
    return Object.entries(runStats?.jobProgress ?? {}).sort(
      ([a], [b]) => Number(live.has(b)) - Number(live.has(a)),
    );
  }, [runStats, tasks]);

  const rt = runStats?.runtime;
  const throughput =
    rt && rt.activeStreams > 0
      ? t("run_throughput")
          .replace("{rate}", String(rt.aggregateTokPerSec))
          .replace("{streams}", String(rt.activeStreams))
      : null;
  // Representative figure for the collapsed FAB: the least-complete download.
  const minPercent = useMemo(
    () =>
      activeDownloads.length === 0
        ? 0
        : Math.min(...activeDownloads.map((d) => d.percent)),
    [activeDownloads],
  );

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
  }, [open, errorLogs.length]);

  const hasErrors = errorLogs.length > 0;

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
        {activeDownloads.length > 0 && (
          <span className="log-fab-download-badge">
            {activeDownloads.length > 1
              ? `⬇${activeDownloads.length}`
              : `${minPercent}%`}
          </span>
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
                disabled={errorLogs.length === 0}
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
            {activeRuns.length > 0 && (
              <div className="log-downloads">
                <div className="log-downloads-title">
                  {t("logs_progress_title")}
                </div>
                {activeRuns.map(([jobId, p]) => {
                  const pct = Math.round(p.fraction * 100);
                  return (
                    <div key={jobId} className="log-download-row">
                      <span className="log-download-name" title={jobId}>
                        {p.wordsTotal
                          ? t("logs_progress_words")
                              .replace("{done}", p.wordsDone.toLocaleString())
                              .replace("{total}", p.wordsTotal.toLocaleString())
                          : t("logs_progress_title")}
                      </span>
                      <span
                        className="model-progress-bar"
                        role="progressbar"
                        aria-valuenow={pct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <span
                          className="model-progress-fill"
                          style={{ width: `${pct}%` }}
                        />
                      </span>
                      <span className="log-download-percent">{pct}%</span>
                    </div>
                  );
                })}
                {throughput && (
                  <div className="log-progress-sub">{throughput}</div>
                )}
              </div>
            )}
            {activeDownloads.length > 0 && (
              <div className="log-downloads">
                <div className="log-downloads-title">
                  {t("logs_downloads_title")}
                </div>
                {activeDownloads.map((d) => (
                  <div key={d.modelId} className="log-download-row">
                    <span className="log-download-name" title={d.name ?? d.modelId}>
                      {d.name ?? d.modelId}
                    </span>
                    <span className="model-progress-bar">
                      <span
                        className="model-progress-fill"
                        style={{ width: `${d.percent}%` }}
                      />
                    </span>
                    <span className="log-download-percent">{d.percent}%</span>
                  </div>
                ))}
              </div>
            )}
            {errorLogs.length === 0 ? (
              activeDownloads.length === 0 && (
                <div className="log-empty">{t("logs_empty")}</div>
              )
            ) : (
              errorLogs.map((e) => {
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
