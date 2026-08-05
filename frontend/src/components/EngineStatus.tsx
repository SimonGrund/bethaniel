// ── Engine status feed ──
// Streams the last few diagnostics log entries as a single amber column in the
// sidebar. All parallel-task lines flow into one deduplicated stream (newest at
// the bottom) so the feed stays inside the narrow rail — no multi-column grid.
//
// Visibility is user-controlled via the "Show engine diagnostics" toggle in
// advanced settings (persisted as `showEngineStatus`), defaulting on.

import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";

// The feed fills the full rail height now, so keep a generous history; the
// flex container + overflow/fade mask gate how many lines are actually visible.
const MAX_LINES_PER_STREAM = 30;

export default function EngineStatus() {
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

  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [jobLogs.length]);

  // Guard placed after all hooks so hook order stays stable when the user
  // toggles this on/off at runtime.
  if (!showEngineStatus) return null;

  if (jobLogs.length === 0) {
    // No job has run yet — but if the selected model is warming up, surface
    // that to mask the cold-load latency.
    if (warmingModel && warmingModel === model && warmingStatus === "warming") {
      return (
        <ul className="engine-status" role="status" aria-live="polite">
          <li className="engine-status-line engine-status-info">
            Warming up the model… Ready when you are.
          </li>
        </ul>
      );
    }
    return null;
  }

  // Single amber column: all task lines merged, newest at the bottom —
  // deduplicate consecutive identical messages (e.g. repeated model launch
  // lines).
  const allLines: typeof jobLogs = [];
  for (const entry of jobLogs.slice(-MAX_LINES_PER_STREAM * 2)) {
    if (
      allLines.length === 0 ||
      allLines[allLines.length - 1].message !== entry.message
    ) {
      allLines.push(entry);
    }
  }
  const dedupedLines = allLines.slice(-MAX_LINES_PER_STREAM);
  return (
    <ul
      ref={listRef}
      className="engine-status"
      role="status"
      aria-live="polite"
    >
      {dedupedLines.map((e) => (
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
