// ── Engine status feed ──
// Streams the last few diagnostics log entries as a single amber column in the
// sidebar. All parallel-task lines flow into one deduplicated stream (newest at
// the bottom) so the feed stays inside the narrow rail — no multi-column grid.
//
// Visibility is user-controlled via the "Show engine diagnostics" toggle in
// advanced settings (persisted as `showEngineStatus`), defaulting on.

import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";
import type { LogEntry } from "../types";

// The feed fills the full rail height now, so keep a generous history; the
// flex container + overflow/fade mask gate how many lines are actually visible.
const MAX_LINES_PER_STREAM = 30;

/**
 * The feed's content, shared with the sidebar so it can decide whether to
 * reserve rail for the dock at all. An empty amber box holding its floor
 * height is just space stolen from the setup block above it, and only this
 * hook knows whether there is anything to say.
 */
export function useEngineFeed(): { warming: boolean; lines: LogEntry[] } {
  const showEngineStatus = useStore((s) => s.showEngineStatus);
  const tasks = useStore((s) => s.tasks);
  const logs = useStore((s) => s.logs);
  const warmingModel = useStore((s) => s.warmingModel);
  const warmingStatus = useStore((s) => s.warmingStatus);
  const model = useStore((s) => s.model);

  // Most recent task submission timestamp — used to clip the log feed so
  // each new job starts with a fresh stream.
  const latestTaskTs = useMemo(() => {
    let max = 0;
    for (const t of Object.values(tasks)) {
      if (t.submittedAt > max) max = t.submittedAt;
    }
    return max;
  }, [tasks]);

  // Filter logs to current job window
  const jobLogs = useMemo(() => {
    if (latestTaskTs === 0) return [];
    const cutoff = latestTaskTs - 300;
    return logs.filter((e) => e.ts >= cutoff);
  }, [logs, latestTaskTs]);

  // Single amber column: all task lines merged, newest at the bottom —
  // deduplicate consecutive identical messages (e.g. repeated model launch
  // lines).
  const lines = useMemo(() => {
    const merged: LogEntry[] = [];
    for (const entry of jobLogs.slice(-MAX_LINES_PER_STREAM * 2)) {
      if (merged.length === 0 || merged[merged.length - 1].message !== entry.message) {
        merged.push(entry);
      }
    }
    return merged.slice(-MAX_LINES_PER_STREAM);
  }, [jobLogs]);

  if (!showEngineStatus) return { warming: false, lines: [] };

  // No job has run yet — but if the selected model is warming up, surface
  // that to mask the cold-load latency.
  const warming =
    lines.length === 0 &&
    !!warmingModel &&
    warmingModel === model &&
    warmingStatus === "warming";

  return { warming, lines };
}

export default function EngineStatus() {
  const { warming, lines } = useEngineFeed();

  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  if (warming) {
    return (
      <ul className="engine-status" role="status" aria-live="polite">
        <li className="engine-status-line engine-status-info">
          Warming up the model… Ready when you are.
        </li>
      </ul>
    );
  }

  if (lines.length === 0) return null;

  return (
    <ul
      ref={listRef}
      className="engine-status"
      role="status"
      aria-live="polite"
    >
      {lines.map((e) => (
        <li
          key={e.id}
          className={`engine-status-line engine-status-${e.level}`}
          title={e.message}
        >
          {e.message}
        </li>
      ))}
    </ul>
  );
}
