// ── Review & Export — Stage IV ──

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import {
  exportDocx,
  exportEpub,
  formatEbook,
  retryTask,
  clearQueue,
  deleteTask,
  deleteJob,
  spawnJobSummary,
} from "../api";
import type { DocxExportOptions } from "../api";
import type { TaskState, Correction } from "../types";
import { ANALYSIS_MODES, EDIT_MODES } from "../types";
import {
  applyAccepted,
  findAllOccurrences,
  verifyAcceptedCorrections,
  type VerifyOutcome,
} from "../exportVerify";

const BASE = import.meta.env.VITE_API_URL ?? "";

/**
 * Extract a numeric sort key from a chapter name so tasks render
 * in manuscript order (Ch 1, Ch 2, …) rather than completion order.
 * Names without a number sort to Infinity (end of list).
 */
function chapterSortKey(name: string): number {
  if (/^frontmatter$/i.test(name.trim())) return -1;
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

/**
 * Extract surrounding sentence context for a specific occurrence of `original`
 * within `fullText`, starting search from `startIndex`.
 */
function extractSentenceContext(
  original: string,
  fullText: string,
  startIndex = 0,
): { before: string; after: string } {
  const idx = fullText.indexOf(original, startIndex);
  if (idx < 0) return { before: "", after: "" };

  const editEnd = idx + original.length;

  // ── Determine the start of the context ──
  // Find the start of the sentence containing the edit.
  // Look backwards from the edit position for a sentence boundary.
  let contextStart = 0;
  const textBefore = fullText.slice(0, idx);
  const beforeBoundaries: number[] = [];
  let m: RegExpExecArray | null;
  const beforeRe = /[.!?][\s\n]/g;
  while ((m = beforeRe.exec(textBefore)) !== null) {
    beforeBoundaries.push(m.index + m[0].length);
  }

  if (beforeBoundaries.length > 0) {
    const sentenceStart = beforeBoundaries[beforeBoundaries.length - 1];
    // If the edit is near or at the start of its sentence, always include
    // the previous sentence so the user sees context on both sides.
    const gapToEdit = textBefore.slice(sentenceStart).trim();
    const gapChars = gapToEdit.replace(/\s+/g, " ").length;
    if (gapChars <= 15 && beforeBoundaries.length >= 2) {
      contextStart = beforeBoundaries[beforeBoundaries.length - 2];
    } else {
      contextStart = sentenceStart;
    }
  }
  // else contextStart stays 0 (beginning of text)

  // If the before-context ends up empty or very short (edit at chunk start),
  // pull in surrounding characters directly to give at least some context.
  let before = fullText.slice(contextStart, idx).trim();
  if (!before && contextStart > 0) {
    // Back up one more sentence as fallback
    if (beforeBoundaries.length >= 2) {
      contextStart = beforeBoundaries[beforeBoundaries.length - 2];
      before = fullText.slice(contextStart, idx).trim();
    }
  }
  if (!before && idx > 0) {
    // Last resort: grab up to 80 chars before the edit
    const rawBefore = fullText.slice(Math.max(0, idx - 80), idx).trim();
    before = rawBefore.replace(/.*[.!?]\s*/s, "").trim() || rawBefore.slice(-60);
  }

  // ── Determine the end of the context ──
  // Find the end of the sentence containing the edit.
  const afterRe = /[.!?][\s\n]/g;
  afterRe.lastIndex = editEnd;
  const afterMatch = afterRe.exec(fullText);
  let contextEnd = fullText.length;
  if (afterMatch) {
    const firstSentenceEnd = afterMatch.index + 1; // include the punctuation
    // Always try to include the next sentence if the edit is near the end
    // of its own sentence, so the user sees what comes after.
    const gapToEnd = fullText.slice(editEnd, firstSentenceEnd).trim();
    const gapChars = gapToEnd.replace(/\s+/g, " ").length;
    if (gapChars <= 15) {
      const nextMatch = afterRe.exec(fullText);
      contextEnd = nextMatch ? nextMatch.index + 1 : fullText.length;
    } else {
      contextEnd = firstSentenceEnd;
    }
  }

  // Extract the after context (excluding the original text itself)
  let after = fullText.slice(editEnd, contextEnd).trim();
  if (!after && editEnd < fullText.length) {
    // Grab trailing text as fallback — strip leading whitespace/newlines,
    // then stop at the first sentence-ending punctuation or 100 chars.
    const rawAfter = fullText.slice(editEnd, Math.min(editEnd + 100, fullText.length));
    const trimmed = rawAfter.replace(/^[\s\n]+/, "").trim();
    const sentenceEnd = trimmed.match(/^.*?[.!?](?=[\s\n]|$)/);
    after = sentenceEnd ? sentenceEnd[0].trim() : trimmed.slice(0, 80).trim();
  }

  return { before, after };
}

/** Reviewer confidence score; hover shows the reviewer's reasoning. */
function ConfidenceBadge({ correction }: { correction: Correction }) {
  if (correction.confidence === undefined) return null;
  const icon =
    correction.confidence >= 5
      ? "🟢"
      : correction.confidence >= 4
        ? "🟡"
        : correction.confidence >= 3
          ? "🟠"
          : correction.confidence >= 2
            ? "🔴"
            : "⛔";
  return (
    <span
      className="correction-confidence"
      data-tip={correction.reviewReason || undefined}
    >
      {icon} {correction.confidence}/5
    </span>
  );
}

/** Flag badge — shows the reviewer's reason inline (ellipsized), full text
 *  on hover. Rendered prominently so flagged suggestions can't be missed. */
function FlagBadge({ correction }: { correction: Correction }) {
  if (!correction.flagged) return null;
  return (
    <span
      className="correction-flag-badge"
      data-tip={correction.reviewReason || undefined}
    >
      ⚠ flagged{correction.reviewReason ? ` — ${correction.reviewReason}` : ""}
    </span>
  );
}

function CorrectionCard({
  correction,
  taskId,
  acceptedIds,
  onToggleOccurrence,
  onAcceptAllOccurrences,
  onDismissAllOccurrences,
  originalText,
}: {
  correction: Correction;
  taskId: string;
  acceptedIds: Set<string>;
  onToggleOccurrence: (occIdx: number) => void;
  onAcceptAllOccurrences: () => void;
  onDismissAllOccurrences: () => void;
  originalText?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  // Guard: if no correction ID, show a simple non-interactive card
  if (!correction.id) {
    return (
      <div className={`correction-card ${correction.flagged ? "flagged" : ""}`}>
        <div className="correction-check">☐</div>
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
        <span className="correction-diff">
          <InlineDiff
            before={correction.original}
            after={correction.corrected}
          />
        </span>
        <ConfidenceBadge correction={correction} />
        <FlagBadge correction={correction} />
      </div>
    );
  }

  if (!originalText) {
    // Fallback: no full text available, show simple card
    const accepted = correction.id ? acceptedIds.has(correction.id) : false;
    return (
      <div
        className={`correction-card ${accepted ? "accepted" : ""} ${correction.flagged ? "flagged" : ""}`}
        onClick={() => onToggleOccurrence(0)}
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
        <span className="correction-diff">
          <InlineDiff
            before={correction.original}
            after={correction.corrected}
          />
        </span>
        <ConfidenceBadge correction={correction} />
        <FlagBadge correction={correction} />
      </div>
    );
  }

  const occurrences = findAllOccurrences(originalText, correction.original);
  const totalOcc = occurrences.length;

  if (totalOcc === 0) {
    // Original text not found (shouldn't happen, but be defensive)
    const accepted = correction.id ? acceptedIds.has(correction.id) : false;
    return (
      <div
        className={`correction-card ${accepted ? "accepted" : ""} ${correction.flagged ? "flagged" : ""}`}
        onClick={() => onToggleOccurrence(0)}
      >
        <div className="correction-check">{accepted ? "☑" : "☐"}</div>
        <span className="correction-diff">
          <InlineDiff
            before={correction.original}
            after={correction.corrected}
          />
        </span>
        <ConfidenceBadge correction={correction} />
        <FlagBadge correction={correction} />
      </div>
    );
  }

  // Determine acceptance state for each occurrence
  const occAccepted = occurrences.map((_, i) => {
    const occKey = `${correction.id}:${i}`;
    // Also check bare id for backward compat / accept-all
    return acceptedIds.has(occKey) || acceptedIds.has(correction.id ?? "");
  });
  const allAccepted = occAccepted.every(Boolean);
  const anyAccepted = occAccepted.some(Boolean);

  // Context for the first occurrence (always shown inline)
  const firstCtx = extractSentenceContext(
    correction.original,
    originalText,
    occurrences[0],
  );

  return (
    <div
      className={`correction-card ${allAccepted ? "accepted" : ""} ${correction.flagged ? "flagged" : ""}`}
    >
      {/* Header row: master toggle + count badge */}
      <div
        className="correction-header"
        onClick={() => {
          if (allAccepted) {
            onDismissAllOccurrences();
          } else {
            onAcceptAllOccurrences();
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <div className="correction-check">
          {allAccepted ? "☑" : anyAccepted ? "◐" : "☐"}
        </div>
        {correction.chunk && (
          <div
            style={{
              fontSize: "0.75rem",
              color: "#64748b",
            }}
          >
            {correction.chunk}
          </div>
        )}
        <span className="correction-diff" style={{ flex: 1 }}>
          {firstCtx.before && (
            <span className="correction-context">{firstCtx.before} </span>
          )}
          <InlineDiff
            before={correction.original}
            after={correction.corrected}
          />
          {firstCtx.after && (
            <span className="correction-context"> {firstCtx.after}</span>
          )}
        </span>
        <ConfidenceBadge correction={correction} />
        <FlagBadge correction={correction} />
        {totalOcc > 1 && (
          <span
            className="occurrence-badge"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            title={`${totalOcc} occurrences — click to expand`}
            style={{
              fontSize: "0.75rem",
              fontWeight: 600,
              background: "#e2e8f0",
              color: "#475569",
              padding: "0.15rem 0.45rem",
              borderRadius: "999px",
              whiteSpace: "nowrap",
            }}
          >
            {totalOcc}× {expanded ? "▲" : "▼"}
          </span>
        )}
      </div>

      {/* Expanded: per-occurrence rows */}
      {expanded &&
        totalOcc > 1 &&
        occurrences.map((pos, i) => {
          const ctx = extractSentenceContext(
            correction.original,
            originalText,
            pos,
          );
          const accepted = occAccepted[i];
          return (
            <div
              key={i}
              className={`occurrence-row ${accepted ? "accepted" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleOccurrence(i);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.35rem 0.5rem",
                marginTop: "0.25rem",
                marginLeft: "1.5rem",
                borderRadius: "4px",
                cursor: "pointer",
                fontSize: "0.85rem",
                background: accepted ? "#dcfce7" : "#f8fafc",
                border: accepted ? "1px solid #bbf7d0" : "1px solid #e2e8f0",
              }}
            >
              <div className="correction-check" style={{ fontSize: "0.85rem" }}>
                {accepted ? "☑" : "☐"}
              </div>
              <span className="correction-diff" style={{ flex: 1 }}>
                {ctx.before && (
                  <span className="correction-context">{ctx.before} </span>
                )}
                <InlineDiff
                  before={correction.original}
                  after={correction.corrected}
                />
                {ctx.after && (
                  <span className="correction-context"> {ctx.after}</span>
                )}
              </span>
              <span
                style={{
                  fontSize: "0.7rem",
                  color: "#94a3b8",
                  whiteSpace: "nowrap",
                }}
              >
                #{i + 1}
              </span>
            </div>
          );
        })}
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
    return <SplitCatalogTable mode="character" items={items} t={t} />;
  }

  if (mode === "location_catalog") {
    const items = (
      Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>).locations ?? [])
    ) as Array<Record<string, unknown>>;
    return <SplitCatalogTable mode="location" items={items} t={t} />;
  }

  if (mode === "timeline") {
    const items = (
      Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>).events ?? [])
    ) as Array<Record<string, unknown>>;
    return <TimelineZoomView items={items} t={t} />;
  }

  // Fallback: pretty-print JSON
  return <pre className="json-preview">{JSON.stringify(data, null, 2)}</pre>;
}

/** Render a catalog table split into key (≥2 chapters) and minor items. */
function SplitCatalogTable({
  mode,
  items,
  t,
}: {
  mode: "character" | "location";
  items: Array<Record<string, unknown>>;
  t: (key: string) => string;
}) {
  const isKey = (item: Record<string, unknown>) =>
    Array.isArray(item.chapters) && item.chapters.length >= 2;
  const keyItems = items.filter(isKey);
  const minorItems = items.filter((item) => !isKey(item));
  const minorLabel =
    mode === "character"
      ? minorItems.length === 1
        ? "minor character"
        : "minor characters"
      : minorItems.length === 1
        ? "minor location"
        : "minor locations";

  const renderTable = (rows: Array<Record<string, unknown>>) => (
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
        {rows.map((row, i) => (
          <tr key={i}>
            <td>{String(row.name ?? "")}</td>
            <td>{(row.aliases as string[] | undefined)?.join(", ")}</td>
            <td>
              {(row.chapters as string[] | undefined)?.join(", ") ??
                String(row.firstMention ?? "")}
            </td>
            <td>
              {mode === "character"
                ? String(
                    row.physicalDescription ??
                      row.description ??
                      row.role ??
                      "",
                  )
                : String(row.description ?? row.significance ?? "")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <>
      {keyItems.length > 0 && renderTable(keyItems)}
      {keyItems.length === 0 && items.length > 0 && renderTable(items)}
      {minorItems.length > 0 && keyItems.length > 0 && (
        <details className="minor-items-details">
          <summary className="minor-items-summary">
            {minorItems.length} {minorLabel}
          </summary>
          {renderTable(minorItems)}
        </details>
      )}
    </>
  );
}

type TimelineTier = 1 | 2 | 3;

function timelineTier(event: Record<string, unknown>): TimelineTier {
  const hasTimeRef =
    typeof event.timeReference === "string" && event.timeReference.length > 0;
  const desc =
    typeof event.description === "string"
      ? event.description
      : String(event.event ?? "");
  // Tier by description length + explicit time references.
  // Character count is too unreliable — model nearly always lists ≥2.
  if (hasTimeRef || desc.length >= 200) return 1;
  if (desc.length >= 80) return 2;
  return 3;
}

/** Extract a sortable chapter order: "Chapter 3" → 3, "Ch5" → 5, "Prologue" → -1 */
function chapterOrder(chapter: string): number {
  const m = chapter.match(/\d+/);
  return m ? parseInt(m[0], 10) : -1;
}

/** Timeline with three-button zoom toggle: Major · Medium · All. */
function TimelineZoomView({
  items,
  t,
}: {
  items: Array<Record<string, unknown>>;
  t: (key: string) => string;
}) {
  const [tier, setTier] = useState<TimelineTier>(1);
  const tiers: { tier: TimelineTier; label: string; count: number }[] = [
    { tier: 1, label: "Major", count: 0 },
    { tier: 2, label: "Medium", count: 0 },
    { tier: 3, label: "All", count: 0 },
  ];

  // Sort events by chapter name in natural order
  const sorted = [...items].sort((a, b) => {
    const ao = chapterOrder(String(a.chapter ?? ""));
    const bo = chapterOrder(String(b.chapter ?? ""));
    if (ao !== bo) return ao - bo;
    return naturalCompare(String(a.chapter ?? ""), String(b.chapter ?? ""));
  });

  // Classify each event into its tier
  const eventTiers = sorted.map((e) => timelineTier(e));
  for (const et of eventTiers) {
    for (const tObj of tiers) {
      if (et <= tObj.tier) tObj.count++;
    }
  }

  // Each tier includes all events at that tier AND above (zoom out = see more)
  const filtered = sorted.filter((_, i) => eventTiers[i] <= tier);

  const renderTable = (rows: Array<Record<string, unknown>>) => (
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
        {rows.map((e, i) => (
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

  return (
    <div className="timeline-zoom">
      <div className="timeline-zoom-toggles">
        {tiers.map((tObj) => (
          <button
            key={tObj.tier}
            type="button"
            className={
              "timeline-zoom-btn" +
              (tier === tObj.tier ? " timeline-zoom-btn-active" : "") +
              (tObj.count === 0 ? " timeline-zoom-btn-empty" : "")
            }
            onClick={() => setTier(tObj.tier)}
            disabled={tObj.count === 0}
          >
            {tObj.label}
            <span className="timeline-zoom-count">{tObj.count}</span>
          </button>
        ))}
      </div>
      {filtered.length > 0 ? (
        renderTable(filtered)
      ) : (
        <p className="correction-empty">
          {t("no_structured_data")}
        </p>
      )}
    </div>
  );
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

  if (obj.events) {
    const count = Array.isArray(obj.events) ? obj.events.length : 0;
    sections.push(
      <div key="events">
        <h4 className="analysis-section-header">
          📅 {t("mode_timeline")}
          {count > 0 && <span className="section-count">{count}</span>}
        </h4>
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

const PAGEBREAK_MARKER = "<!-- PAGEBREAK -->";

/**
 * Assemble the full manuscript from all edit-mode tasks in a job,
 * applying accepted corrections per chapter, joined with pagebreak markers.
 */
function buildFullManuscript(
  entries: [string, TaskState][],
  acceptedCorrections: Record<string, Set<string>>,
  fixedTexts: Record<string, string> = {},
): string {
  const editEntries = entries
    .filter(([, task]) => EDIT_MODES.includes(task.mode))
    .sort(([, a], [, b]) => chapterSortKey(a.name) - chapterSortKey(b.name));

  const chapters: string[] = [];
  for (const [tid, task] of editEntries) {
    if (!task.result) continue;
    const isTranslation = task.mode === "translate";
    if (isTranslation) {
      chapters.push(task.result.editedText);
    } else if (fixedTexts[tid] !== undefined) {
      // The export check already assembled this chapter and repaired
      // introduced errors in place — use its text verbatim.
      chapters.push(fixedTexts[tid]);
    } else {
      const accepted = acceptedCorrections[tid] ?? new Set<string>();
      chapters.push(
        applyAccepted(
          task.result.originalText,
          task.result.corrections,
          accepted,
        ),
      );
    }
  }
  return chapters.join(`\n\n${PAGEBREAK_MARKER}\n\n`);
}

export default function ReviewExport({ isOldResults }: { isOldResults?: boolean }) {
  const {
    lang,
    model,
    tasks: allTasks,
    sessionStartedAt,
    acceptedCorrections,
    showFlagged,
    toggleShowFlagged,
    toggleCorrection,
    acceptAll,
    dismissAll,
    acceptAllJob,
    acceptCorrection,
    dismissCorrection,
    toggleOccurrence,
  } = useStore();
  const tasks = isOldResults
    ? allTasks
    : Object.fromEntries(
        Object.entries(allTasks).filter(([, t]) => (t.submittedAt ?? 0) >= sessionStartedAt),
      );
  const t = useTranslation(lang);
  const [confirmClear, setConfirmClear] = useState(false);
  const [toast, setToast] = useState<{
    msg: string;
    kind: "accept" | "dismiss" | "error";
  } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(timer);
  }, [toast]);

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
    async (markdown: string, filename: string, opts?: DocxExportOptions) => {
      try {
        const blob = await exportDocx(markdown, opts);
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

  const [formattingEbook, setFormattingEbook] = useState(false);

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  // One-click AI ebook formatting: tidy structure, then export EPUB.
  const handleAutoFormatEbook = useCallback(
    async (markdown: string, baseName: string) => {
      setFormattingEbook(true);
      try {
        const formatted = await formatEbook(markdown, model);
        const epubBlob = await exportEpub(formatted, { title: baseName });
        downloadBlob(epubBlob, `${baseName}.ebook.epub`);
        setToast({ msg: t("ebook_done_toast"), kind: "accept" });
      } catch (err) {
        console.error("Auto-format ebook failed:", err);
        setToast({ msg: t("ebook_failed_toast"), kind: "error" });
      } finally {
        setFormattingEbook(false);
      }
    },
    [model, t],
  );

  const [verifying, setVerifying] = useState(false);
  const [verifyReport, setVerifyReport] = useState<VerifyOutcome | null>(null);

  // Export-time spell check: verify the accepted corrections of the tasks
  // being exported, un-accept any that would introduce misspellings, then
  // build the final markdown from the (possibly cleaned) acceptance state.
  // Reads via getState so the rebuild sees the post-cleanup accepted sets.
  const verifyThenExport = useCallback(
    async (
      taskIds: string[],
      build: (
        accepted: Record<string, Set<string>>,
        fixedTexts: Record<string, string>,
      ) => string,
      exportFn: (markdown: string) => void | Promise<void>,
    ) => {
      // `verifying` must only cover the (fast) spell check + rebuild. The
      // export step itself can be very slow (ebook formatting streams the
      // whole manuscript through the LLM) and has its own progress state —
      // holding `verifying` through it would disable every export button in
      // the app for the duration, making unrelated exports fail silently.
      let markdown: string;
      setVerifying(true);
      try {
        const state = useStore.getState();
        const toVerify = taskIds
          .map((tid) => ({ taskId: tid, task: state.tasks[tid] }))
          .filter(
            ({ task }) =>
              task?.result &&
              EDIT_MODES.includes(task.mode) &&
              task.mode !== "translate",
          )
          .map(({ taskId, task }) => ({ taskId, result: task!.result! }));
        let fixedTexts: Record<string, string> = {};
        if (toVerify.length > 0) {
          const outcome = await verifyAcceptedCorrections(
            toVerify,
            state.acceptedCorrections,
            state.unacceptCorrections,
            {
              englishDialect:
                typeof state.copyEditOptions.englishDialect === "string"
                  ? state.copyEditOptions.englishDialect
                  : undefined,
              styleGuide: state.styleGuide || undefined,
            },
          );
          fixedTexts = outcome.fixedTexts;
          if (
            outcome.checked &&
            (outcome.excluded.length > 0 ||
              outcome.autoFixed.length > 0 ||
              outcome.unattributed.length > 0)
          ) {
            setVerifyReport(outcome);
          }
        }
        markdown = build(useStore.getState().acceptedCorrections, fixedTexts);
      } finally {
        setVerifying(false);
      }
      try {
        await exportFn(markdown);
      } catch (err) {
        console.error("Export failed:", err);
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

  const handleSpawnSummary = useCallback(
    async (jobId: string, type: "summary" | "blurb" = "summary") => {
      try {
        await spawnJobSummary(jobId, type);
      } catch (err) {
        console.error("Spawn summary failed:", err);
        alert(
          `Failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [],
  );

  const handleDeleteTask = useCallback(
    async (taskId: string, taskName: string) => {
      if (
        !window.confirm(
          `Delete result for "${taskName}"? This cannot be undone.`,
        )
      ) {
        return;
      }
      try {
        await deleteTask(taskId);
      } catch (err) {
        console.error("Delete task failed:", err);
        alert(
          `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [],
  );

  const handleDeleteJob = useCallback(
    async (jobId: string, label: string, taskCount: number) => {
      if (
        !window.confirm(
          `Delete this job (${label}) and all ${taskCount} task result(s)? This cannot be undone.`,
        )
      ) {
        return;
      }
      try {
        await deleteJob(jobId);
      } catch (err) {
        console.error("Delete job failed:", err);
        alert(
          `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [],
  );

  const handleDeleteOlder = useCallback(async (jobIds: string[]) => {
    if (jobIds.length === 0) return;
    if (
      !window.confirm(
        `Delete all ${jobIds.length} older job(s) and their results? This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await Promise.all(jobIds.map((jid) => deleteJob(jid)));
    } catch (err) {
      console.error("Delete older jobs failed:", err);
      alert(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
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

      {toast && (
        <div className={`review-toast review-toast-${toast.kind}`}>
          {toast.msg}
        </div>
      )}

      {verifyReport && (
        <div className="verify-report-banner">
          <button
            className="verify-report-dismiss"
            aria-label={t("btn_cancel")}
            onClick={() => setVerifyReport(null)}
          >
            ✕
          </button>
          <strong>{t("export_check_title")}</strong>
          {verifyReport.excluded.length > 0 && (
            <p>
              {t("export_check_excluded").replace(
                "{n}",
                String(verifyReport.excluded.length),
              )}
            </p>
          )}
          {verifyReport.excluded.length > 0 && (
            <ul>
              {verifyReport.excluded.map((e, i) => (
                <li key={i}>
                  “{e.original}” → “{e.corrected}” <em>({e.word})</em>
                </li>
              ))}
            </ul>
          )}
          {verifyReport.autoFixed.length > 0 && (
            <p>
              {t("export_check_autofixed").replace(
                "{n}",
                String(verifyReport.autoFixed.length),
              )}
              : {verifyReport.autoFixed.join(", ")}
            </p>
          )}
          {verifyReport.unattributed.length > 0 && (
            <p>
              {t("export_check_manual")}: {verifyReport.unattributed.join(", ")}
            </p>
          )}
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
            ([, t]) =>
              t.status === "error" &&
              t.mode !== "analysis_summary" &&
              t.mode !== "blurb",
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

          // ── Shared manuscript-wide edit state (accept-all toggle + downloads) ──
          const editTasks = entries.filter(([, task]) =>
            EDIT_MODES.includes(task.mode),
          );
          const editTaskIds = editTasks.map(([tid]) => tid);
          const allEditDone = editTasks.every(
            ([, task]) => task.status === "done",
          );
          const allEditCorrections = editTasks.flatMap(([tid, task]) =>
            (task.result?.corrections ?? [])
              .filter((c) => c.id)
              .map((c) => ({ tid, id: c.id as string })),
          );
          const hasAnyCorrections = allEditCorrections.length > 0;
          const allAccepted =
            hasAnyCorrections &&
            allEditCorrections.every(({ tid, id }) => {
              const set = acceptedCorrections[tid] ?? new Set<string>();
              return (
                set.has(id) || [...set].some((k) => k.startsWith(`${id}:`))
              );
            });

          const jobNode = (
            <details
              key={jid}
              className="review-group"
              open={isOldResults ? undefined : true}
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
                <button
                  type="button"
                  className="review-delete-btn"
                  title={t("delete_job_tip")}
                  aria-label={t("delete_job_tip")}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleDeleteJob(jid, src, entries.length);
                  }}
                >
                  ×
                </button>
              </summary>

              <div className="review-group-body">

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

              {/* ── Generate summary / blurb buttons (job level) ── */}
              {(() => {
                const hasAnalysisData = entries.some(
                  ([, t]) =>
                    ANALYSIS_MODES.includes(t.mode) &&
                    t.result?.structuredData,
                );
                if (!hasAnalysisData) return null;

                const hasSummary = entries.some(
                  ([, t]) => t.mode === "analysis_summary",
                );
                const hasBlurb = entries.some(
                  ([, t]) => t.mode === "blurb",
                );
                return (
                  <div className="generate-buttons-row">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => void handleSpawnSummary(jid, "summary")}
                    >
                      {hasSummary
                        ? t("regenerate_summary")
                        : t("generate_summary")}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => void handleSpawnSummary(jid, "blurb")}
                    >
                      {hasBlurb
                        ? t("regenerate_blurb")
                        : t("generate_blurb")}
                    </button>
                  </div>
                );
              })()}

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

              {/* ── Blurb (marketing synopsis) ── */}
              {(() => {
                const blurbTask = entries
                  .map(([, t]) => t)
                  .find((t) => t.mode === "blurb");
                if (!blurbTask) return null;

                if (
                  blurbTask.status !== "done" ||
                  !blurbTask.result?.editedText
                ) {
                  const pct = Math.round((blurbTask.progress ?? 0) * 100);
                  return (
                    <details className="review-task" open>
                      <summary className="review-task-summary">
                        <span
                          className={`task-status-pill qs-${blurbTask.status}`}
                        >
                          {t(`status_${blurbTask.status}`)}
                        </span>{" "}
                        {t("blurb")}
                      </summary>
                      <div className="task-placeholder">
                        {blurbTask.status === "editing" && (
                          <>
                            <div className="q-bar">
                              <div
                                className={`q-fill qs-${blurbTask.status}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <p className="small-note">
                              {pct}%
                              {blurbTask.phase
                                ? ` — ${blurbTask.phase}`
                                : ""}
                            </p>
                          </>
                        )}
                        {blurbTask.status === "error" && (
                          <p className="error-item">
                            ⚠️{" "}
                            {blurbTask.result?.errors?.join("; ") ??
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
                      <strong>{t("blurb")}</strong>
                    </summary>
                    <MarkdownView text={blurbTask.result.editedText} />
                    <div className="export-buttons">
                      <button
                        className="btn-secondary"
                        onClick={() =>
                          downloadFile(
                            blurbTask.result!.editedText,
                            `${src}.blurb.md`,
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
                            blurbTask.result!.editedText,
                            `${src}.blurb.docx`,
                          )
                        }
                      >
                        Download DOCX
                      </button>
                    </div>
                  </details>
                );
              })()}

              {/* ── Aggregated analysis sections (one top-level card per mode) ── */}
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

                return Array.from(analysisByMode.entries()).flatMap(
                  ([mode, modeTasks]) => {
                    const merged = aggregateAnalysisTasks(modeTasks);

                    if (mode === "combined_analysis") {
                      // Split combined_analysis into separate character / location / timeline cards
                      const obj = merged as Record<string, unknown>;
                      const subCards: React.ReactNode[] = [];

                      const subModes: {
                        key: string;
                        mode: string;
                        icon: string;
                        label: string;
                      }[] = [
                        {
                          key: "characters",
                          mode: "character_catalog",
                          icon: "👤",
                          label: t("mode_character_catalog"),
                        },
                        {
                          key: "locations",
                          mode: "location_catalog",
                          icon: "📍",
                          label: t("mode_location_catalog"),
                        },
                        {
                          key: "events",
                          mode: "timeline",
                          icon: "📅",
                          label: t("mode_timeline"),
                        },
                      ];

                      for (const sm of subModes) {
                        const items = obj[sm.key];
                        if (!Array.isArray(items) || items.length === 0) continue;
                        subCards.push(
                          <details
                            key={`agg-${mode}-${sm.key}`}
                            className="review-task review-summary-card"
                            open
                          >
                            <summary className="review-task-summary">
                              <strong>
                                {sm.icon} {sm.label}
                              </strong>{" "}
                              <span className="review-source-meta">
                                {t("aggregated_summary")} (
                                {modeTasks.length}{" "}
                                {modeTasks.length === 1
                                  ? "chapter"
                                  : "chapters"}
                                )
                              </span>
                            </summary>
                            <StructuredDataView
                              mode={sm.mode}
                              data={{ [sm.key]: items }}
                              t={t}
                            />
                            <div className="export-buttons">
                              <button
                                className="btn-secondary"
                                onClick={() =>
                                  downloadFile(
                                    JSON.stringify({ [sm.key]: items }, null, 2),
                                    `${src}.${sm.key}.merged.json`,
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
                              {modeTasks.map((task) => {
                                const td = task.result
                                  ?.structuredData as
                                  | Record<string, unknown>
                                  | undefined;
                                const subItems = td?.[sm.key];
                                if (
                                  !Array.isArray(subItems) ||
                                  subItems.length === 0
                                )
                                  return (
                                    <p key={task.id} className="small-note">
                                      {task.name}: {t("no_structured_data")}
                                    </p>
                                  );
                                return (
                                  <details
                                    key={`agg-${mode}-${sm.key}-${task.id}`}
                                    className="review-task"
                                  >
                                    <summary className="review-task-summary">
                                      {task.name}
                                    </summary>
                                    <StructuredDataView
                                      mode={sm.mode}
                                      data={{ [sm.key]: subItems }}
                                      t={t}
                                    />
                                    {(task.result?.errors?.length ?? 0) > 0 && (
                                      <div className="error-list">
                                        {task.result!.errors.map((e, i) => (
                                          <p key={i} className="error-item">
                                            ⚠️ {e}
                                          </p>
                                        ))}
                                      </div>
                                    )}
                                  </details>
                                );
                              })}
                            </details>
                          </details>,
                        );
                      }
                      return subCards;
                    }

                    const modeLabel = t(`mode_${mode}`);
                    return (
                      <details
                        key={`agg-${mode}`}
                        className="review-task review-summary-card"
                        open
                      >
                        <summary className="review-task-summary">
                          <strong>
                            {mode === "combined_analysis" && "🔍 "}
                            {mode === "character_catalog" && "👤 "}
                            {mode === "location_catalog" && "📍 "}
                            {mode === "timeline" && "📅 "}
                            {modeLabel}
                          </strong>{" "}
                          <span className="review-source-meta">
                            {t("aggregated_summary")} (
                            {modeTasks.length}{" "}
                            {modeTasks.length === 1 ? "chapter" : "chapters"})
                          </span>
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
                );
              })()}

              <div
                className="chapters-scroll"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
                  el.classList.toggle("chapters-scroll-at-bottom", atBottom);
                }}
              >
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
                        <button
                          type="button"
                          className="review-delete-btn review-delete-btn-task"
                          title={t("delete_task_tip")}
                          aria-label={t("delete_task_tip")}
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void handleDeleteTask(tid, task.name);
                          }}
                        >
                          ×
                        </button>
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
                      {!isTranslation && hasChanges && (
                        <button
                          type="button"
                          className="btn-small btn-accept summary-accept-btn"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            acceptAll(tid);
                          }}
                        >
                          {t("accept_all_job")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="review-delete-btn review-delete-btn-task"
                        title={t("delete_task_tip")}
                        aria-label={t("delete_task_tip")}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleDeleteTask(tid, task.name);
                        }}
                      >
                        ×
                      </button>
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
                        {(() => {
                          const flaggedCount = corrections.filter(
                            (c) => c.flagged,
                          ).length;
                          const showAll = showFlagged[tid] === true;
                          const visible = showAll
                            ? corrections
                            : corrections.filter((c) => !c.flagged);
                          let acceptedCount = 0;
                          for (const c of visible) {
                            if (!c.id) continue;
                            if (
                              accepted.has(c.id) ||
                              [...accepted].some((k) =>
                                k.startsWith(`${c.id}:`),
                              )
                            ) {
                              acceptedCount++;
                            }
                          }
                          return (
                            <>
                              <div className="review-actions">
                                {flaggedCount > 0 && (
                                  <button
                                    className="show-flagged-toggle"
                                    onClick={() => toggleShowFlagged(tid)}
                                    title={t("flagged_tooltip")}
                                  >
                                    {showAll
                                      ? t("hide_flagged")
                                      : `⚠ ${t("show_all_suggestions")} (${flaggedCount})`}
                                  </button>
                                )}
                                <button
                                  className="btn-small btn-accept"
                                  onClick={() => acceptAll(tid)}
                                >
                                  {t("accept_all")}
                                </button>
                                <button
                                  className="btn-small btn-dismiss"
                                  onClick={() => dismissAll(tid)}
                                >
                                  {t("dismiss_all")}
                                </button>
                                <span className="small-note">
                                  {acceptedCount}{" "}
                                  {t("of")} {visible.length}{" "}
                                  {t("proposed_changes")}
                                  {flaggedCount > 0 && !showAll && (
                                    <span
                                      className="info-tooltip"
                                      data-tip={t("flagged_tooltip")}
                                      style={{
                                        color: "#8b7355",
                                        marginLeft: "0.3rem",
                                      }}
                                    >
                                      (+{flaggedCount} {t("flagged_label")}) ⓘ
                                    </span>
                                  )}
                                </span>
                              </div>

                              <div
                                className="corrections-scroll"
                                onScroll={(e) => {
                                  const el = e.currentTarget;
                                  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
                                  el.classList.toggle("corrections-scroll-at-bottom", atBottom);
                                }}
                              >
                              {visible.map((c, i) => {
                                const totalOcc = findAllOccurrences(
                                  result.originalText,
                                  c.original,
                                ).length;
                                return (
                                  <CorrectionCard
                                    key={c.id ?? i}
                                    correction={c}
                                    taskId={tid}
                                    acceptedIds={accepted}
                                    onToggleOccurrence={(occIdx: number) =>
                                      toggleOccurrence(
                                        tid,
                                        c.id ?? "",
                                        occIdx,
                                        totalOcc,
                                      )
                                    }
                                    onAcceptAllOccurrences={() => {
                                      if (c.id) acceptCorrection(tid, c.id);
                                    }}
                                    onDismissAllOccurrences={() => {
                                      if (c.id) dismissCorrection(tid, c.id);
                                    }}
                                    originalText={result.originalText}
                                  />
                                );
                              })}

                              </div>

                              {/* Outside .corrections-scroll so the ⓘ tooltip
                                  isn't clipped by the overflow container. */}
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
                          );
                        })()}

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
                        disabled={verifying}
                        onClick={() => {
                          if (isTranslation) {
                            downloadFile(
                              result.editedText,
                              `${task.name}.edited.md`,
                            );
                            return;
                          }
                          verifyThenExport(
                            [tid],
                            (acc, fixed) =>
                              fixed[tid] ??
                              applyAccepted(
                                result.originalText,
                                corrections,
                                acc[tid] ?? new Set<string>(),
                              ),
                            (md) => downloadFile(md, `${task.name}.edited.md`),
                          );
                        }}
                      >
                        {t("download_chapter_md")}
                      </button>
                      <button
                        className="btn-secondary"
                        disabled={verifying}
                        onClick={() => {
                          if (isTranslation) {
                            handleDownloadDocx(
                              result.editedText,
                              `${task.name}.edited.docx`,
                            );
                            return;
                          }
                          verifyThenExport(
                            [tid],
                            (acc, fixed) =>
                              fixed[tid] ??
                              applyAccepted(
                                result.originalText,
                                corrections,
                                acc[tid] ?? new Set<string>(),
                              ),
                            (md) =>
                              handleDownloadDocx(
                                md,
                                `${task.name}.edited.docx`,
                              ),
                          );
                        }}
                      >
                        {t("download_chapter_docx")}
                      </button>
                    </div>
                      </>
                    )}

                  </details>
                );
              })}
              </div>

              {/* ── Accept-all toggle: bottom of the chapter list, right-aligned ── */}
              {editTasks.length > 0 && (
                <div className="accept-all-job-row">
                  <button
                    className={`btn-primary btn-accept-all-job ${
                      allAccepted ? "btn-dismiss" : "btn-accept"
                    }`}
                    disabled={!hasAnyCorrections}
                    onClick={() => {
                      if (allAccepted) {
                        editTaskIds.forEach((tid) => dismissAll(tid));
                        setToast({
                          msg: t("dismiss_all_job_toast"),
                          kind: "dismiss",
                        });
                      } else {
                        acceptAllJob(editTaskIds);
                        setToast({
                          msg: t("accept_all_job_toast"),
                          kind: "accept",
                        });
                      }
                    }}
                  >
                    {allAccepted ? t("dismiss_all_job") : t("accept_all_job")}
                  </button>
                </div>
              )}

              </div>{/* ── end .review-group-body (bright card) ── */}

              {/* ── Full manuscript downloads: below the bright card, but still
                   collapsing with this <details> container ── */}
              {editTasks.length > 0 && (
                <div className="export-buttons full-manuscript-export">
                  <button
                    className="btn-primary"
                    disabled={!allEditDone || verifying}
                    title={allEditDone ? undefined : t("full_manuscript_wait")}
                    onClick={() =>
                      verifyThenExport(
                        editTaskIds,
                        (acc, fixed) => buildFullManuscript(entries, acc, fixed),
                        (md) => downloadFile(md, `${src}.full.md`),
                      )
                    }
                  >
                    {t("download_full_md")}
                  </button>
                  <button
                    className="btn-primary"
                    disabled={!allEditDone || verifying}
                    title={allEditDone ? undefined : t("full_manuscript_wait")}
                    onClick={() =>
                      verifyThenExport(
                        editTaskIds,
                        (acc, fixed) => buildFullManuscript(entries, acc, fixed),
                        (md) => handleDownloadDocx(md, `${src}.full.docx`),
                      )
                    }
                  >
                    {t("download_full_docx")}
                  </button>
                  <button
                    className="btn-primary"
                    disabled={!allEditDone || formattingEbook || verifying}
                    title={
                      allEditDone
                        ? t("auto_format_ebook_tip")
                        : t("full_manuscript_wait")
                    }
                    onClick={() =>
                      verifyThenExport(
                        editTaskIds,
                        (acc, fixed) => buildFullManuscript(entries, acc, fixed),
                        (md) => handleAutoFormatEbook(md, src),
                      )
                    }
                  >
                    {formattingEbook
                      ? t("formatting_ebook")
                      : t("auto_format_ebook")}
                  </button>
                </div>
              )}
            </details>
          );
          return jobNode;
        });

        const displayJobs = isOldResults ? rendered : rendered.slice(0, 1);

        return (
          <>
            {displayJobs.map((jobNode, i) => (
              <div key={i} ref={i === 0 ? latestRef : undefined}>
                {jobNode}
              </div>
            ))}
            {isOldResults && jobEntries.length > 0 && (
              <div className="review-clear-row">
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
