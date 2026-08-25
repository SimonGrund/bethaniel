// ── Review & Export — Stage IV ──

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import Modal from "./Modal";
import { useTranslation } from "../i18n";
import {
  exportDocx,
  exportDocxSurgical,
  NoOriginalDocxError,
  type SurgicalReport,
  exportEpub,
  formatEbook,
  retryTask,
  clearQueue,
  deleteTask,
  deleteJob,
  spawnJobSummary,
  spawnWritingReport,
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
import CurrentRunHeader from "./CurrentRunHeader";
import { useResultHydration } from "../useResultHydration";

const BASE = import.meta.env.VITE_API_URL ?? "";

// Too many near-duplicate export buttons (.md next to .docx, everywhere)
// cluttered the review UI. DOCX is the default now; Markdown downloads are
// hidden, not removed — every buildXxx()/downloadFile() call they used is
// untouched, so flipping this back to true restores them exactly as they
// were.
const SHOW_MARKDOWN_DOWNLOADS = false;

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

/**
 * True minimal word-level diff via LCS (dynamic programming), not a greedy
 * "look ahead" heuristic. The greedy version degenerates on a long passage
 * with several SCATTERED changes of the same token (e.g. two "?"→"." swaps
 * in one sentence): each mismatch searches for its own word anywhere ahead
 * and can end up deleting/inserting a whole run between them, making the
 * diff read as if most of the sentence changed. LCS finds the true minimal
 * edit script, so only the tokens that actually differ are marked.
 *
 * Capped at 200k table cells (~450 words per side) — a correction that long
 * is rare, and past that the O(n·m) table isn't worth the memory/time; it
 * falls back to one delete-block + one insert-block instead of hanging.
 */
function diffTokens(
  aWords: string[],
  bWords: string[],
): { type: "equal" | "del" | "ins"; text: string }[] {
  const n = aWords.length;
  const m = bWords.length;
  const parts: { type: "equal" | "del" | "ins"; text: string }[] = [];

  if (n * m > 200_000) {
    for (const w of aWords) parts.push({ type: "del", text: w });
    for (const w of bWords) parts.push({ type: "ins", text: w });
    return parts;
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        aWords[i] === bWords[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aWords[i] === bWords[j]) {
      parts.push({ type: "equal", text: aWords[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      parts.push({ type: "del", text: aWords[i] });
      i++;
    } else {
      parts.push({ type: "ins", text: bWords[j] });
      j++;
    }
  }
  while (i < n) parts.push({ type: "del", text: aWords[i++] });
  while (j < m) parts.push({ type: "ins", text: bWords[j++] });
  return parts;
}

function InlineDiff({ before, after }: { before: string; after: string }) {
  const aWords: string[] = before.match(/\s+|\w+|[^\w\s]/g) ?? [];
  const bWords: string[] = after.match(/\s+|\w+|[^\w\s]/g) ?? [];
  const parts = diffTokens(aWords, bWords);

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
  readOnly = false,
}: {
  correction: Correction;
  taskId: string;
  acceptedIds: Set<string>;
  onToggleOccurrence: (occIdx: number) => void;
  onAcceptAllOccurrences: () => void;
  onDismissAllOccurrences: () => void;
  originalText?: string;
  /** Scan results are a report, not a worklist: show the finding, no checkbox. */
  readOnly?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  // Guard: if no correction ID, show a simple non-interactive card
  if (!correction.id) {
    return (
      <div
        className={`correction-card ${correction.flagged ? "flagged" : ""} ${readOnly ? "correction-card-readonly" : ""}`}
      >
        {!readOnly && <div className="correction-check">☐</div>}
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
        className={`correction-card ${accepted ? "accepted" : ""} ${correction.flagged ? "flagged" : ""} ${readOnly ? "correction-card-readonly" : ""}`}
        onClick={readOnly ? undefined : () => onToggleOccurrence(0)}
      >
        {!readOnly && (
          <div className="correction-check">{accepted ? "☑" : "☐"}</div>
        )}
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
        className={`correction-card ${accepted ? "accepted" : ""} ${correction.flagged ? "flagged" : ""} ${readOnly ? "correction-card-readonly" : ""}`}
        onClick={readOnly ? undefined : () => onToggleOccurrence(0)}
      >
        {!readOnly && (
          <div className="correction-check">{accepted ? "☑" : "☐"}</div>
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
      className={`correction-card ${allAccepted ? "accepted" : ""} ${correction.flagged ? "flagged" : ""} ${readOnly ? "correction-card-readonly" : ""}`}
    >
      {/* Header row: master toggle + count badge */}
      <div
        className="correction-header"
        onClick={
          readOnly
            ? undefined
            : () => {
                if (allAccepted) {
                  onDismissAllOccurrences();
                } else {
                  onAcceptAllOccurrences();
                }
              }
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          cursor: readOnly ? "default" : "pointer",
          userSelect: "none",
        }}
      >
        {!readOnly && (
          <div className="correction-check">
            {allAccepted ? "☑" : anyAccepted ? "◐" : "☐"}
          </div>
        )}
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
  // Story-read pipeline: the part-synthesis pass assigns an explicit tier
  // (1 major / 2 medium / 3 minor) — trust it over the length heuristics.
  if (event.tier === 1 || event.tier === 2 || event.tier === 3) {
    return event.tier as TimelineTier;
  }
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

  // Reading-order sequence (story-read pipeline) wins; otherwise sort by
  // chapter name in natural order.
  const sorted = items.some((e) => typeof e.seq === "number")
    ? [...items].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0))
    : [...items].sort((a, b) => {
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

type OutlineZoom = "story" | "parts" | "chapters";

/**
 * Layered story outline from the story-read pipeline: whole-story synopsis,
 * a paragraph per part, and 2-3 sentences per chapter — zoomable like the
 * timeline's Major/Medium/All toggle.
 */
function OutlineZoomView({
  data,
  t,
}: {
  data: Record<string, unknown>;
  t: (key: string) => string;
}) {
  const synopsis = typeof data.synopsis === "string" ? data.synopsis : "";
  const parts = (Array.isArray(data.parts) ? data.parts : []) as Array<
    Record<string, unknown>
  >;
  const chapterSummaries = (
    Array.isArray(data.chapterSummaries) ? data.chapterSummaries : []
  ) as Array<Record<string, unknown>>;

  const zooms: { zoom: OutlineZoom; label: string; available: boolean }[] = [
    { zoom: "story", label: "Story", available: synopsis.length > 0 },
    { zoom: "parts", label: "Parts", available: parts.length > 0 },
    {
      zoom: "chapters",
      label: "Chapters",
      available: chapterSummaries.length > 0,
    },
  ];
  const firstAvailable =
    zooms.find((z) => z.available)?.zoom ?? ("story" as OutlineZoom);
  const [zoom, setZoom] = useState<OutlineZoom>(firstAvailable);

  return (
    <div className="timeline-zoom">
      <div className="timeline-zoom-toggles">
        {zooms.map((z) => (
          <button
            key={z.zoom}
            type="button"
            className={
              "timeline-zoom-btn" +
              (zoom === z.zoom ? " timeline-zoom-btn-active" : "") +
              (!z.available ? " timeline-zoom-btn-empty" : "")
            }
            onClick={() => setZoom(z.zoom)}
            disabled={!z.available}
          >
            {z.label}
          </button>
        ))}
      </div>

      {zoom === "story" && (
        <div className="outline-synopsis">
          {synopsis.split(/\n\s*\n/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}

      {zoom === "parts" &&
        parts.map((p, i) => (
          <div key={i} className="outline-part">
            <h4 className="analysis-section-header">
              {String(p.title ?? `Part ${i + 1}`)}
            </h4>
            <p>{String(p.summary ?? "")}</p>
          </div>
        ))}

      {zoom === "chapters" && (
        <table className="catalog-table">
          <thead>
            <tr>
              <th>{t("col_chapter")}</th>
              <th>{t("col_description")}</th>
            </tr>
          </thead>
          <tbody>
            {chapterSummaries.map((c, i) => (
              <tr key={i}>
                <td>{String(c.chapter ?? "")}</td>
                <td>{String(c.summary ?? "")}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

// ── Publication-readiness scan report ──
interface StructuralFinding {
  check: string;
  severity: "error" | "warning" | "info";
  location: string;
  message: string;
  detail?: string;
  /** Whether this must be fixed before publishing. Decided by the backend. */
  blocking?: boolean;
}
interface StructuralScanReport {
  chaptersScanned: number;
  summary: { error: number; warning: number; info: number };
  findings: StructuralFinding[];
}

/** A blocking issue for the readiness verdict — either a structural defect
 * (duplicate chapter, truncation, ...) or an objective/mechanical correction
 * (spelling, duplicated words, wrong punctuation, ...). Corrections carry the
 * raw Correction + originalText so they can be rendered with the same
 * word-level diff and full-sentence context as the normal copy-edit review,
 * rather than a fixed-radius text snippet. */
type BlockingIssue =
  | { kind: "structural"; location: string; message: string; detail?: string }
  | { kind: "correction"; location: string; correction: Correction; originalText: string };

/** Same sentence-context + word-diff rendering as the normal copy-edit
 * CorrectionCard, so a Publication Scan blocker reads the same way. */
function CorrectionContext({
  correction,
  originalText,
}: {
  correction: Correction;
  originalText: string;
}) {
  const { before, after } = extractSentenceContext(correction.original, originalText, 0);
  return (
    <span className="readiness-msg">
      {before && <span className="correction-context">{before} </span>}
      <InlineDiff before={correction.original} after={correction.corrected} />
      {after && <span className="correction-context"> {after}</span>}
    </span>
  );
}

/** Text form of a correction issue, for the markdown export (no JSX there). */
function correctionIssueText(correction: Correction, originalText: string): string {
  const { before, after } = extractSentenceContext(correction.original, originalText, 0);
  const ctx = [before, correction.original, after].filter(Boolean).join(" ").trim();
  return ctx
    ? `${ctx} → "${correction.corrected}"`
    : `${correction.original} → ${correction.corrected}`;
}

/**
 * A heuristic 0-100 publication-quality score. Structural defects are rare
 * and always serious (a duplicated chapter, a truncated ending), so each one
 * costs a flat amount; confirmed mechanical corrections are scored by
 * DENSITY (per 1,000 words) rather than raw count, so a handful of typos in
 * a full novel doesn't score the same as a handful in a five-page chapter.
 * Only reviewer-CONFIRMED corrections count — an unconfirmed/flagged one is
 * hidden from the panel entirely, so it doesn't touch the score either. This
 * is a heuristic guide for "does this look clean", not a formal QA metric —
 * 95+ is the bar this panel treats as publication-ready.
 */
function computeQualityScore(opts: {
  wordCount: number;
  structuralCount: number;
  confirmedCount: number;
}): number {
  const perThousandWords = Math.max(opts.wordCount, 1) / 1000;
  const penalty =
    opts.structuralCount * 15 + (opts.confirmedCount / perThousandWords) * 20;
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

const QUALITY_SCORE_PASS = 95;

/** A compact ring gauge for the publication-quality score. */
function QualityScoreRing({ score, t }: { score: number; t: (key: string) => string }) {
  const radius = 22;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - score / 100);
  const tier =
    score >= QUALITY_SCORE_PASS ? "good" : score >= 80 ? "ok" : "bad";
  return (
    <div className="quality-score">
      <div
        className={`quality-ring quality-ring-${tier}`}
        role="img"
        aria-label={`${t("quality_score_label")}: ${score}/100`}
      >
        <svg width="56" height="56" viewBox="0 0 56 56">
          <circle className="quality-ring-track" cx="28" cy="28" r={radius} />
          <circle
            className="quality-ring-fill"
            cx="28"
            cy="28"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        </svg>
        <span className="quality-ring-number">{score}</span>
      </div>
      <span className="quality-score-label small-note">
        {t("quality_score_label")}
      </span>
    </div>
  );
}

/**
 * The question a Publication Scan exists to answer: can this be published?
 *
 * It used to answer with per-chapter lists in which "wrinled → wrinkled" and
 * "a chapter's dialogue is unclosed" carried equal weight. Structural findings
 * are deterministic and, on a real book, all six were genuine defects — a
 * duplicated tail from a botched edit, an unclosed quote, closing marks typed
 * as opening ones. Objective proofread corrections (spelling, duplicated
 * words/phrases, missing words, spacing, wrong punctuation) are just as much
 * publication blockers and are listed here too — but ONLY the ones BOTH the
 * editor agent(s) and the reviewer pass actually confirmed. Exactly like the
 * normal copy-edit review, a correction the reviewer flagged as low-
 * confidence or never scored is hidden rather than asserted as a must-fix —
 * deterministic checkers (spell-check especially) produce enough false
 * positives that showing every one as a "publication blocker" would bury the
 * real ones. Genuinely subjective suggestions are simply counted, same as
 * any correction the reviewer didn't confirm.
 */
// Below this many punctuation-only suggestions, the nudge to run a full
// copy edit isn't worth the extra line — a handful of comma calls doesn't
// need its own recommendation.
const POLISH_NUDGE_THRESHOLD = 10;

function PublicationReadinessPanel({
  report,
  blockingCorrections,
  minorTotal,
  minorChapters,
  polishOnlyTotal,
  polishOnlyChapters,
  wordCount,
  onReviewMinor,
  minorOpen,
  t,
}: {
  report: StructuralScanReport | null;
  blockingCorrections: BlockingIssue[];
  minorTotal: number;
  minorChapters: number;
  /** Punctuation-only suggestions (comma/semicolon/period, no word changed)
   * within the minor bucket — common enough in bulk to warrant their own
   * nudge toward a full copy edit rather than being lost in the total. */
  polishOnlyTotal: number;
  polishOnlyChapters: number;
  /** Manuscript word count the score's error-density penalty is scaled by. */
  wordCount: number;
  onReviewMinor?: () => void;
  /** Whether the per-chapter minor list below is currently unfolded. */
  minorOpen?: boolean;
  t: (key: string) => string;
}) {
  const structuralBlocking: BlockingIssue[] = (report?.findings ?? [])
    .filter((f) => f.blocking)
    .map((f) => ({
      kind: "structural" as const,
      location: f.location,
      message: f.message,
      detail: f.detail,
    }));
  const blocking = [...structuralBlocking, ...blockingCorrections];
  const ready = blocking.length === 0;
  const score = computeQualityScore({
    wordCount,
    structuralCount: structuralBlocking.length,
    confirmedCount: blockingCorrections.length,
  });

  return (
    <div className="readiness">
      <div className="readiness-headline">
        <QualityScoreRing score={score} t={t} />
        <p className={`readiness-verdict ${ready ? "is-ready" : "is-check"}`}>
          {ready
            ? `✅ ${t("readiness_ready")}`
            : `⚠️ ${t("readiness_check").replace("{n}", String(blocking.length))}`}
        </p>
      </div>

      {blocking.length > 0 && (
        <ul className="readiness-list">
          {blocking.map((issue, i) => (
            <li key={i} className="readiness-item">
              <span className="readiness-loc">{issue.location}</span>
              {issue.kind === "correction" ? (
                <CorrectionContext
                  correction={issue.correction}
                  originalText={issue.originalText}
                />
              ) : (
                <>
                  <span className="readiness-msg">{issue.message}</span>
                  {issue.detail && (
                    <span className="scan-finding-detail">{issue.detail}</span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="readiness-minor small-note">
        {minorTotal === 0
          ? t("readiness_no_minor")
          : t("readiness_minor")
              .replace("{n}", String(minorTotal))
              .replace("{m}", String(minorChapters))}
        {minorTotal > 0 && onReviewMinor && (
          <>
            {" "}
            <button
              type="button"
              className="btn-link readiness-review"
              aria-expanded={minorOpen ?? false}
              onClick={onReviewMinor}
            >
              {minorOpen
                ? t("readiness_hide_minor")
                : t("readiness_review_all")}
            </button>
          </>
        )}
      </p>

      {polishOnlyTotal >= POLISH_NUDGE_THRESHOLD && (
        <p className="readiness-polish-nudge small-note">
          {t("readiness_polish_nudge")
            .replace("{n}", String(polishOnlyTotal))
            .replace("{m}", String(polishOnlyChapters))}
        </p>
      )}

      {report && (
        <p className="small-note readiness-scanned">
          {report.chaptersScanned} {t("scan_chapters")}
        </p>
      )}
    </div>
  );
}

const SEVERITY_ICON: Record<string, string> = {
  error: "⛔",
  warning: "⚠️",
  info: "ℹ️",
};

function StructuralFindingsPanel({
  data,
  t,
}: {
  data: unknown;
  t: (key: string) => string;
}) {
  const report = data as StructuralScanReport | null;
  if (!report || report.findings.length === 0) {
    return (
      <p className="scan-clean">
        ✅ {t("scan_no_issues")}
        {report ? ` (${report.chaptersScanned} ${t("scan_chapters")})` : ""}
      </p>
    );
  }
  const findings = report.findings;
  const order = { error: 0, warning: 1, info: 2 } as const;
  const sorted = [...findings].sort(
    (a, b) => order[a.severity] - order[b.severity],
  );
  return (
    <div className="scan-findings">
      <p className="scan-summary small-note">
        {report.summary.error} {t("scan_errors")} · {report.summary.warning}{" "}
        {t("scan_warnings")} · {report.summary.info} {t("scan_info")}
      </p>
      <ul className="scan-finding-list">
        {sorted.map((f, i) => (
          <li key={i} className={`scan-finding scan-sev-${f.severity}`}>
            <span className="scan-finding-icon">
              {SEVERITY_ICON[f.severity] ?? ""}
            </span>
            <span className="scan-finding-body">
              <span className="scan-finding-loc">{f.location}</span>
              <span className="scan-finding-check">
                {t(`scan_check_${f.check}`)}
              </span>
              <span className="scan-finding-msg">{f.message}</span>
              {f.detail && <span className="scan-finding-detail">{f.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
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
  let outline: unknown = null;

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
          // Story-read pipeline: global reading-order sequence + curated tier.
          ...(typeof ev.seq === "number" ? { seq: ev.seq } : {}),
          ...(typeof ev.tier === "number" ? { tier: ev.tier } : {}),
        });
      }
    }

    // Story-read pipeline: layered outline (synopsis / parts / chapters).
    if (!outline && data && typeof data === "object") {
      const o = (data as Record<string, unknown>).outline;
      if (o && typeof o === "object") outline = o;
    }
  }

  // Reading-order sequence numbers (story-read pipeline) beat chapter-name
  // heuristics; fall back to natural chapter sort for legacy results.
  if (events.some((e) => typeof e.seq === "number")) {
    events.sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0));
  } else {
    events.sort((a, b) =>
      naturalCompare(String(a.chapter), String(b.chapter)),
    );
  }

  const out: Record<string, unknown> = {};
  if (anyChars) out.characters = finalizeNamed(chars);
  if (anyLocs) out.locations = finalizeNamed(locs);
  if (anyEvents) out.events = events;
  if (outline) out.outline = outline;
  return out;
}

const PAGEBREAK_MARKER = "<!-- PAGEBREAK -->";

/**
 * Assemble the full manuscript from all edit-mode tasks in a job,
 * applying accepted corrections per chapter, joined with pagebreak markers.
 */
/**
 * The (original, edited) pair per chapter, for surgical export.
 *
 * Mirrors buildFullManuscript's per-chapter logic exactly — translate mode's
 * wholesale text, the server's repaired text, else the accepted corrections —
 * but keeps the chapters apart, because the server maps each one back onto the
 * original document separately.
 */
export function buildChapterPairs(
  entries: [string, TaskState][],
  acceptedCorrections: Record<string, Set<string>>,
  fixedTexts: Record<string, string> = {},
): { original: string; edited: string }[] {
  const editEntries = entries
    .filter(([, task]) => EDIT_MODES.includes(task.mode))
    .sort(([, a], [, b]) => chapterSortKey(a.name) - chapterSortKey(b.name));

  const pairs: { original: string; edited: string }[] = [];
  for (const [tid, task] of editEntries) {
    if (!task.result) continue;
    const original = task.result.originalText;
    let edited: string;
    if (task.mode === "translate") {
      edited = task.result.editedText;
    } else if (fixedTexts[tid] !== undefined) {
      edited = fixedTexts[tid];
    } else {
      edited = applyAccepted(
        task.result.originalText,
        task.result.corrections ?? [],
        acceptedCorrections[tid] ?? new Set<string>(),
      );
    }
    pairs.push({ original, edited });
  }
  return pairs;
}

/** A correction as a blocking issue, carrying the raw data the panel needs
 * to render it with full-sentence context and a word-level diff. */
function describeCorrection(
  taskName: string,
  originalText: string,
  c: Correction,
): BlockingIssue {
  return { kind: "correction", location: taskName, correction: c, originalText };
}

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

/**
 * Serializes a Publication Scan verdict into a standalone Markdown report:
 * structural findings, blocking corrections, and a minor-suggestion summary,
 * so the verdict can be handed to someone who isn't looking at the app.
 */
function buildReadinessReportMarkdown(
  src: string,
  report: StructuralScanReport | null,
  blockingCorrections: BlockingIssue[],
  minorTotal: number,
  minorChapters: number,
  polishOnlyTotal: number,
  polishOnlyChapters: number,
  wordCount: number,
  t: (key: string) => string,
): string {
  const structuralCount = (report?.findings ?? []).filter((f) => f.blocking).length;
  const score = computeQualityScore({
    wordCount,
    structuralCount,
    confirmedCount: blockingCorrections.length,
  });
  const ready = blockingCorrections.length === 0 && structuralCount === 0;
  const lines: string[] = [`# ${t("readiness_report_title")}: ${src}`, ""];
  lines.push(`**${t("quality_score_label")}: ${score}/100**`, "");
  lines.push(
    ready
      ? `**${t("readiness_ready")}**`
      : `**${t("readiness_check").replace(
          "{n}",
          String(blockingCorrections.length + structuralCount),
        )}**`,
  );
  lines.push("");

  const structuralBlocking = (report?.findings ?? []).filter((f) => f.blocking);
  if (structuralBlocking.length > 0) {
    lines.push(`## ${t("readiness_report_structural")}`, "");
    for (const f of structuralBlocking) {
      lines.push(`- **${f.location}** — ${f.message}${f.detail ? ` (${f.detail})` : ""}`);
    }
    lines.push("");
  }

  if (blockingCorrections.length > 0) {
    lines.push(`## ${t("readiness_report_corrections")}`, "");
    for (const issue of blockingCorrections) {
      const text =
        issue.kind === "correction"
          ? correctionIssueText(issue.correction, issue.originalText)
          : issue.message;
      const detail = issue.kind === "correction" ? issue.correction.reason : issue.detail;
      lines.push(`- **${issue.location}** — ${text}${detail ? ` (${detail})` : ""}`);
    }
    lines.push("");
  }

  lines.push(`## ${t("readiness_report_minor")}`, "");
  lines.push(
    minorTotal === 0
      ? t("readiness_no_minor")
      : t("readiness_minor")
          .replace("{n}", String(minorTotal))
          .replace("{m}", String(minorChapters)),
  );
  if (polishOnlyTotal >= POLISH_NUDGE_THRESHOLD) {
    lines.push(
      t("readiness_polish_nudge")
        .replace("{n}", String(polishOnlyTotal))
        .replace("{m}", String(polishOnlyChapters)),
    );
  }
  lines.push("");

  if (report) {
    lines.push(`${report.chaptersScanned} ${t("scan_chapters")}`);
  }

  return lines.join("\n");
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
    minorBreakStyle,
    setMinorBreakStyle,
    copyEditOptions,
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
  // A caveat the user must see BEFORE the file is handed over. A toast raised
  // alongside the download is hidden by the system save dialog and dismissed by
  // the time it closes.
  // Which publication-scan jobs have their per-chapter proofread detail
  // expanded under the verdict. Keyed by job so opening one scan's minor list
  // doesn't unfold every other scan in the old-results list.
  const [minorDetailJobs, setMinorDetailJobs] = useState<Set<string>>(
    () => new Set(),
  );
  const [exportWarning, setExportWarning] = useState<{
    message: string;
    confirmLabel: string;
    onConfirm: () => void | Promise<void>;
    /** Changes left out of the file, so they can be applied by hand. */
    unapplied?: SurgicalReport["detail"]["skipped"];
    unmappedCount?: number;
    /** The detail was trimmed to fit the response header. */
    truncated?: boolean;
    totalSkipped?: number;
    baseName?: string;
  } | null>(null);

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
        // Merge the persisted minor-break preference into every DOCX export.
        const blob = await exportDocx(markdown, {
          minorBreak: useStore.getState().minorBreakStyle,
          ...opts,
        });
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

  /**
   * Export the full manuscript by editing the user's own .docx in place.
   *
   * Falls back to the generative export when there is no original — but says
   * so. A silent fallback would hide the exact difference this feature exists
   * for: one download is the author's document with words changed, the other is
   * a rebuild that loses their formatting.
   */
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * The unapplied changes as a spreadsheet, so they can be worked through in
   * Word one by one. CSV because it opens everywhere without asking anything of
   * the user, and the columns are the three things applying a change needs:
   * where it is, what to select, what to type.
   */
  const downloadUnappliedCsv = (
    rows: SurgicalReport["detail"]["skipped"],
    baseName: string,
  ) => {
    const cell = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [
      [t("unapplied_col_where"), t("unapplied_col_replace"), t("unapplied_col_with")]
        .map(cell)
        .join(","),
      ...rows.map((r) =>
        [r.context, r.original, r.replacement].map(cell).join(","),
      ),
    ].join("\r\n");
    // The BOM is what makes Excel read this as UTF-8; without it every curly
    // quote and dash in an author's prose arrives mangled.
    downloadBlob(
      new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }),
      `${baseName}.unapplied-changes.csv`,
    );
  };

  const handleDownloadDocxSurgical = useCallback(
    async (
      pairs: { original: string; edited: string }[],
      markdown: string,
      filename: string,
    ) => {
      const docId = useStore.getState().document?.id;
      const name = useStore.getState().document?.name ?? "";
      if (!docId || !name.toLowerCase().endsWith(".docx")) {
        await handleDownloadDocx(markdown, filename);
        return;
      }
      try {
        const { blob, report } = await exportDocxSurgical(docId, pairs);
        // Warn BEFORE handing the file over. A toast raised after the download
        // starts is covered by the system save dialog and gone by the time it
        // closes, so the one caveat that matters was never actually read.
        if (report.skipped > 0) {
          setExportWarning({
            message: t("surgical_partial").replace(
              "{count}",
              String(report.skipped),
            ),
            confirmLabel: t("surgical_download_anyway"),
            onConfirm: () => downloadBlob(blob, filename),
            unapplied: report.detail.skipped,
            unmappedCount: report.detail.unmapped.length,
            truncated: report.detail.truncated,
            totalSkipped: report.detail.totalSkipped,
            baseName: filename.replace(/\.docx$/i, ""),
          });
          return;
        }
        downloadBlob(blob, filename);
      } catch (err) {
        if (!(err instanceof NoOriginalDocxError)) {
          console.error("Surgical DOCX export failed:", err);
        }
        // The fallback loses the author's formatting, which is exactly the
        // thing they chose this export for. Let them decide, not discover.
        setExportWarning({
          message:
            err instanceof NoOriginalDocxError
              ? t("surgical_unavailable")
              : t("surgical_failed"),
          confirmLabel: t("surgical_export_plain"),
          onConfirm: () => handleDownloadDocx(markdown, filename),
        });
      }
    },
    [handleDownloadDocx, t],
  );

  const [formattingEbook, setFormattingEbook] = useState(false);

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
  // Generic over what `build` produces: most exports want a markdown string,
  // but surgical export needs the per-chapter (original, edited) pairs too. The
  // built value is only ever handed to exportFn, so the shape is the caller's.
  const verifyThenExport = useCallback(
    async <T,>(
      taskIds: string[],
      build: (
        accepted: Record<string, Set<string>>,
        fixedTexts: Record<string, string>,
      ) => T,
      exportFn: (built: T) => void | Promise<void>,
    ) => {
      // `verifying` must only cover the (fast) spell check + rebuild. The
      // export step itself can be very slow (ebook formatting streams the
      // whole manuscript through the LLM) and has its own progress state —
      // holding `verifying` through it would disable every export button in
      // the app for the duration, making unrelated exports fail silently.
      let built: T;
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
              manuscriptLang: state.manuscriptLang || undefined,
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
        built = build(useStore.getState().acceptedCorrections, fixedTexts);
      } finally {
        setVerifying(false);
      }
      try {
        await exportFn(built);
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

  const handleSpawnWritingReport = useCallback(async (jobId: string) => {
    try {
      await spawnWritingReport(jobId);
    } catch (err) {
      console.error("Spawn writing report failed:", err);
      alert(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

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

  // Newest job (includes queued tasks) — used by the current-run header and
  // as the auto-hydrated job in the Former Runs view.
  const headerByJob: Record<string, TaskState[]> = {};
  for (const task of Object.values(tasks)) {
    (headerByJob[task.jobId ?? "legacy"] ??= []).push(task);
  }
  const newestJobId = Object.entries(headerByJob).sort(
    ([, a], [, b]) =>
      Math.max(...b.map((task) => task.submittedAt ?? 0)) -
      Math.max(...a.map((task) => task.submittedAt ?? 0)),
  )[0]?.[0];

  // ── Lazy result hydration ──
  // Old-results view: only opened jobs hydrate (newest pre-opened); a job's
  // body isn't even rendered until opened. Live view: everything in the
  // session-filtered task set hydrates as chapters reach a terminal state.
  const [openJobs, setOpenJobs] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (isOldResults && newestJobId) {
      setOpenJobs((p) =>
        p.has(newestJobId) ? p : new Set(p).add(newestJobId),
      );
    }
  }, [isOldResults, newestJobId]);
  const eligibleJobIds = useMemo<"all" | Set<string>>(
    () => (isOldResults ? openJobs : "all"),
    [isOldResults, openJobs],
  );
  const hydrating = useResultHydration(tasks, eligibleJobIds);

  const visibleTasks = Object.entries(tasks).filter(
    ([, s]) => s.status !== "queued",
  );
  // The current-session view stays mounted while everything is still queued so
  // the run header can show from the first second of a job.
  if (
    visibleTasks.length === 0 &&
    (isOldResults || Object.keys(tasks).length === 0)
  )
    return null;

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

      <Modal
        open={exportWarning !== null}
        onClose={() => setExportWarning(null)}
        labelledBy="export-warning-text"
      >
        <p className="model-confirm-text" id="export-warning-text">
          {exportWarning?.message}
        </p>

        {exportWarning?.unapplied && exportWarning.unapplied.length > 0 && (
          <div className="unapplied-block">
            <div className="unapplied-scroll">
              <table className="unapplied-table">
                <thead>
                  <tr>
                    <th>{t("unapplied_col_where")}</th>
                    <th>{t("unapplied_col_replace")}</th>
                    <th>{t("unapplied_col_with")}</th>
                  </tr>
                </thead>
                <tbody>
                  {exportWarning.unapplied.map((row, i) => (
                    <tr key={i}>
                      <td className="unapplied-context">{row.context}</td>
                      <td>
                        <del>{row.original}</del>
                      </td>
                      <td>
                        <ins>{row.replacement}</ins>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {exportWarning.truncated ? (
              <p className="unapplied-note">
                {t("unapplied_truncated")
                  .replace("{shown}", String(exportWarning.unapplied.length))
                  .replace("{total}", String(exportWarning.totalSkipped ?? 0))}
              </p>
            ) : null}
            {exportWarning.unmappedCount ? (
              <p className="unapplied-note">
                {t("unapplied_unmapped").replace(
                  "{count}",
                  String(exportWarning.unmappedCount),
                )}
              </p>
            ) : null}
            <button
              type="button"
              className="btn-secondary unapplied-download"
              onClick={() =>
                downloadUnappliedCsv(
                  exportWarning.unapplied ?? [],
                  exportWarning.baseName ?? "manuscript",
                )
              }
            >
              {t("unapplied_download")}
            </button>
          </div>
        )}

        <div className="model-confirm-actions">
          <button
            type="button"
            className="btn-primary"
            onClick={() => {
              const pending = exportWarning;
              setExportWarning(null);
              void pending?.onConfirm();
            }}
          >
            {exportWarning?.confirmLabel}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setExportWarning(null)}
          >
            {t("btn_cancel")}
          </button>
        </div>
      </Modal>

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

      {!isOldResults && newestJobId && (
        <CurrentRunHeader
          jobId={newestJobId}
          jobTasks={headerByJob[newestJobId]}
          modelNames={modelNames}
          lang={lang}
        />
      )}
      {!isOldResults && newestJobId && hydrating.has(newestJobId) && (
        <div className="results-hydrating-row">
          <span className="step-card-spinner" />
          {t("loading_results")}
        </div>
      )}

      {jobEntries.length === 0 && !(!isOldResults && newestJobId) && (
        <p className="review-empty-state">{t("review_empty")}</p>
      )}
      {(() => {
        const rendered = jobEntries.map(([jid, rawEntries], jobIndex) => {
          const isLatest = jobIndex === 0;
          // Sort tasks by chapter number so they appear in manuscript order.
          const entries = [...rawEntries].sort(
            ([, a], [, b]) => chapterSortKey(a.name) - chapterSortKey(b.name),
          );
          // Count only corrections scored for acceptance (exclude flagged),
          // consistent with the per-chapter header. Before a result is
          // hydrated we fall back to the lightweight resultMeta, which the
          // backend also computes flagged-exclusive.
          const totalCorrections = entries.reduce(
            (n, [, task]) =>
              n +
              (task.result
                ? task.result.corrections.filter((c) => !c.flagged).length
                : (task.resultMeta?.corrections ?? 0)),
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
              t.mode !== "blurb" &&
              t.mode !== "text_evaluator" &&
              t.mode !== "developmental_edit",
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

          // ── Publication Scan: a verdict, not a manual-review workbench ──
          // The publication verdict is the output. Objective/mechanical
          // corrections from the proofread tasks that ran beside it (typos,
          // duplicated words, wrong punctuation) surface IN the verdict as
          // blocking issues; only genuinely subjective suggestions are
          // counted rather than listed. This job hides the normal per-
          // correction fixing UI — accept-all, per-correction checkboxes —
          // and keeps the per-chapter detail folded until the user asks for
          // it from the verdict panel, offering two dedicated exports
          // instead ("safe fixes applied" manuscript, readiness report).
          // A failed scan is the exception: the run degenerates into an
          // ordinary proofread pass, and hiding its exports would leave the
          // user with nothing at all.
          const scanTaskEntry = entries.find(
            ([, task]) => task.mode === "publication_scan",
          );
          const isScanJob =
            !!scanTaskEntry &&
            scanTaskEntry[1].status !== "error" &&
            scanTaskEntry[1].status !== "cancelled";
          const showMinorDetail = minorDetailJobs.has(jid);

          // ── Shared manuscript-wide edit state (accept-all toggle + downloads) ──
          const editTasks = entries.filter(([, task]) =>
            EDIT_MODES.includes(task.mode),
          );
          const editTaskIds = editTasks.map(([tid]) => tid);
          const allEditDone = editTasks.every(
            ([, task]) => task.status === "done",
          );
          // Guard the full-manuscript exports against the brief window where a
          // task is done but its result hasn't hydrated yet.
          const editResultsReady = editTasks.every(([, task]) => task.result);
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

          // Dialect (British↔American) conversions can fire dozens of times
          // across a manuscript — one per swapped word — which would bloat
          // every chapter's list for something that's really one decision.
          // Summarized as a single job-level notice instead; the individual
          // corrections are excluded from each chapter's visible list below.
          const dialectCorrections = editTasks.flatMap(([tid, task]) =>
            (task.result?.corrections ?? [])
              .filter((c) => c.id && c.reason === "dialect")
              .map((c) => ({ tid, id: c.id as string })),
          );
          const dialectTargetDialect = editTasks
            .map(
              ([, task]) =>
                (task.editOptions as Record<string, unknown> | undefined)
                  ?.englishDialect,
            )
            .find((d): d is "american" | "british" => d === "american" || d === "british");
          const dialectAllAccepted =
            dialectCorrections.length > 0 &&
            dialectCorrections.every(({ tid, id }) => {
              const set = acceptedCorrections[tid] ?? new Set<string>();
              return (
                set.has(id) || [...set].some((k) => k.startsWith(`${id}:`))
              );
            });

          const jobNode = (
            <details
              key={jid}
              className="review-group"
              open={isOldResults ? openJobs.has(jid) : true}
              onToggle={(e) => {
                if (!isOldResults) return;
                const isOpen = (e.currentTarget as HTMLDetailsElement).open;
                setOpenJobs((p) => {
                  if (p.has(jid) === isOpen) return p;
                  const n = new Set(p);
                  if (isOpen) n.add(jid);
                  else n.delete(jid);
                  return n;
                });
              }}
            >
              <summary className="review-source">
                {t("results_for")} {src}{" "}
                <code className="task-id-chip" title={`job ${jid}`}>
                  #{jid.slice(0, 8)}
                </code>{" "}
                <span className="review-source-meta">
                  <span className="meta-chip">{submittedDate}</span>
                  <span className="meta-chip">
                    {entries.length} {entries.length === 1 ? "task" : "tasks"}
                  </span>
                  {jobModels.length > 0 && (
                    <span className="meta-chip">{jobModels.join(", ")}</span>
                  )}
                  {runningCount > 0 && (
                    <span className="meta-chip meta-chip-running">
                      {runningCount} running
                    </span>
                  )}
                  {failedChapters.length > 0 && (
                    <span className="meta-chip meta-chip-failed">
                      ⚠ {failedChapters.length} failed
                    </span>
                  )}
                  {totalCorrections > 0 && (
                    <span className="meta-chip">
                      {totalCorrections} corrections
                    </span>
                  )}
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

              {/* The body is expensive (every correction card). Old-results
                  jobs render it only once opened; while the job's results are
                  being fetched, show a spinner instead of empty placeholders. */}
              {isOldResults && !openJobs.has(jid) ? null : hydrating.has(jid) ? (
                <div className="results-hydrating-row">
                  <span className="step-card-spinner" />
                  {t("loading_results")}
                </div>
              ) : (
                <>
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
                    (t.result?.structuredData || t.resultMeta?.hasStructured),
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

              {/* ── Generate writing report button (post-edit, job level) ── */}
              {(() => {
                // Only the real edit modes qualify — the report digests their
                // corrections. (Frontend EDIT_MODES includes translate, which
                // has nothing to critique.)
                const reportSourceModes = [
                  "copy_edit",
                  "line_edit",
                  "combined_edit",
                ];
                const hasEditResults = entries.some(
                  ([, t]) =>
                    reportSourceModes.includes(t.mode) &&
                    t.status === "done" &&
                    (t.result?.originalText || t.resultMeta?.hasText),
                );
                if (!hasEditResults) return null;

                const hasReport = entries.some(
                  ([, t]) => t.mode === "text_evaluator",
                );
                return (
                  <div className="generate-buttons-row">
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => void handleSpawnWritingReport(jid)}
                    >
                      {hasReport
                        ? t("regenerate_writing_report")
                        : t("generate_writing_report")}
                    </button>
                  </div>
                );
              })()}

              {/* ── Writing report (text evaluator) ── */}
              {(() => {
                const reportTask = entries
                  .map(([, t]) => t)
                  .find((t) => t.mode === "text_evaluator");
                if (!reportTask) return null;

                if (
                  reportTask.status !== "done" ||
                  !reportTask.result?.editedText
                ) {
                  const pct = Math.round((reportTask.progress ?? 0) * 100);
                  return (
                    <details className="review-task" open>
                      <summary className="review-task-summary">
                        <span
                          className={`task-status-pill qs-${reportTask.status}`}
                        >
                          {t(`status_${reportTask.status}`)}
                        </span>{" "}
                        {t("writing_report")}
                      </summary>
                      <div className="task-placeholder">
                        {reportTask.status === "editing" && (
                          <>
                            <div className="q-bar q-bar-lg">
                              <div
                                className={`q-fill qs-${reportTask.status}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <p className="small-note">
                              {pct}%
                              {reportTask.phase
                                ? ` — ${reportTask.phase}`
                                : ""}
                            </p>
                          </>
                        )}
                        {(reportTask.status === "error" ||
                          reportTask.status === "cancelled") && (
                          <>
                            {reportTask.status === "error" && (
                              <p className="error-item">
                                ⚠️{" "}
                                {reportTask.result?.errors?.join("; ") ??
                                  t("status_error")}
                              </p>
                            )}
                            <button
                              type="button"
                              className="btn-retry"
                              onClick={() => void handleRetry(reportTask.id)}
                            >
                              ↻ {t("retry")}
                            </button>
                          </>
                        )}
                      </div>
                    </details>
                  );
                }

                return (
                  <details className="review-task review-summary-card" open>
                    <summary className="review-task-summary">
                      <strong>{t("writing_report")}</strong>
                    </summary>
                    <MarkdownView text={reportTask.result.editedText} />
                    <div className="export-buttons">
                      {SHOW_MARKDOWN_DOWNLOADS && (
                        <button
                          className="btn-secondary"
                          onClick={() =>
                            downloadFile(
                              reportTask.result!.editedText,
                              `${src}.writing-report.md`,
                              "text/markdown",
                            )
                          }
                        >
                          Download Markdown
                        </button>
                      )}
                      <button
                        className="btn-secondary"
                        onClick={() =>
                          handleDownloadDocx(
                            reportTask.result!.editedText,
                            `${src}.writing-report.docx`,
                          )
                        }
                      >
                        Download DOCX
                      </button>
                    </div>
                  </details>
                );
              })()}

              {/* ── Developmental report (developmental edit) ── */}
              {(() => {
                const devTask = entries
                  .map(([, t]) => t)
                  .find((t) => t.mode === "developmental_edit");
                if (!devTask) return null;

                if (devTask.status !== "done" || !devTask.result?.editedText) {
                  const pct = Math.round((devTask.progress ?? 0) * 100);
                  return (
                    <details className="review-task" open>
                      <summary className="review-task-summary">
                        <span className={`task-status-pill qs-${devTask.status}`}>
                          {t(`status_${devTask.status}`)}
                        </span>{" "}
                        {t("developmental_report")}
                      </summary>
                      <div className="task-placeholder">
                        {devTask.status === "editing" && (
                          <>
                            <div className="q-bar q-bar-lg">
                              <div
                                className={`q-fill qs-${devTask.status}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <p className="small-note">
                              {pct}%
                              {devTask.phase ? ` — ${devTask.phase}` : ""}
                            </p>
                          </>
                        )}
                        {(devTask.status === "error" ||
                          devTask.status === "cancelled") && (
                          <>
                            {devTask.status === "error" && (
                              <p className="error-item">
                                ⚠️{" "}
                                {devTask.result?.errors?.join("; ") ??
                                  t("status_error")}
                              </p>
                            )}
                            <button
                              type="button"
                              className="btn-retry"
                              onClick={() => void handleRetry(devTask.id)}
                            >
                              ↻ {t("retry")}
                            </button>
                          </>
                        )}
                      </div>
                    </details>
                  );
                }

                return (
                  <details className="review-task review-summary-card" open>
                    <summary className="review-task-summary">
                      <strong>{t("developmental_report")}</strong>
                    </summary>
                    <MarkdownView text={devTask.result.editedText} />
                    <div className="export-buttons">
                      {SHOW_MARKDOWN_DOWNLOADS && (
                        <button
                          className="btn-secondary"
                          onClick={() =>
                            downloadFile(
                              devTask.result!.editedText,
                              `${src}.developmental-edit.md`,
                              "text/markdown",
                            )
                          }
                        >
                          Download Markdown
                        </button>
                      )}
                      <button
                        className="btn-secondary"
                        onClick={() =>
                          handleDownloadDocx(
                            devTask.result!.editedText,
                            `${src}.developmental-edit.docx`,
                          )
                        }
                      >
                        Download DOCX
                      </button>
                    </div>
                  </details>
                );
              })()}

              {/* ── Publication readiness scan ── */}
              {(() => {
                const scanTask = entries
                  .map(([, t]) => t)
                  .find((t) => t.mode === "publication_scan");
                if (!scanTask) return null;

                if (scanTask.status !== "done") {
                  const pct = Math.round((scanTask.progress ?? 0) * 100);
                  return (
                    <details className="review-task" open>
                      <summary className="review-task-summary">
                        <span
                          className={`task-status-pill qs-${scanTask.status}`}
                        >
                          {t(`status_${scanTask.status}`)}
                        </span>{" "}
                        {t("mode_publication_scan")}
                      </summary>
                      <div className="task-placeholder">
                        {scanTask.status === "editing" && (
                          <p className="small-note">
                            {pct}%
                            {scanTask.phase ? ` — ${scanTask.phase}` : ""}
                          </p>
                        )}
                        {(scanTask.status === "error" ||
                          scanTask.status === "cancelled") && (
                          <button
                            type="button"
                            className="btn-retry"
                            onClick={() => void handleRetry(scanTask.id)}
                          >
                            ↻ {t("retry")}
                          </button>
                        )}
                      </div>
                    </details>
                  );
                }

                // Corrections come from the proofread tasks that ran beside
                // this scan. Only a mechanical correction BOTH the editor(s)
                // and the reviewer confirmed (blocksPublication && !flagged)
                // is listed as a publication blocker — exactly like normal
                // copy-edit review, where a flagged/unscored correction is
                // hidden rather than shown as if it had been vetted.
                // Deterministic checkers (spell-check especially) produce
                // enough false positives ("grey"→"trey") that surfacing every
                // one would bury the real issues, so anything not confirmed —
                // flagged mechanical or genuinely subjective — is simply
                // counted, not listed.
                const proofreadTasks = entries
                  .map(([, task]) => task)
                  .filter((task) => task.mode === "proofread");
                const blockingCorrections = proofreadTasks.flatMap((task) =>
                  (task.result?.corrections ?? [])
                    .filter((c) => c.blocksPublication && !c.flagged)
                    .map((c) =>
                      describeCorrection(
                        task.name,
                        task.result?.originalText ?? "",
                        c,
                      ),
                    ),
                );
                const minorCorrectionCount = (task: TaskState) =>
                  (task.result?.corrections ?? []).filter(
                    (c) => !c.blocksPublication || c.flagged,
                  ).length;
                const minorTotal = proofreadTasks.reduce(
                  (n, task) => n + minorCorrectionCount(task),
                  0,
                );
                const minorChapters = proofreadTasks.filter(
                  (task) => minorCorrectionCount(task) > 0,
                ).length;
                // Punctuation-only calls (comma/semicolon/period, no word
                // changed) within the minor bucket — common enough in bulk
                // that they're worth their own nudge toward a full copy edit.
                const polishCorrectionCount = (task: TaskState) =>
                  (task.result?.corrections ?? []).filter(
                    (c) => !c.blocksPublication && c.polishOnly,
                  ).length;
                const polishOnlyTotal = proofreadTasks.reduce(
                  (n, task) => n + polishCorrectionCount(task),
                  0,
                );
                const polishOnlyChapters = proofreadTasks.filter(
                  (task) => polishCorrectionCount(task) > 0,
                ).length;
                const scanWordCount = proofreadTasks.reduce(
                  (n, task) => n + (task.wordCount ?? 0),
                  0,
                );

                return (
                  <details className="review-task review-summary-card" open>
                    <summary className="review-task-summary">
                      <strong>{t("mode_publication_scan")}</strong>
                    </summary>
                    <PublicationReadinessPanel
                      report={
                        (scanTask.result?.structuredData as
                          | StructuralScanReport
                          | undefined) ?? null
                      }
                      blockingCorrections={blockingCorrections}
                      minorTotal={minorTotal}
                      minorChapters={minorChapters}
                      polishOnlyTotal={polishOnlyTotal}
                      polishOnlyChapters={polishOnlyChapters}
                      wordCount={scanWordCount}
                      onReviewMinor={() =>
                        setMinorDetailJobs((prev) => {
                          const next = new Set(prev);
                          if (next.has(jid)) next.delete(jid);
                          else next.add(jid);
                          return next;
                        })
                      }
                      minorOpen={showMinorDetail}
                      t={t}
                    />
                    {editTaskIds.length > 0 && (
                      <div className="export-buttons full-manuscript-export">
                        {SHOW_MARKDOWN_DOWNLOADS && (
                          <button
                            className="btn-primary"
                            disabled={!allEditDone || !editResultsReady || verifying}
                            title={allEditDone ? undefined : t("full_manuscript_wait")}
                            onClick={() => {
                              editTaskIds.forEach((tid) => acceptAll(tid));
                              void verifyThenExport(
                                editTaskIds,
                                (acc, fixed) => buildFullManuscript(entries, acc, fixed),
                                (md) => downloadFile(md, `${src}.safe-fixes.md`),
                              );
                            }}
                          >
                            {t("download_safe_fixes_md")}
                          </button>
                        )}
                        <button
                          className="btn-primary"
                          disabled={!allEditDone || !editResultsReady || verifying}
                          title={allEditDone ? undefined : t("full_manuscript_wait")}
                          onClick={() => {
                            editTaskIds.forEach((tid) => acceptAll(tid));
                            void verifyThenExport(
                              editTaskIds,
                              (acc, fixed) => buildFullManuscript(entries, acc, fixed),
                              (md) => handleDownloadDocx(md, `${src}.safe-fixes.docx`),
                            );
                          }}
                        >
                          {t("download_safe_fixes_docx")}
                        </button>
                        {SHOW_MARKDOWN_DOWNLOADS && (
                          <button
                            className="btn-secondary"
                            onClick={() =>
                              downloadFile(
                                buildReadinessReportMarkdown(
                                  src,
                                  (scanTask.result?.structuredData as
                                    | StructuralScanReport
                                    | undefined) ?? null,
                                  blockingCorrections,
                                  minorTotal,
                                  minorChapters,
                                  polishOnlyTotal,
                                  polishOnlyChapters,
                                  scanWordCount,
                                  t,
                                ),
                                `${src}.readiness-report.md`,
                              )
                            }
                          >
                            {t("download_readiness_report_md")}
                          </button>
                        )}
                        <button
                          className="btn-secondary"
                          onClick={() =>
                            void handleDownloadDocx(
                              buildReadinessReportMarkdown(
                                src,
                                (scanTask.result?.structuredData as
                                  | StructuralScanReport
                                  | undefined) ?? null,
                                blockingCorrections,
                                minorTotal,
                                minorChapters,
                                polishOnlyTotal,
                                polishOnlyChapters,
                                scanWordCount,
                                t,
                              ),
                              `${src}.readiness-report.docx`,
                            )
                          }
                        >
                          {t("download_readiness_report_docx")}
                        </button>
                      </div>
                    )}
                  </details>
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
                            <div className="q-bar q-bar-lg">
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
                      {SHOW_MARKDOWN_DOWNLOADS && (
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
                      )}
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
                            <div className="q-bar q-bar-lg">
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
                      {SHOW_MARKDOWN_DOWNLOADS && (
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
                      )}
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

                      // Layered outline first — the highest-altitude view.
                      if (obj.outline && typeof obj.outline === "object") {
                        subCards.push(
                          <details
                            key={`agg-${mode}-outline`}
                            className="review-task review-summary-card"
                            open
                          >
                            <summary className="review-task-summary">
                              <strong>🗺️ {t("mode_outline")}</strong>
                            </summary>
                            <OutlineZoomView
                              data={obj.outline as Record<string, unknown>}
                              t={t}
                            />
                          </details>,
                        );
                      }

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

              {/* On a scan job the chapter-by-chapter minor fixes stay folded
                  behind the verdict's "Review all" link — unfolding them is a
                  read-only look, never a fixing surface. */}
              {(!isScanJob || showMinorDetail) && (
              <>
              {isScanJob && (
                <p className="small-note readiness-readonly-note">
                  {t("readiness_read_only")}
                </p>
              )}
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
                // The synthesis / report tasks are rendered as their own
                // primary cards above.
                if (
                  task.mode === "analysis_summary" ||
                  task.mode === "text_evaluator" ||
                  task.mode === "developmental_edit" ||
                  task.mode === "publication_scan"
                ) {
                  return null;
                }

                // ── Placeholder for in-progress / errored / cancelled (no result yet) ──
                if (!result) {
                  const pct = Math.round((task.progress ?? 0) * 100);
                  return (
                    <details key={tid} className={`review-task rt-${task.status}`}>
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
                            <div className="q-bar q-bar-lg">
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
                // Combined (copy + line) runs tag each correction; treat any
                // untagged one as a copy edit. Single-mode tasks stay a flat list.
                const isCombined = task.mode === "combined_edit";
                const editTypeOf = (c: (typeof corrections)[number]) =>
                  c.editType ?? "copy";
                // The header count reflects only corrections scored for
                // acceptance — flagged suggestions (below the reviewer
                // threshold / unscored) are excluded, matching the default
                // visible list.
                const scoredCount = corrections.filter(
                  (c) => !c.flagged,
                ).length;
                const copyScored = corrections.filter(
                  (c) => !c.flagged && editTypeOf(c) === "copy",
                ).length;
                const lineScored = corrections.filter(
                  (c) => !c.flagged && editTypeOf(c) === "line",
                ).length;
                const isTranslation = task.mode === "translate";
                const hasChanges = isTranslation
                  ? result.editedText !== result.originalText
                  : corrections.length > 0;
                const countLabel = isCombined
                  ? `${t("copy_label")}: ${copyScored} · ${t("line_label")}: ${lineScored}`
                  : `${scoredCount} correction(s)`;
                const summary = isTranslation
                  ? `${task.name} — ${t("mode_translate")}`
                  : hasChanges
                    ? `${task.name} — ${countLabel}`
                    : `${task.name} — ${t("no_changes")}`;
                const dur = formatDuration(task);

                return (
                  <details key={tid} className={`review-task rt-${task.status}`}>
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
                      {!isTranslation && hasChanges && !isScanJob && (
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
                          // Dialect (British↔American) conversions are
                          // summarized in a single job-level banner instead
                          // of bloating every chapter's list — see the
                          // "Accept-all toggle" section below.
                          const visible = (showAll
                            ? corrections
                            : corrections.filter((c) => !c.flagged)
                          ).filter((c) => c.reason !== "dialect");
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
                          const renderCard = (
                            c: (typeof visible)[number],
                            i: number,
                          ) => {
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
                                readOnly={isScanJob}
                                originalText={result.originalText}
                              />
                            );
                          };
                          // Combined runs get one collapsible dropdown per edit
                          // type; each shows its scored count and hides flagged
                          // suggestions unless "show all" is on (same as the flat
                          // list). Empty groups are omitted.
                          const renderGroup = (
                            kind: "copy" | "line",
                            label: string,
                          ) => {
                            const groupAll = corrections.filter(
                              (c) => editTypeOf(c) === kind,
                            );
                            const groupVisible = showAll
                              ? groupAll
                              : groupAll.filter((c) => !c.flagged);
                            if (groupVisible.length === 0) return null;
                            const groupScored = groupAll.filter(
                              (c) => !c.flagged,
                            ).length;
                            return (
                              <details className="correction-group" open>
                                <summary className="correction-group-summary">
                                  {label} ({groupScored})
                                </summary>
                                {groupVisible.map((c, i) => renderCard(c, i))}
                              </details>
                            );
                          };
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
                                {!isScanJob && (
                                  <>
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
                                  </>
                                )}
                                <span className="small-note">
                                  {isScanJob
                                    ? visible.length
                                    : `${acceptedCount} ${t("of")} ${visible.length}`}{" "}
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
                              {isCombined ? (
                                <>
                                  {renderGroup("copy", t("copy_edits"))}
                                  {renderGroup("line", t("line_edits"))}
                                </>
                              ) : (
                                visible.map((c, i) => renderCard(c, i))
                              )}

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

                    {!isScanJob && (
                    <div className="export-buttons">
                      {SHOW_MARKDOWN_DOWNLOADS && (
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
                      )}
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
                    )}
                      </>
                    )}

                  </details>
                );
              })}
              </div>
              </>
              )}

              {/* ── Dialect (British↔American) summary: one notice instead of
                   one card per swapped word ── */}
              {dialectCorrections.length > 0 && !isScanJob && (
                <div className="dialect-banner">
                  <p className="small-note dialect-banner-text">
                    {t(
                      dialectTargetDialect === "british"
                        ? "dialect_banner_british"
                        : "dialect_banner_american",
                    ).replace("{n}", String(dialectCorrections.length))}
                  </p>
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => {
                      if (dialectAllAccepted) {
                        dialectCorrections.forEach(({ tid, id }) =>
                          dismissCorrection(tid, id),
                        );
                        setToast({ msg: t("dismiss_all_job_toast"), kind: "dismiss" });
                      } else {
                        dialectCorrections.forEach(({ tid, id }) =>
                          acceptCorrection(tid, id),
                        );
                        setToast({ msg: t("accept_all_job_toast"), kind: "accept" });
                      }
                    }}
                  >
                    {dialectAllAccepted ? t("dismiss_all_job") : t("accept_all_job")}
                  </button>
                </div>
              )}

              {/* ── Accept-all toggle: bottom of the chapter list, right-aligned ── */}
              {editTasks.length > 0 && !isScanJob && (
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
              {editTasks.length > 0 && !isScanJob && (
                <div className="export-minor-break-row" title={t("minor_break_hint")}>
                  <span className="option-toggle-label">
                    {t("export_minor_break")}
                  </span>
                  <div className="option-toggle-group">
                    <button
                      type="button"
                      className={`toggle-btn${minorBreakStyle === "blank" ? " active" : ""}`}
                      onClick={() => setMinorBreakStyle("blank")}
                    >
                      {t("minor_break_blank")}
                    </button>
                    <button
                      type="button"
                      className={`toggle-btn${minorBreakStyle === "hash" ? " active" : ""}`}
                      onClick={() => setMinorBreakStyle("hash")}
                    >
                      {t("minor_break_hash")}
                    </button>
                  </div>
                </div>
              )}
              {editTasks.length > 0 && !isScanJob && (
                <div className="export-buttons full-manuscript-export">
                  {SHOW_MARKDOWN_DOWNLOADS && (
                    <button
                      className="btn-primary"
                      disabled={!allEditDone || !editResultsReady || verifying}
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
                  )}
                  <button
                    className="btn-primary"
                    disabled={!allEditDone || !editResultsReady || verifying}
                    title={allEditDone ? undefined : t("full_manuscript_wait")}
                    onClick={() =>
                      verifyThenExport(
                        editTaskIds,
                        (acc, fixed) => ({
                          md: buildFullManuscript(entries, acc, fixed),
                          pairs: buildChapterPairs(entries, acc, fixed),
                        }),
                        ({ md, pairs }) =>
                          handleDownloadDocxSurgical(
                            pairs,
                            md,
                            `${src}.full.docx`,
                          ),
                      )
                    }
                  >
                    {t("download_full_docx")}
                  </button>
                  <button
                    className="btn-primary"
                    disabled={
                      !allEditDone ||
                      !editResultsReady ||
                      formattingEbook ||
                      verifying
                    }
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
                </>
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
