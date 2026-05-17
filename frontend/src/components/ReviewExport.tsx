// ── Review & Export — Stage IV ──

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { exportDocx, retryTask, clearQueue } from "../api";
import type { TaskState, Correction } from "../types";
import { ANALYSIS_MODES } from "../types";

const BASE = import.meta.env.VITE_API_URL ?? "";

/**
 * Extract a numeric sort key from a chapter name so tasks render
 * in manuscript order (Ch 1, Ch 2, …) rather than completion order.
 * Names without a number sort to Infinity (end of list).
 */
function chapterSortKey(name: string): number {
  const m = name.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : Infinity;
}

/** Format a task's wall-clock duration as a human-readable string. */
function formatDuration(task: TaskState): string | null {
  if (!task.startedAt || !task.finishedAt) return null;
  const ms = task.finishedAt - task.startedAt;
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

/** Apply only accepted corrections to the original text. */
function applyAccepted(
  originalText: string,
  corrections: Correction[],
  acceptedIds: Set<string>,
): string {
  // Filter to only accepted corrections, apply them one by one.
  // Work through the text replacing each accepted correction's original → corrected.
  // To avoid double-replacing, sort by position (first occurrence) and apply from end to start.
  const toApply = corrections.filter((c) => c.id && acceptedIds.has(c.id));
  if (toApply.length === 0) return originalText;

  // Find positions and apply from last to first so indices don't shift
  const positioned = toApply
    .map((c) => {
      const idx = originalText.indexOf(c.original);
      return { correction: c, index: idx };
    })
    .filter((p) => p.index >= 0)
    .sort((a, b) => b.index - a.index); // reverse order

  let result = originalText;
  for (const { correction, index } of positioned) {
    result =
      result.slice(0, index) +
      correction.corrected +
      result.slice(index + correction.original.length);
  }
  return result;
}

function InlineDiff({ before, after }: { before: string; after: string }) {
  // Simple word-level diff in React
  const aWords: string[] = before.match(/\s+|\w+|[^\w\s]/g) ?? [];
  const bWords: string[] = after.match(/\s+|\w+|[^\w\s]/g) ?? [];

  // LCS-based diff (simple approach for UI)
  const parts: { type: "equal" | "del" | "ins"; text: string }[] = [];
  let ai = 0,
    bi = 0;

  // Use a basic approach: find common subsequences
  while (ai < aWords.length && bi < bWords.length) {
    if (aWords[ai] === bWords[bi]) {
      parts.push({ type: "equal", text: aWords[ai] });
      ai++;
      bi++;
    } else {
      // Look ahead in B for current A word
      const bLook = bWords.indexOf(aWords[ai], bi);
      const aLook = aWords.indexOf(bWords[bi], ai);

      if (bLook >= 0 && (aLook < 0 || bLook - bi <= aLook - ai)) {
        // B has extra words (insertions)
        for (let j = bi; j < bLook; j++) {
          parts.push({ type: "ins", text: bWords[j] });
        }
        bi = bLook;
      } else if (aLook >= 0) {
        // A has extra words (deletions)
        for (let j = ai; j < aLook; j++) {
          parts.push({ type: "del", text: aWords[j] });
        }
        ai = aLook;
      } else {
        // Replace
        parts.push({ type: "del", text: aWords[ai] });
        parts.push({ type: "ins", text: bWords[bi] });
        ai++;
        bi++;
      }
    }
  }
  while (ai < aWords.length) {
    parts.push({ type: "del", text: aWords[ai++] });
  }
  while (bi < bWords.length) {
    parts.push({ type: "ins", text: bWords[bi++] });
  }

  return (
    <span className="correction-diff">
      {parts.map((p, i) => {
        if (p.type === "del")
          return (
            <span key={i} className="word-del">
              {p.text}
            </span>
          );
        if (p.type === "ins")
          return (
            <span key={i} className="word-ins">
              {p.text}
            </span>
          );
        return <span key={i}>{p.text}</span>;
      })}
    </span>
  );
}

function CorrectionCard({
  correction,
  taskId,
  accepted,
  onToggle,
}: {
  correction: Correction;
  taskId: string;
  accepted: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`correction-card ${accepted ? "accepted" : ""}`}
      onClick={onToggle}
    >
      <div className="correction-check">{accepted ? "☑" : "☐"}</div>
      {correction.chunk && (
        <div
          style={{
            fontSize: "0.75rem",
            color: "#64748b",
            marginBottom: "0.25rem",
          }}
        >
          {correction.chunk}
        </div>
      )}
      <InlineDiff before={correction.original} after={correction.corrected} />
    </div>
  );
}

function StructuredDataView({
  mode,
  data,
  t,
}: {
  mode: string;
  data: unknown;
  t: (key: string) => string;
}) {
  if (!data)
    return <p className="correction-empty">{t("no_structured_data")}</p>;

  if (mode === "character_catalog") {
    const items = (
      Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>).characters ?? [])
    ) as Array<Record<string, unknown>>;
    return (
      <table className="catalog-table">
        <thead>
          <tr>
            <th>{t("col_name")}</th>
            <th>{t("col_aliases")}</th>
            <th>{t("col_chapter")}</th>
            <th>{t("col_description")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c, i) => (
            <tr key={i}>
              <td>{String(c.name ?? "")}</td>
              <td>{(c.aliases as string[] | undefined)?.join(", ")}</td>
              <td>
                {(c.chapters as string[] | undefined)?.join(", ") ??
                  String(c.firstMention ?? "")}
              </td>
              <td>
                {String(c.physicalDescription ?? c.description ?? c.role ?? "")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (mode === "location_catalog") {
    const items = (
      Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>).locations ?? [])
    ) as Array<Record<string, unknown>>;
    return (
      <table className="catalog-table">
        <thead>
          <tr>
            <th>{t("col_name")}</th>
            <th>{t("col_aliases")}</th>
            <th>{t("col_chapter")}</th>
            <th>{t("col_description")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((l, i) => (
            <tr key={i}>
              <td>{String(l.name ?? "")}</td>
              <td>{(l.aliases as string[] | undefined)?.join(", ")}</td>
              <td>
                {(l.chapters as string[] | undefined)?.join(", ") ??
                  String(l.firstMention ?? "")}
              </td>
              <td>{String(l.description ?? l.significance ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (mode === "timeline") {
    const items = (
      Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>).events ?? [])
    ) as Array<Record<string, unknown>>;
    return (
      <table className="catalog-table">
        <thead>
          <tr>
            <th>{t("col_chapter")}</th>
            <th>{t("col_event")}</th>
            <th>{t("col_characters")}</th>
            <th>{t("col_time_ref")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e, i) => (
            <tr key={i}>
              <td>{String(e.chapter ?? "")}</td>
              <td>{String(e.description ?? e.event ?? "")}</td>
              <td>{(e.characters as string[] | undefined)?.join(", ")}</td>
              <td>{String(e.timeReference ?? "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // Fallback: pretty-print JSON
  return <pre className="json-preview">{JSON.stringify(data, null, 2)}</pre>;
}

/** Combined analysis renders each sub-section that exists in the data */
function CombinedAnalysisView({
  data,
  t,
}: {
  data: unknown;
  t: (key: string) => string;
}) {
  if (!data || typeof data !== "object")
    return <p className="correction-empty">{t("no_structured_data")}</p>;

  const obj = data as Record<string, unknown>;
  const sections: React.ReactNode[] = [];

  if (obj.characters) {
    sections.push(
      <div key="chars">
        <h4 style={{ margin: "0.6rem 0 0.2rem" }}>
          {t("mode_character_catalog")}
        </h4>
        <StructuredDataView mode="character_catalog" data={obj} t={t} />
      </div>,
    );
  }
  if (obj.locations) {
    sections.push(
      <div key="locs">
        <h4 style={{ margin: "0.6rem 0 0.2rem" }}>
          {t("mode_location_catalog")}
        </h4>
        <StructuredDataView mode="location_catalog" data={obj} t={t} />
      </div>,
    );
  }
  if (obj.events) {
    sections.push(
      <div key="events">
        <h4 style={{ margin: "0.6rem 0 0.2rem" }}>{t("mode_timeline")}</h4>
        <StructuredDataView mode="timeline" data={obj} t={t} />
      </div>,
    );
  }

  if (sections.length === 0) {
    return <pre className="json-preview">{JSON.stringify(data, null, 2)}</pre>;
  }

  return <>{sections}</>;
}

function isAnalysisMode(mode?: string): boolean {
  return ANALYSIS_MODES.includes(mode as never);
}

/**
 * Minimal Markdown renderer — handles `##`/`###` headings, `- ` bullets,
 * blank-line paragraphs, and inline `**bold**` / `*italic*` / `` `code` ``.
 * Just enough for the synthesis prose; no external deps.
 */
function MarkdownView({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const renderInline = (s: string): React.ReactNode[] => {
    // Order matters: code first (so its content isn't bolded), then bold, italic.
    const parts: React.ReactNode[] = [];
    const re =
      /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;
    let lastIdx = 0;
    let m: RegExpExecArray | null;
    let pkey = 0;
    while ((m = re.exec(s)) !== null) {
      if (m.index > lastIdx) parts.push(s.slice(lastIdx, m.index));
      const tok = m[0];
      if (tok.startsWith("`")) {
        parts.push(<code key={pkey++}>{tok.slice(1, -1)}</code>);
      } else if (tok.startsWith("**") || tok.startsWith("__")) {
        parts.push(<strong key={pkey++}>{tok.slice(2, -2)}</strong>);
      } else {
        parts.push(<em key={pkey++}>{tok.slice(1, -1)}</em>);
      }
      lastIdx = m.index + tok.length;
    }
    if (lastIdx < s.length) parts.push(s.slice(lastIdx));
    return parts;
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^###\s+/.test(line)) {
      blocks.push(
        <h4 key={key++}>{renderInline(line.replace(/^###\s+/, ""))}</h4>,
      );
      i++;
    } else if (/^##\s+/.test(line)) {
      blocks.push(
        <h3 key={key++}>{renderInline(line.replace(/^##\s+/, ""))}</h3>,
      );
      i++;
    } else if (/^#\s+/.test(line)) {
      blocks.push(
        <h3 key={key++}>{renderInline(line.replace(/^#\s+/, ""))}</h3>,
      );
      i++;
    } else if (/^[-*]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(
          <li key={items.length}>
            {renderInline(lines[i].replace(/^[-*]\s+/, ""))}
          </li>,
        );
        i++;
      }
      blocks.push(<ul key={key++}>{items}</ul>);
    } else {
      const paraLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !/^(#{1,3}\s+|[-*]\s+)/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push(<p key={key++}>{renderInline(paraLines.join(" "))}</p>);
    }
  }

  return <div className="markdown-view">{blocks}</div>;
}

// ── Cross-chapter aggregation for analysis tasks ─────────────────────────────

/** Natural compare so "Ch2" sorts before "Ch10". */
function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

interface NamedAccum {
  name: string;
  aliases: Set<string>;
  chapters: Set<string>;
  descriptions: string[];
}

function mergeNamedItems(
  items: Array<Record<string, unknown>>,
  chapterFallback: string,
  accum: Map<string, NamedAccum>,
) {
  for (const it of items) {
    const name = String(it.name ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = accum.get(key) ?? {
      name,
      aliases: new Set<string>(),
      chapters: new Set<string>(),
      descriptions: [] as string[],
    };
    for (const a of (it.aliases as string[] | undefined) ?? []) {
      if (a) entry.aliases.add(a);
    }
    const chs = (it.chapters as string[] | undefined) ?? null;
    if (chs && chs.length) {
      for (const c of chs) entry.chapters.add(String(c));
    } else if (it.firstMention) {
      entry.chapters.add(String(it.firstMention));
    } else {
      entry.chapters.add(chapterFallback);
    }
    const desc = String(
      it.physicalDescription ??
        it.description ??
        it.significance ??
        it.role ??
        "",
    ).trim();
    if (desc) entry.descriptions.push(desc);
    accum.set(key, entry);
  }
}

function finalizeNamed(
  accum: Map<string, NamedAccum>,
): Array<Record<string, unknown>> {
  return Array.from(accum.values())
    .map((e) => ({
      name: e.name,
      aliases: Array.from(e.aliases),
      chapters: Array.from(e.chapters).sort(naturalCompare),
      description: e.descriptions.sort((a, b) => b.length - a.length)[0] ?? "",
    }))
    .sort((a, b) => naturalCompare(a.name as string, b.name as string));
}

function pickList(data: unknown, key: string): Array<Record<string, unknown>> {
  if (!data) return [];
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  const v = (data as Record<string, unknown>)[key];
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

/**
 * Merge the structuredData from many per-chapter analysis tasks of a single
 * mode (or combined_analysis) into a single object shaped like a single-task
 * result, suitable for re-use with StructuredDataView/CombinedAnalysisView.
 */
function aggregateAnalysisTasks(tasks: TaskState[]): Record<string, unknown> {
  const chars = new Map<string, NamedAccum>();
  const locs = new Map<string, NamedAccum>();
  const events: Array<Record<string, unknown>> = [];
  let anyChars = false;
  let anyLocs = false;
  let anyEvents = false;

  for (const task of tasks) {
    const data = task.result?.structuredData;
    if (!data) continue;
    const chapter = task.name;

    // Characters: present in character_catalog (bare or {characters})
    // or in combined_analysis.characters
    const charItems =
      task.mode === "character_catalog"
        ? Array.isArray(data)
          ? (data as Array<Record<string, unknown>>)
          : pickList(data, "characters")
        : pickList(data, "characters");
    if (charItems.length) {
      anyChars = true;
      mergeNamedItems(charItems, chapter, chars);
    }

    const locItems =
      task.mode === "location_catalog"
        ? Array.isArray(data)
          ? (data as Array<Record<string, unknown>>)
          : pickList(data, "locations")
        : pickList(data, "locations");
    if (locItems.length) {
      anyLocs = true;
      mergeNamedItems(locItems, chapter, locs);
    }

    const eventItems =
      task.mode === "timeline"
        ? Array.isArray(data)
          ? (data as Array<Record<string, unknown>>)
          : pickList(data, "events")
        : pickList(data, "events");
    if (eventItems.length) {
      anyEvents = true;
      for (const ev of eventItems) {
        events.push({
          chapter: String(ev.chapter ?? chapter),
          description: ev.description ?? ev.event ?? "",
          characters: ev.characters ?? [],
          timeReference: ev.timeReference ?? "",
        });
      }
    }
  }

  events.sort((a, b) => naturalCompare(String(a.chapter), String(b.chapter)));

  const out: Record<string, unknown> = {};
  if (anyChars) out.characters = finalizeNamed(chars);
  if (anyLocs) out.locations = finalizeNamed(locs);
  if (anyEvents) out.events = events;
  return out;
}

export default function ReviewExport() {
  const {
    lang,
    tasks,
    acceptedCorrections,
    toggleCorrection,
    acceptAll,
    dismissAll,
  } = useStore();
  const t = useTranslation(lang);
  const [confirmClear, setConfirmClear] = useState(false);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const latestRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetch(`${BASE}/api/models/catalog`)
      .then((r) => r.json())
      .then((data) => {
        const map: Record<string, string> = {};
        for (const entry of data.catalog ?? []) {
          map[entry.fileName] = entry.name;
        }
        setModelNames(map);
      })
      .catch(() => {});
  }, []);

  const handleDownloadDocx = useCallback(
    async (markdown: string, filename: string) => {
      try {
        const blob = await exportDocx(markdown);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("DOCX export failed:", err);
      }
    },
    [],
  );

  const handleRetry = useCallback(async (taskId: string) => {
    try {
      await retryTask(taskId);
    } catch (err) {
      console.error("Retry failed:", err);
      alert(
        `Retry failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  const visibleTasks = Object.entries(tasks).filter(
    ([, s]) => s.status !== "queued",
  );
  if (visibleTasks.length === 0) return null;

  // Group by job (one per "Start job" click), then sort newest first by submittedAt
  const byJob: Record<string, [string, TaskState][]> = {};
  for (const [tid, task] of visibleTasks) {
    const jid = task.jobId ?? "legacy";
    if (!byJob[jid]) byJob[jid] = [];
    byJob[jid].push([tid, task]);
  }
  const jobEntries = Object.entries(byJob).sort(([, aTasks], [, bTasks]) => {
    const a = Math.max(...aTasks.map(([, t]) => t.submittedAt ?? 0));
    const b = Math.max(...bTasks.map(([, t]) => t.submittedAt ?? 0));
    return b - a;
  });

  const downloadFile = (
    content: string,
    filename: string,
    type = "text/markdown",
  ) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="review-panel">
      {confirmClear && (
        <div className="modal-backdrop">
          <div className="modal-dialog">
            <p>{t("clear_warning")}</p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn-primary btn-danger"
                onClick={() => {
                  setConfirmClear(false);
                  clearQueue();
                }}
              >
                {t("clear_all")}
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setConfirmClear(false)}
              >
                {t("btn_cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {jobEntries.length === 0 && (
        <p className="review-empty-state">{t("review_empty")}</p>
      )}
      {(() => {
        const rendered = jobEntries.map(([jid, rawEntries], jobIndex) => {
          const isLatest = jobIndex === 0;
          // Sort tasks by chapter number so they appear in manuscript order.
          const entries = [...rawEntries].sort(
            ([, a], [, b]) => chapterSortKey(a.name) - chapterSortKey(b.name),
          );
          const totalCorrections = entries.reduce(
            (n, [, task]) => n + (task.result?.corrections.length ?? 0),
            0,
          );
          const runningCount = entries.filter(
            ([, t]) => t.status === "editing",
          ).length;
          // A task is "partial" if it has results but with chunk-level errors
          // (the model failed to process some chunks even after retries).
          // We count any errored task with chapter-name (i.e. excluding the
          // job-wide summary) as a chapter that should be re-run.
          const failedTasks = entries.filter(
            ([, t]) => t.status === "error" && t.mode !== "analysis_summary",
          );
          const failedChapters = failedTasks.map(([, t]) => t.name);
          const src = entries[0]?.[1].source ?? "manuscript";
          const submittedAt = Math.max(
            ...entries.map(([, t]) => t.submittedAt ?? 0),
          );
          const submittedDate = new Date(submittedAt).toLocaleString();
          // Collect distinct models used across the job's tasks. Older tasks
          // (created before `model` was promoted onto TaskState) won't have it,
          // and that's fine — we just omit them.
          const jobModels = Array.from(
            new Set(
              entries
                .map(([, t]) => t.model)
                .filter(
                  (m): m is string => typeof m === "string" && m.length > 0,
                ),
            ),
          ).map((m) => modelNames[m] ?? m);
          const jobNode = (
            <details
              key={jid}
              className="review-group"
              open={isLatest || undefined}
            >
              <summary className="review-source">
                {t("results_for")} {src}{" "}
                <code className="task-id-chip" title={`job ${jid}`}>
                  #{jid.slice(0, 8)}
                </code>{" "}
                <span className="review-source-meta">
                  {submittedDate} · {entries.length}{" "}
                  {entries.length === 1 ? "task" : "tasks"}
                  {jobModels.length > 0 ? ` · ${jobModels.join(", ")}` : ""}
                  {runningCount > 0 ? ` · ${runningCount} running` : ""}
                  {failedChapters.length > 0 ? (
                    <span className="review-failed-meta">
                      {" "}
                      · ⚠ {failedChapters.length}{" "}
                      {failedChapters.length === 1 ? "failed" : "failed"}
                    </span>
                  ) : null}
                  {totalCorrections > 0
                    ? ` · ${totalCorrections} corrections`
                    : ""}
                </span>
              </summary>

              {failedChapters.length > 0 && (
                <div className="review-warning-banner">
                  <strong>⚠ {t("partial_failure_title")}</strong>
                  <p>
                    {t("partial_failure_body")}
                    {": "}
                    <em>{failedChapters.join(", ")}</em>
                  </p>
                  <p className="small-note">{t("partial_failure_hint")}</p>
                  <div className="review-warning-actions">
                    <button
                      type="button"
                      className="btn-retry"
                      onClick={() => {
                        for (const [tid] of failedTasks) {
                          void handleRetry(tid);
                        }
                      }}
                    >
                      ↻ {t("retry_failed_chapters")} ({failedTasks.length})
                    </button>
                  </div>
                </div>
              )}

              {/* ── Prose synthesis (primary output for analysis jobs) ── */}
              {(() => {
                const summaryTask = entries
                  .map(([, t]) => t)
                  .find((t) => t.mode === "analysis_summary");
                if (!summaryTask) return null;

                if (
                  summaryTask.status !== "done" ||
                  !summaryTask.result?.editedText
                ) {
                  const pct = Math.round((summaryTask.progress ?? 0) * 100);
                  return (
                    <details className="review-task" open>
                      <summary className="review-task-summary">
                        <span
                          className={`task-status-pill qs-${summaryTask.status}`}
                        >
                          {t(`status_${summaryTask.status}`)}
                        </span>{" "}
                        {t("prose_summary")}
                      </summary>
                      <div className="task-placeholder">
                        {summaryTask.status === "editing" && (
                          <>
                            <div className="q-bar">
                              <div
                                className={`q-fill qs-${summaryTask.status}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <p className="small-note">
                              {pct}%
                              {summaryTask.phase
                                ? ` — ${summaryTask.phase}`
                                : ""}
                            </p>
                          </>
                        )}
                        {summaryTask.status === "error" && (
                          <p className="error-item">
                            ⚠️{" "}
                            {summaryTask.result?.errors?.join("; ") ??
                              t("status_error")}
                          </p>
                        )}
                      </div>
                    </details>
                  );
                }

                return (
                  <details className="review-task review-summary-card" open>
                    <summary className="review-task-summary">
                      <strong>{t("prose_summary")}</strong>
                    </summary>
                    <MarkdownView text={summaryTask.result.editedText} />
                    <div className="export-buttons">
                      <button
                        className="btn-secondary"
                        onClick={() =>
                          downloadFile(
                            summaryTask.result!.editedText,
                            `${src}.summary.md`,
                            "text/markdown",
                          )
                        }
                      >
                        Download Markdown
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() =>
                          handleDownloadDocx(
                            summaryTask.result!.editedText,
                            `${src}.summary.docx`,
                          )
                        }
                      >
                        Download DOCX
                      </button>
                    </div>
                  </details>
                );
              })()}

              {/* ── Aggregated analysis sections (one per analysis mode) ── */}
              {(() => {
                const analysisByMode = new Map<string, TaskState[]>();
                for (const [, task] of entries) {
                  if (
                    isAnalysisMode(task.mode) &&
                    task.result?.structuredData
                  ) {
                    const arr = analysisByMode.get(task.mode) ?? [];
                    arr.push(task);
                    analysisByMode.set(task.mode, arr);
                  }
                }
                if (analysisByMode.size === 0) return null;
                const hasSummary = entries.some(
                  ([, t]) => t.mode === "analysis_summary",
                );
                return (
                  <details className="review-task" open={!hasSummary}>
                    <summary className="review-task-summary">
                      {t("detailed_analysis_data")}
                    </summary>
                    {Array.from(analysisByMode.entries()).map(
                      ([mode, modeTasks]) => {
                        const merged = aggregateAnalysisTasks(modeTasks);
                        const modeLabel = t(`mode_${mode}`);
                        return (
                          <details key={`agg-${mode}`} className="review-task">
                            <summary className="review-task-summary">
                              {modeLabel} — {t("aggregated_summary")} (
                              {modeTasks.length}{" "}
                              {modeTasks.length === 1 ? "chapter" : "chapters"})
                            </summary>
                            {mode === "combined_analysis" ? (
                              <CombinedAnalysisView data={merged} t={t} />
                            ) : mode === "character_catalog" ? (
                              <StructuredDataView
                                mode="character_catalog"
                                data={merged}
                                t={t}
                              />
                            ) : mode === "location_catalog" ? (
                              <StructuredDataView
                                mode="location_catalog"
                                data={merged}
                                t={t}
                              />
                            ) : (
                              <StructuredDataView
                                mode="timeline"
                                data={merged}
                                t={t}
                              />
                            )}
                            <div className="export-buttons">
                              <button
                                className="btn-secondary"
                                onClick={() =>
                                  downloadFile(
                                    JSON.stringify(merged, null, 2),
                                    `${src}.${mode}.merged.json`,
                                    "application/json",
                                  )
                                }
                              >
                                Download merged JSON
                              </button>
                            </div>

                            <details className="review-task">
                              <summary className="review-task-summary">
                                {t("per_chapter_breakdown")}
                              </summary>
                              {modeTasks.map((task) => (
                                <details
                                  key={`agg-${mode}-${task.id}`}
                                  className="review-task"
                                >
                                  <summary className="review-task-summary">
                                    {task.name}
                                  </summary>
                                  {mode === "combined_analysis" ? (
                                    <CombinedAnalysisView
                                      data={task.result!.structuredData}
                                      t={t}
                                    />
                                  ) : (
                                    <StructuredDataView
                                      mode={mode}
                                      data={task.result!.structuredData}
                                      t={t}
                                    />
                                  )}
                                  {task.result!.errors.length > 0 && (
                                    <div className="error-list">
                                      {task.result!.errors.map((e, i) => (
                                        <p key={i} className="error-item">
                                          ⚠️ {e}
                                        </p>
                                      ))}
                                    </div>
                                  )}
                                </details>
                              ))}
                            </details>
                          </details>
                        );
                      },
                    )}
                  </details>
                );
              })()}

              {entries.map(([tid, task]) => {
                const result = task.result;

                // Analysis tasks with results are rendered in the aggregated
                // section above; skip them here.
                if (isAnalysisMode(task.mode) && result?.structuredData) {
                  return null;
                }
                // The synthesis task is rendered as its own primary card above.
                if (task.mode === "analysis_summary") {
                  return null;
                }

                // ── Placeholder for in-progress / errored / cancelled (no result yet) ──
                if (!result) {
                  const pct = Math.round((task.progress ?? 0) * 100);
                  return (
                    <details key={tid} className="review-task">
                      <summary className="review-task-summary">
                        <span className={`task-status-pill qs-${task.status}`}>
                          {t(`status_${task.status}`)}
                        </span>{" "}
                        {task.name} — {t(`mode_${task.mode}`)}
                        {formatDuration(task) && (
                          <span className="task-duration">
                            {" "}
                            ({formatDuration(task)})
                          </span>
                        )}
                      </summary>
                      <div className="task-placeholder">
                        {task.status === "editing" && (
                          <>
                            <div className="q-bar">
                              <div
                                className={`q-fill qs-${task.status}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <p className="small-note">
                              {pct}%{task.phase ? ` — ${task.phase}` : ""}
                            </p>
                          </>
                        )}
                        {task.status === "error" && (
                          <>
                            <p className="error-item">⚠️ {t("status_error")}</p>
                            <button
                              type="button"
                              className="btn-retry"
                              onClick={() => void handleRetry(tid)}
                            >
                              ↻ {t("retry_task")}
                            </button>
                          </>
                        )}
                        {task.status === "cancelled" && (
                          <>
                            <p className="small-note">
                              {t("status_cancelled")}
                            </p>
                            <button
                              type="button"
                              className="btn-retry"
                              onClick={() => void handleRetry(tid)}
                            >
                              ↻ {t("retry_task")}
                            </button>
                          </>
                        )}
                      </div>
                    </details>
                  );
                }

                // ── Edit / translate mode: show corrections ──
                const accepted = acceptedCorrections[tid] ?? new Set<string>();
                const corrections = result.corrections;
                const isTranslation = task.mode === "translate";
                const hasChanges = isTranslation
                  ? result.editedText !== result.originalText
                  : corrections.length > 0;
                const summary = isTranslation
                  ? `${task.name} — ${t("mode_translate")}`
                  : hasChanges
                    ? `${task.name} — ${corrections.length} correction(s)`
                    : `${task.name} — ${t("no_changes")}`;
                const dur = formatDuration(task);

                return (
                  <details key={tid} className="review-task">
                    <summary className="review-task-summary">
                      {task.status === "error" && (
                        <span className="task-status-pill qs-error">
                          {t("status_error")}
                        </span>
                      )}{" "}
                      {summary}
                      {dur && <span className="task-duration"> ({dur})</span>}
                      {task.status === "error" && (
                        <button
                          type="button"
                          className="btn-retry btn-retry-inline"
                          onClick={(e) => {
                            e.preventDefault();
                            void handleRetry(tid);
                          }}
                        >
                          ↻ {t("retry_task")}
                        </button>
                      )}
                    </summary>

                    {isTranslation ? (
                      /* Translation: show a preview of the translated text */
                      hasChanges ? (
                        <pre className="json-preview">
                          {result.editedText.slice(0, 2000)}
                          {result.editedText.length > 2000 ? "\n…" : ""}
                        </pre>
                      ) : (
                        <p className="correction-empty">
                          {t("no_corrections_unit")}
                        </p>
                      )
                    ) : !hasChanges ? (
                      <p className="correction-empty">
                        {t("no_corrections_unit")}
                      </p>
                    ) : (
                      <>
                        <div className="review-actions">
                          <button
                            className="btn-small"
                            onClick={() => acceptAll(tid)}
                          >
                            {t("accept_all")}
                          </button>
                          <button
                            className="btn-small"
                            onClick={() => dismissAll(tid)}
                          >
                            {t("dismiss_all")}
                          </button>
                          <span className="small-note">
                            {accepted.size} {t("of")} {corrections.length}{" "}
                            {t("proposed_changes")}
                          </span>
                        </div>

                        {corrections.map((c, i) => (
                          <CorrectionCard
                            key={c.id ?? i}
                            correction={c}
                            taskId={tid}
                            accepted={accepted.has(c.id ?? "")}
                            onToggle={() => toggleCorrection(tid, c.id ?? "")}
                          />
                        ))}

                        {result.skipped.length > 0 && (
                          <div className="skipped-section-wrapper">
                            <details className="skipped-section">
                              <summary className="small-note">
                                {result.skipped.length} {t("skipped_label")}
                              </summary>
                              {result.skipped.map((s, i) => (
                                <div key={i} className="skipped-item">
                                  <span className="word-del">{s.original}</span>
                                  {" → "}
                                  <span className="word-ins">
                                    {s.corrected}
                                  </span>
                                  {s.reason && (
                                    <span
                                      style={{
                                        fontSize: "0.75rem",
                                        color: "#8b7355",
                                        marginLeft: "0.5rem",
                                      }}
                                    >
                                      ({s.reason})
                                    </span>
                                  )}
                                </div>
                              ))}
                            </details>
                            <span
                              className="info-tooltip"
                              data-tip={t("skipped_tooltip")}
                            >
                              ⓘ
                            </span>
                          </div>
                        )}
                      </>
                    )}

                    {result.errors.length > 0 && (
                      <div className="error-list">
                        {result.errors.map((e, i) => (
                          <p key={i} className="error-item">
                            ⚠️ {e}
                          </p>
                        ))}
                      </div>
                    )}

                    <div className="export-buttons">
                      <button
                        className="btn-secondary"
                        onClick={() => {
                          const text = isTranslation
                            ? result.editedText
                            : applyAccepted(
                                result.originalText,
                                corrections,
                                accepted,
                              );
                          downloadFile(text, `${task.name}.edited.md`);
                        }}
                      >
                        {t("download_md")}
                      </button>
                      <button
                        className="btn-secondary"
                        onClick={() => {
                          const text = isTranslation
                            ? result.editedText
                            : applyAccepted(
                                result.originalText,
                                corrections,
                                accepted,
                              );
                          handleDownloadDocx(text, `${task.name}.edited.docx`);
                        }}
                      >
                        {t("download_docx")}
                      </button>
                    </div>
                  </details>
                );
              })}
            </details>
          );
          return jobNode;
        });

        const latest = rendered[0];
        const older = rendered.slice(1);
        return (
          <>
            <div ref={latestRef}>{latest}</div>
            {older.length > 0 && (
              <details className="review-old-group">
                <summary className="review-old-summary">
                  Old stuff ({older.length})
                </summary>
                {older}
              </details>
            )}
            {(older.length > 0 || jobEntries.length > 0) && (
              <div className="review-clear-row">
                {older.length > 0 && (
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    onClick={() =>
                      latestRef.current?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      })
                    }
                  >
                    {t("view_latest")}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setConfirmClear(true)}
                >
                  {t("clear_all")}
                </button>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
