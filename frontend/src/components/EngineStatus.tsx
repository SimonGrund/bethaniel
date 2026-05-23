// ── Engine status feed ──
// Streams the last few diagnostics log entries next to the "Start Job"
// button. When multiple tasks run in parallel, displays a grid of
// per-runner streams, each with an amber border and task ID header.

import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../store";

const MAX_LINES_PER_STREAM = 6;

/** Truncate a task ID for display: first 8 chars. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

function StreamCell({
  taskId,
  lines,
}: {
  taskId: string;
  lines: { id: string; message: string; level: string }[];
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div className="engine-stream-cell">
      <div className="engine-stream-header">{shortId(taskId)}</div>
      <ul ref={listRef} className="engine-stream-list">
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
    </div>
  );
}

export default function EngineStatus() {
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

  // Group by taskId. Entries without a taskId go into a "general" bucket.
  const streams = useMemo(() => {
    const map = new Map<string, typeof jobLogs>();
    for (const entry of jobLogs) {
      const key = entry.taskId ?? "__general__";
      const arr = map.get(key);
      if (arr) {
        arr.push(entry);
      } else {
        map.set(key, [entry]);
      }
    }
    // Trim each stream to MAX_LINES_PER_STREAM
    for (const [k, arr] of map) {
      if (arr.length > MAX_LINES_PER_STREAM) {
        map.set(k, arr.slice(-MAX_LINES_PER_STREAM));
      }
    }
    return map;
  }, [jobLogs]);

  // Determine if we need multi-stream grid view
  const taskStreams = useMemo(() => {
    const entries: [string, typeof jobLogs][] = [];
    for (const [k, v] of streams) {
      if (k !== "__general__") entries.push([k, v]);
    }
    return entries;
  }, [streams]);

  const generalLines = streams.get("__general__") ?? [];

  // Single-stream fallback (legacy view): only general lines or 1 task
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [generalLines.length, jobLogs.length]);

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

  // Multi-stream grid view when 2+ tasks are running in parallel
  if (taskStreams.length >= 2) {
    return (
      <div className="engine-status-grid">
        {taskStreams.map(([tid, lines]) => (
          <StreamCell key={tid} taskId={tid} lines={lines} />
        ))}
      </div>
    );
  }

  // Single-stream view (1 task or only general logs) — deduplicate
  // consecutive identical messages (e.g. repeated model launch lines).
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
