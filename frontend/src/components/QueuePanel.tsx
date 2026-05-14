// ── Queue panel (right column) ──

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { cancelQueue, clearQueue } from "../api";

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

export default function QueuePanel() {
  const { lang, tasks } = useStore();
  const t = useTranslation(lang);

  const entries = Object.entries(tasks).sort(
    ([, a], [, b]) =>
      (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
      (a.submittedAt ?? 0) - (b.submittedAt ?? 0),
  );

  const nq = entries.filter(([, s]) => s.status === "queued").length;
  const nr = entries.filter(([, s]) => s.status === "editing").length;
  const nd = entries.filter(([, s]) => s.status === "done").length;
  const ne = entries.filter(([, s]) => s.status === "error").length;
  const nc = entries.filter(([, s]) => s.status === "cancelled").length;

  return (
    <div className="q-panel">
      <div className="q-title">
        {t("queue_panel")}{" "}
        <span style={{ fontSize: "0.8rem", fontWeight: 400, color: "#6b5c44" }}>
          {entries.length}
        </span>
      </div>
      <div className="q-counts">
        {nq} {t("n_pending")} · {nr} {t("n_running")} · {nd} {t("n_done")}
        {ne > 0 && ` · ⚠️ ${ne}`}
      </div>

      {entries.length === 0 ? (
        <p
          className="small-note"
          style={{ textAlign: "center", padding: "0.8rem 0" }}
        >
          {t("queue_empty")}
        </p>
      ) : (
        <div className="q-items">
          {entries.map(([tid, s]) => {
            const pct = Math.round((s.progress ?? 0) * 100);
            return (
              <div key={tid} className="q-item">
                <span className="q-name">
                  {STATUS_ICONS[s.status] ?? "·"} {s.name}
                </span>
                <span className="q-src">
                  {s.source} · {s.wordCount.toLocaleString()} {t("lbl_words")}
                </span>
                <div className={`q-status qs-${s.status}`}>
                  {t(`status_${s.status}`)}
                  {["editing", "done"].includes(s.status) && ` · ${pct}%`}
                  {s.status === "editing" && s.phase && (
                    <span
                      style={{
                        fontSize: "0.7rem",
                        color: "#6b5c44",
                        fontStyle: "italic",
                      }}
                    >
                      {" "}
                      — {s.phase}
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
            );
          })}
        </div>
      )}

      <div className="q-actions">
        {nd + ne + nc > 0 && (
          <button className="btn-secondary" onClick={() => clearQueue()}>
            {t("clear_done")}
          </button>
        )}
        {nq + nr > 0 && (
          <button
            className="btn-primary btn-danger"
            onClick={() => cancelQueue()}
          >
            {t("btn_cancel")}
          </button>
        )}
      </div>
    </div>
  );
}
