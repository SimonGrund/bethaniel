// ── Queue panel (right column) ──

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { cancelTask, flushQueue } from "../api";
import type { TaskState } from "../types";

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

const STATUS_ICONS: Record<string, string> = {
  queued: "⏳",
  editing: "✏️",
  done: "✅",
  error: "❌",
  cancelled: "⊘",
};

const STATUS_ORDER: Record<string, number> = {
  editing: 0,
  queued: 1,
  done: 2,
  error: 3,
  cancelled: 4,
};

const MODE_ICONS: Record<string, string> = {
  copy_edit: "📝",
  line_edit: "✒️",
  translate: "🌐",
  character_catalog: "👤",
  location_catalog: "📍",
  timeline: "📅",
  combined_analysis: "🔍",
  combined_edit: "📝✒️",
};

function WorkflowDetail({
  mode,
  editOptions,
  targetLang,
  t,
}: {
  mode: string;
  editOptions?: Record<string, boolean>;
  targetLang?: string;
  t: (key: string) => string;
}) {
  if (mode === "translate" && targetLang) {
    return (
      <div className="q-workflow-detail">
        <span className="q-workflow-lang">→ {targetLang}</span>
      </div>
    );
  }

  if (
    (mode === "copy_edit" ||
      mode === "line_edit" ||
      mode === "combined_edit") &&
    editOptions
  ) {
    const activeOpts = Object.entries(editOptions)
      .filter(([, v]) => v)
      .map(([k]) => t(`opt_${k}`));
    if (activeOpts.length === 0) return null;
    return (
      <div className="q-workflow-detail">
        {activeOpts.map((label) => (
          <span key={label} className="q-opt-tag">
            {label}
          </span>
        ))}
      </div>
    );
  }

  return null;
}

function renderTaskRow(
  tid: string,
  s: TaskState,
  isOpen: boolean,
  toggleExpanded: (id: string) => void,
  onCancel: (id: string) => void,
  t: (key: string) => string,
) {
  const pct = Math.round((s.progress ?? 0) * 100);
  const modeIcon = MODE_ICONS[s.mode] ?? "·";
  const canCancel = s.status === "queued" || s.status === "editing";
  return (
    <div key={tid} className={`q-item${isOpen ? " q-item-open" : ""}`}>
      <div
        className="q-item-header"
        onClick={() => toggleExpanded(tid)}
        style={{ cursor: "pointer" }}
      >
        {canCancel && (
          <button
            className="q-cancel-btn"
            title={t("cancel_task")}
            onClick={(e) => {
              e.stopPropagation();
              onCancel(tid);
            }}
          >
            ×
          </button>
        )}
        <span className="q-name">
          {STATUS_ICONS[s.status] ?? "·"} {s.name}{" "}
          <code className="task-id-chip" title={`job ${s.jobId}`}>
            #{s.jobId.slice(0, 8)}
          </code>
        </span>
        <span className="q-mode-badge">
          {modeIcon} {t(`mode_${s.mode}`)}
        </span>
        <span className="q-src">
          {s.source} · {s.wordCount.toLocaleString()} {t("lbl_words")}
        </span>
        <div className={`q-status qs-${s.status}`}>
          {t(`status_${s.status}`)}
          {["editing", "done"].includes(s.status) && ` · ${pct}%`}
          {s.status === "editing" && s.tokPerSec && (
            <span style={{ fontSize: "0.7rem", color: "#6b5c44" }}>
              {" "}
              ({s.tokPerSec} tok/s)
            </span>
          )}
          {s.status === "editing" && s.phase && (
            <span
              title={s.phase}
              style={{
                fontSize: "0.7rem",
                color: "#6b5c44",
                fontStyle: "italic",
              }}
            >
              {" "}
              — {s.phase.length > 40 ? `${s.phase.slice(0, 39)}…` : s.phase}
            </span>
          )}
          {s.finishedAt && s.startedAt && (
            <span className="q-duration">
              {" "}
              · {formatDuration(s.finishedAt - s.startedAt)}
            </span>
          )}
        </div>
        <div className="q-bar">
          <div
            className={`q-fill qs-${s.status}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {isOpen && (
        <div className="q-item-body">
          <div className="q-workflow-summary">
            <strong>{t("workflow_label")}:</strong> {t(`mode_${s.mode}`)}
          </div>
          <WorkflowDetail
            mode={s.mode}
            editOptions={s.editOptions}
            targetLang={s.targetLang}
            t={t}
          />
        </div>
      )}
    </div>
  );
}

export default function QueuePanel() {
  const { lang, tasks } = useStore();
  const t = useTranslation(lang);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showQueued, setShowQueued] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [confirmFlush, setConfirmFlush] = useState(false);
  const [flushing, setFlushing] = useState(false);

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCancelTask = async (id: string) => {
    try {
      await cancelTask(id);
    } catch (err) {
      console.error("Failed to cancel task:", err);
    }
  };

  const handleFlush = async () => {
    if (!confirmFlush) {
      setConfirmFlush(true);
      return;
    }
    setFlushing(true);
    try {
      await flushQueue();
    } catch (err) {
      console.error("Failed to flush queue:", err);
    }
    setFlushing(false);
    setConfirmFlush(false);
  };

  const entries = Object.entries(tasks)
    .filter(([, s]) => s.status === "queued" || s.status === "editing")
    .sort(
      ([, a], [, b]) =>
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
        (a.submittedAt ?? 0) - (b.submittedAt ?? 0),
    );

  const allEntries = Object.entries(tasks).sort(
    ([, a], [, b]) =>
      (a.submittedAt ?? 0) - (b.submittedAt ?? 0),
  );

  const runningEntries = entries.filter(([, s]) => s.status === "editing");
  const queuedEntries = entries.filter(([, s]) => s.status === "queued");
  const finishedEntries = allEntries.filter(
    ([, s]) =>
      s.status === "done" || s.status === "error" || s.status === "cancelled",
  );

  const nq = queuedEntries.length;
  const nr = runningEntries.length;
  const nd = allEntries.filter(([, s]) => s.status === "done").length;
  const ne = allEntries.filter(([, s]) => s.status === "error").length;
  const nc = allEntries.filter(([, s]) => s.status === "cancelled").length;

  const hasActive = nr > 0 || nq > 0;

  return (
    <div className="collapsible-panel">
      <div className="collapsible-header">
        <span className="collapsible-title">{t("queue_panel")}</span>
        <span className="collapsible-badge">
          {nr > 0 && <span className="badge badge-active">{nr} running</span>}
          {nq > 0 && <span className="badge badge-pending">{nq} pending</span>}
          {nd > 0 && <span className="badge badge-done">{nd} done</span>}
          {ne > 0 && <span className="badge badge-error">{ne} failed</span>}
        </span>
      </div>

      <div className="q-panel">
        {allEntries.length === 0 ? (
          <p
            className="small-note"
            style={{ textAlign: "center", padding: "0.8rem 0" }}
          >
            {t("queue_empty")}
          </p>
        ) : (
          <div className="q-items">
            {runningEntries.map(([tid, s]) =>
              renderTaskRow(
                tid,
                s,
                expandedIds.has(tid),
                toggleExpanded,
                handleCancelTask,
                t,
              ),
            )}

            {queuedEntries.length > 0 && (
              <>
                <button
                  type="button"
                  className="q-group-header"
                  onClick={() => setShowQueued((v) => !v)}
                >
                  {showQueued ? "▾" : "▸"} {t("status_queued")} (
                  {queuedEntries.length})
                </button>
                {showQueued &&
                  queuedEntries.map(([tid, s]) =>
                    renderTaskRow(
                      tid,
                      s,
                      expandedIds.has(tid),
                      toggleExpanded,
                      handleCancelTask,
                      t,
                    ),
                  )}
              </>
            )}

            {finishedEntries.length > 0 && (
              <>
                <button
                  type="button"
                  className="q-group-header"
                  onClick={() => setShowDone((v) => !v)}
                >
                  {showDone ? "▾" : "▸"} {t("n_done")} ({finishedEntries.length}
                  )
                </button>
                {showDone &&
                  finishedEntries.map(([tid, s]) =>
                    renderTaskRow(
                      tid,
                      s,
                      expandedIds.has(tid),
                      toggleExpanded,
                      handleCancelTask,
                      t,
                    ),
                  )}
              </>
            )}
          </div>
        )}

        {entries.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.5rem" }}>
            <button
              className={`q-flush-btn${confirmFlush ? " q-flush-confirm" : ""}`}
              onClick={handleFlush}
              disabled={flushing}
              title={t("clear_all")}
            >
              {flushing ? "…" : confirmFlush ? `${t("clear_all")}?` : t("clear_all")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
