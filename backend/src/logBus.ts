// ── Diagnostic log bus ──
// Collects user-facing diagnostic events (engine crashes, task errors,
// model load failures) into a ring buffer and broadcasts them to all
// connected Socket.IO clients so the UI can render a navigable log.

import type { Server as SocketServer } from "socket.io";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  /** Optional i18n key identifying a suggested next action. */
  hintKey?: string;
  /** Optional pre-formatted suggested next action (fallback when no key). */
  hint?: string;
  /** Optional model file name this entry relates to. */
  model?: string;
  /** Optional task ID this entry relates to (for per-runner streams). */
  taskId?: string;
}

const MAX_ENTRIES = 500;
const buffer: LogEntry[] = [];
let io: SocketServer | null = null;
let nextId = 1;

export function setLogIo(server: SocketServer): void {
  io = server;
}

export function getLogSnapshot(): LogEntry[] {
  return buffer.slice();
}

export function clearLogs(): void {
  buffer.length = 0;
  io?.emit("log:clear");
}

/**
 * Drop the problems a task left behind once it has come good.
 *
 * A chapter that failed and then succeeded on retry leaves error entries that
 * describe a state no longer true, and the panel would keep flagging them.
 * Removing them keeps the feed to problems that still need attention.
 *
 * The trade-off is deliberate and worth knowing: this discards the record of a
 * transient failure, so a run that recovered leaves no trace of *why* it was
 * slow. Only entries tagged with the task are touched — engine-wide errors
 * carry no taskId and survive.
 */
export function resolveLogsForTask(taskId: string): number {
  if (!taskId) return 0;
  const keep = buffer.filter(
    (e) => e.taskId !== taskId || e.level === "info",
  );
  const removed = buffer.length - keep.length;
  if (removed === 0) return 0;
  buffer.length = 0;
  buffer.push(...keep);
  io?.emit("log:resolve", { taskId });
  return removed;
}

export function appendLog(entry: Omit<LogEntry, "id" | "ts">): LogEntry {
  const full: LogEntry = {
    id: String(nextId++),
    ts: Date.now(),
    ...entry,
  };
  buffer.push(full);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  io?.emit("log:append", full);
  return full;
}

// ── Classification ─────────────────────────────────────────────────────────
// Examines llama-server output and task error messages and returns a
// user-facing hint (i18n key) describing the most likely remediation.

export interface Diagnosis {
  hintKey: string;
  level: LogLevel;
}

/**
 * Inspect recent llama-server stderr/stdout and the exit code/signal to
 * classify why the engine died.
 */
export function diagnoseEngineExit(
  recentOutput: string,
  code: number | null,
  signal: NodeJS.Signals | null,
  opts: { deliberate?: boolean } = {},
): Diagnosis {
  const text = recentOutput.toLowerCase();

  // Memory exhaustion stated outright in the engine's own output. This is the
  // strong evidence and wins even over a shutdown we initiated — the engine may
  // already have been dying when we stopped it.
  const saysOom =
    text.includes("out of memory") ||
    text.includes("cannot allocate") ||
    text.includes("failed to allocate") ||
    text.includes("ggml_metal_graph_compute: command buffer") ||
    text.includes("bad_alloc");

  if (saysOom) {
    return { hintKey: "log_hint_oom", level: "error" };
  }

  // A stop we asked for. The idle-unloader frees RAM between jobs with SIGTERM
  // then SIGKILL, so without this every such unload was reported as "Out of
  // memory — pick a smaller model" on machines with gigabytes to spare. That is
  // not just noise: it points the user at the wrong problem.
  if (opts.deliberate) {
    return { hintKey: "log_hint_model_unloaded", level: "info" };
  }

  // A kill we did NOT initiate. The OS OOM killer really does SIGKILL, and
  // SIGBUS commonly means a mapped model file could not be paged in.
  if (signal === "SIGKILL" || signal === "SIGBUS") {
    return { hintKey: "log_hint_oom", level: "error" };
  }

  // Corrupt / incomplete model file
  if (
    text.includes("invalid magic") ||
    text.includes("unknown magic") ||
    (text.includes("tensor") && text.includes("not found")) ||
    text.includes("failed to load model") ||
    text.includes("error loading model") ||
    (text.includes("gguf") && text.includes("invalid")) ||
    text.includes("unexpected eof") ||
    text.includes("truncated")
  ) {
    return { hintKey: "log_hint_corrupt_model", level: "error" };
  }

  // Context too large for available RAM
  if (
    (text.includes("kv cache") && text.includes("failed")) ||
    (text.includes("n_ctx") && text.includes("too large"))
  ) {
    return { hintKey: "log_hint_context_too_large", level: "error" };
  }

  // Generic non-zero exit
  if (code !== 0 && code !== null) {
    return { hintKey: "log_hint_engine_crash_generic", level: "error" };
  }

  return { hintKey: "log_hint_engine_crash_generic", level: "warn" };
}

/**
 * Classify a per-task error message into a user-facing hint.
 */
export function diagnoseTaskError(message: string): Diagnosis | null {
  const text = message.toLowerCase();
  if (text.includes("cancelled") || text.includes("aborted")) {
    return { hintKey: "log_hint_cancelled", level: "info" };
  }
  if (
    text.includes("econnrefused") ||
    text.includes("econnreset") ||
    text.includes("socket hang up") ||
    text.includes("terminated") ||
    text.includes("fetch failed") ||
    text.includes("undici")
  ) {
    // Engine likely died — defer to engine-crash hint (already emitted
    // separately) but still note network failure for context.
    return { hintKey: "log_hint_engine_unreachable", level: "error" };
  }
  if (text.includes("model file not found")) {
    return { hintKey: "log_hint_model_missing", level: "error" };
  }
  if (text.includes("failed to start llama-server")) {
    return { hintKey: "log_hint_binary_missing", level: "error" };
  }
  if (
    text.includes("context size has been exceeded") ||
    text.includes("exceed context") ||
    text.includes("context window") ||
    text.includes("n_ctx") ||
    text.includes("kv cache")
  ) {
    return { hintKey: "log_hint_context_too_large", level: "error" };
  }
  if (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("etimedout")
  ) {
    return { hintKey: "log_hint_timeout", level: "error" };
  }
  if (
    text.includes("failed to parse json") ||
    text.includes("parse json") ||
    text.includes("unexpected token") ||
    text.includes("is not valid json") ||
    text.includes("0 content tokens")
  ) {
    return { hintKey: "log_hint_bad_output", level: "warn" };
  }
  return null;
}
