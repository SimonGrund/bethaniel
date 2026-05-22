// ── Engine status feed ──
// Streams the last few diagnostics log entries next to the "Start Job"
// button as a stacked list, oldest at top → newest at bottom. Each new
// task resets the feed so it always shows just the current job's flow.

import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";

const MAX_LINES = 6;

export default function EngineStatus() {
  const tasks = useStore((s) => s.tasks);
  const logs = useStore((s) => s.logs);

  // Most recent task submission timestamp — used to clip the log feed so
  // each new job starts with a fresh stream.
  const latestTaskTs = useMemo(() => {
    let max = 0;
    for (const t of Object.values(tasks)) {
      if (t.submittedAt > max) max = t.submittedAt;
    }
    return max;
  }, [tasks]);

  const lines = useMemo(() => {
    if (latestTaskTs === 0) return [];
    // Keep a tiny grace window (300 ms) so a log emitted slightly before the
    // task record reaches the store still shows up.
    const cutoff = latestTaskTs - 300;
    return logs.filter((e) => e.ts >= cutoff).slice(-MAX_LINES);
  }, [logs, latestTaskTs]);

  const listRef = useRef<HTMLUListElement>(null);

  // Auto-scroll to the newest line.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, lines[lines.length - 1]?.id]);

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
