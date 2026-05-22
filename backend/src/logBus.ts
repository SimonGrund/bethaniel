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
): Diagnosis {
  const text = recentOutput.toLowerCase();

  // OOM / killed by OS
  if (
    signal === "SIGKILL" ||
    signal === "SIGBUS" ||
    text.includes("out of memory") ||
    text.includes("cannot allocate") ||
    text.includes("failed to allocate") ||
    text.includes("ggml_metal_graph_compute: command buffer") ||
    text.includes("bad_alloc")
  ) {
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
  return null;
}
