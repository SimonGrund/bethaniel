// ── Review & Export — Stage IV ──

import { useCallback } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { exportDocx } from "../api";
import type {
  TaskState,
  Correction,
  CatalogCharacter,
  CatalogLocation,
  TimelineEvent,
} from "../types";
import { ANALYSIS_MODES } from "../types";

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
    ) as CatalogCharacter[];
    return (
      <table className="catalog-table">
        <thead>
          <tr>
            <th>{t("col_name")}</th>
            <th>{t("col_aliases")}</th>
            <th>{t("col_first_mention")}</th>
            <th>{t("col_description")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c, i) => (
            <tr key={i}>
              <td>{c.name}</td>
              <td>{c.aliases?.join(", ")}</td>
              <td>{c.firstMention}</td>
              <td>{c.description}</td>
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
    ) as CatalogLocation[];
    return (
      <table className="catalog-table">
        <thead>
          <tr>
            <th>{t("col_name")}</th>
            <th>{t("col_aliases")}</th>
            <th>{t("col_first_mention")}</th>
            <th>{t("col_description")}</th>
          </tr>
        </thead>
        <tbody>
          {items.map((l, i) => (
            <tr key={i}>
              <td>{l.name}</td>
              <td>{l.aliases?.join(", ")}</td>
              <td>{l.firstMention}</td>
              <td>{l.description}</td>
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
    ) as TimelineEvent[];
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
              <td>{e.chapter}</td>
              <td>{e.event}</td>
              <td>{e.characters?.join(", ")}</td>
              <td>{e.timeReference}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // Fallback: pretty-print JSON
  return <pre className="json-preview">{JSON.stringify(data, null, 2)}</pre>;
}

function isAnalysisMode(mode?: string): boolean {
  return ANALYSIS_MODES.includes(mode as never);
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

  const doneTasks = Object.entries(tasks).filter(
    ([, s]) => s.status === "done",
  );
  if (doneTasks.length === 0) return null;

  // Group by source
  const bySource: Record<string, [string, TaskState][]> = {};
  for (const [tid, task] of doneTasks) {
    const src = task.source ?? "manuscript";
    if (!bySource[src]) bySource[src] = [];
    bySource[src].push([tid, task]);
  }

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
    <section className="stage">
      <div className="section-label">
        <span className="num">V.</span>
        {t("sec_review")}
      </div>

      {Object.entries(bySource).map(([src, entries]) => (
        <div key={src} className="review-group">
          <h3 className="review-source">
            {t("results_for")} {src}
          </h3>

          {entries.map(([tid, task]) => {
            const result = task.result;
            if (!result) return null;

            const isAnalysis = isAnalysisMode(task.mode);

            // ── Analysis mode: show structured data table ──
            if (isAnalysis) {
              const modeLabel = t(`mode_${task.mode}`);
              return (
                <details key={tid} className="review-task">
                  <summary className="review-task-summary">
                    {task.name} — {modeLabel}
                  </summary>
                  <StructuredDataView
                    mode={task.mode}
                    data={result.structuredData}
                    t={t}
                  />
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
                      onClick={() =>
                        downloadFile(
                          JSON.stringify(result.structuredData, null, 2),
                          `${task.name}.${task.mode}.json`,
                          "application/json",
                        )
                      }
                    >
                      Download JSON
                    </button>
                  </div>
                </details>
              );
            }

            // ── Edit / translate mode: show corrections ──
            const accepted = acceptedCorrections[tid] ?? new Set<string>();
            const corrections = result.corrections;
            const hasChanges = corrections.length > 0;
            const summary = hasChanges
              ? `${task.name} — ${corrections.length} correction(s)`
              : `${task.name} — no changes`;

            return (
              <details key={tid} className="review-task">
                <summary className="review-task-summary">{summary}</summary>

                {!hasChanges ? (
                  <p className="correction-empty">{t("no_corrections_unit")}</p>
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
                              <span className="word-ins">{s.corrected}</span>
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
                          title={t("skipped_tooltip")}
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
                      const text = applyAccepted(
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
                      const text = applyAccepted(
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
        </div>
      ))}
    </section>
  );
}
