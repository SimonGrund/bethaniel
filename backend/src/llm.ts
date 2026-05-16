// ── LLM integration — OpenAI-compatible client for llama-server ──
// Drop-in replacement for ollama.ts. Talks to the llama.cpp server's
// /v1/chat/completions endpoint (SSE streaming). Falls back to Ollama
// HTTP API when LLAMA_BASE_URL is not set (dev mode).

import type { Correction } from "./types.js";
import {
  ensureModelLoaded,
  unloadCurrentModel,
  getCurrentModel,
} from "./llamaServer.js";
import { readModelConfig, type ModelSettings } from "./modelConfig.js";
import * as path from "path";
import * as fs from "fs";

const LLAMA_BASE_URL = process.env.LLAMA_BASE_URL ?? "";
const MODELS_DIR = process.env.MODELS_DIR ?? "./models";

/** Get the current model's config, or defaults if unavailable. */
function getActiveConfig(model: string): ModelSettings {
  const file = model.endsWith(".gguf") ? model : model + ".gguf";
  return readModelConfig(MODELS_DIR, file);
}

// ── Ollama fallback (dev mode) ──

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

function isLlamaCppMode(): boolean {
  return LLAMA_BASE_URL.length > 0;
}

// ── Model listing (reads GGUF files on disk) ──

/** List locally available model files. */
export async function listModels(): Promise<string[]> {
  if (!isLlamaCppMode()) {
    // Ollama fallback for dev mode
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`);
      const data = (await res.json()) as { models?: { name: string }[] };
      return data.models?.map((m) => m.name) ?? [];
    } catch {
      return [];
    }
  }
  try {
    const entries = await fs.promises.readdir(MODELS_DIR);
    return entries.filter(
      (e) => e.endsWith(".gguf") && !e.endsWith(".partial"),
    );
  } catch {
    return [];
  }
}

/** Get on-disk size of a model in bytes. */
export async function getModelSizeBytes(name: string): Promise<number | null> {
  if (!isLlamaCppMode()) {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/tags`);
      const data = (await res.json()) as {
        models?: { name: string; size?: number }[];
      };
      const match = data.models?.find(
        (m) => m.name === name || m.name.startsWith(name + ":"),
      );
      return match?.size ?? null;
    } catch {
      return null;
    }
  }
  try {
    const filePath = name.endsWith(".gguf")
      ? path.join(MODELS_DIR, name)
      : path.join(MODELS_DIR, name + ".gguf");
    const stat = await fs.promises.stat(filePath);
    return stat.size;
  } catch {
    return null;
  }
}

/** List currently loaded models. */
export async function listLoadedModels(): Promise<string[]> {
  if (!isLlamaCppMode()) {
    try {
      const res = await fetch(`${OLLAMA_HOST}/api/ps`);
      const data = (await res.json()) as { models?: { name: string }[] };
      return data.models?.map((m) => m.name) ?? [];
    } catch {
      return [];
    }
  }
  const current = getCurrentModel();
  return current ? [current] : [];
}

/** Unload a model from memory. */
export async function unloadModel(name: string): Promise<boolean> {
  if (!isLlamaCppMode()) {
    try {
      await fetch(`${OLLAMA_HOST}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: name,
          prompt: "",
          keep_alive: 0,
          options: { num_predict: 0 },
        }),
      });
      return true;
    } catch {
      return false;
    }
  }
  return unloadCurrentModel();
}

// ── Common SSE parser ──

async function* parseSSE(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;
        try {
          const parsed = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // Skip malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Ollama streaming (dev fallback) ──

async function* ollamaChatStream(
  model: string,
  messages: { role: string; content: string }[],
  opts: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      options: opts,
    }),
    signal,
  });

  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { message?: { content?: string } };
          const content = parsed.message?.content;
          if (content) yield content;
        } catch {
          // skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Core streaming chat via OpenAI-compatible API ──

async function* chatStream(
  model: string,
  messages: { role: string; content: string }[],
  options: {
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    response_format?: { type: string };
  },
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const cfg = getActiveConfig(model);

  if (!isLlamaCppMode()) {
    // Ollama fallback
    const ollamaOpts: Record<string, unknown> = {
      temperature: options.temperature ?? cfg.temperature,
      top_p: options.top_p ?? 0.9,
      num_ctx: cfg.num_ctx,
      num_predict: options.max_tokens ?? cfg.num_predict,
    };
    yield* ollamaChatStream(model, messages, ollamaOpts, signal);
    return;
  }

  // Ensure the model is loaded in llama-server
  await ensureModelLoaded(model);

  const body: Record<string, unknown> = {
    messages,
    stream: true,
    temperature: options.temperature ?? cfg.temperature,
    top_p: options.top_p ?? 0.9,
    max_tokens: options.max_tokens ?? cfg.num_predict,
  };
  if (options.response_format) {
    body.response_format = options.response_format;
  }

  const res = await fetch(`${LLAMA_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`llama-server error ${res.status}: ${text}`);
  }

  yield* parseSSE(res, signal);
}

// ── Prompt helpers (same as before) ──

/** Build system message: model config system preamble + task-specific prompt + /no_think. */
function buildSystemMessage(model: string, taskPrompt: string): string {
  const cfg = getActiveConfig(model);
  // The config system prompt already ends with /no_think if set from modelfile
  const hasNoThink =
    cfg.system.includes("/no_think") || taskPrompt.includes("/no_think");
  const parts = [cfg.system, taskPrompt].filter(Boolean);
  const combined = parts.join("\n\n");
  return hasNoThink ? combined : combined + "\n\n/no_think";
}

// ── Exported streaming functions (same signatures as ollama.ts) ──

/** Streaming edit — yields tokens as the model produces them. */
export async function* editChunkStream(
  model: string,
  chunkText: string,
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  yield* chatStream(
    model,
    [
      { role: "system", content: buildSystemMessage(model, systemPrompt) },
      { role: "user", content: chunkText },
    ],
    { temperature: 0.1 },
    signal,
  );
}

/** Streaming corrections-mode call — yields raw JSON tokens. */
export async function* findCorrectionsStream(
  model: string,
  chunkText: string,
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  yield* chatStream(
    model,
    [
      { role: "system", content: buildSystemMessage(model, systemPrompt) },
      { role: "user", content: chunkText },
    ],
    {
      response_format: { type: "json_object" },
    },
    signal,
  );
}

/** Streaming analysis call — collects JSON output for catalog/timeline modes. */
export async function* analyzeStream(
  model: string,
  text: string,
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  yield* chatStream(
    model,
    [
      { role: "system", content: buildSystemMessage(model, systemPrompt) },
      { role: "user", content: text },
    ],
    {
      max_tokens: 4096,
      response_format: { type: "json_object" },
    },
    signal,
  );
}

/** Stream a free-text (Markdown) synthesis from a JSON payload. */
export async function* synthesizeStream(
  model: string,
  jsonPayload: string,
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  yield* chatStream(
    model,
    [
      { role: "system", content: buildSystemMessage(model, systemPrompt) },
      { role: "user", content: jsonPayload },
    ],
    { max_tokens: 1500 },
    signal,
  );
}

// ── JSON parsing (unchanged from ollama.ts) ──

/**
 * Parse the model's JSON output into a list of corrections.
 * Tolerates code fences and stray commentary.
 */
export function parseCorrectionsJson(raw: string): Correction[] {
  let text = raw.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "");
    text = text.replace(/\s*```\s*$/, "");
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    text = text.slice(first, last + 1);
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }

  const corrections = Array.isArray(data.corrections) ? data.corrections : [];
  const cleaned: Correction[] = [];
  for (const c of corrections) {
    if (typeof c !== "object" || c === null) continue;
    const rec = c as Record<string, unknown>;
    const original = rec.original;
    const corrected = rec.corrected;
    if (
      typeof original === "string" &&
      typeof corrected === "string" &&
      original
    ) {
      cleaned.push({ original, corrected });
    }
  }
  return cleaned;
}

// Markdown markers we never let the model strip via a correction.
const MARKDOWN_MARKER_PATTERNS: [string, RegExp][] = [
  ["triple-asterisk", /\*\*\*/g],
  ["double-asterisk (bold)", /\*\*/g],
  ["single-asterisk (italic)", /(?<!\*)\*(?!\*)/g],
  ["double-underscore (bold)", /__/g],
  ["single-underscore (italic)", /(?<!_)_(?!_)/g],
  ["backtick (code)", /`/g],
  ["heading marker (#)", /(?:^|\n)\s*#{1,6}\s/g],
  ["blockquote (>)", /(?:^|\n)\s*>/g],
  ["list marker", /(?:^|\n)\s*(?:[-*+]|\d+\.)\s/g],
  ["link/image bracket", /[\[\]]/g],
];

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return (text.match(pattern) ?? []).length;
}

function markdownMarkerViolation(
  original: string,
  corrected: string,
): string | null {
  for (const [label, pattern] of MARKDOWN_MARKER_PATTERNS) {
    const beforeCount = countMatches(original, pattern);
    const afterCount = countMatches(corrected, pattern);
    if (afterCount < beforeCount) {
      return `removed ${beforeCount - afterCount}× ${label}`;
    }
  }
  return null;
}

/**
 * Apply a list of corrections to text.
 * Returns [newText, applied, skipped].
 */
export function applyCorrections(
  text: string,
  corrections: Correction[],
): [string, Correction[], Correction[]] {
  const applied: Correction[] = [];
  const skipped: Correction[] = [];
  let newText = text;

  for (const c of corrections) {
    if (c.original === c.corrected) {
      skipped.push({ ...c, reason: "no-op" });
      continue;
    }
    const formattingIssue = markdownMarkerViolation(c.original, c.corrected);
    if (formattingIssue) {
      skipped.push({
        ...c,
        reason: `would alter markdown: ${formattingIssue}`,
      });
      continue;
    }
    const count = newText.split(c.original).length - 1;
    if (count === 0) {
      skipped.push({ ...c, reason: "not found" });
    } else if (count > 1) {
      skipped.push({ ...c, reason: `ambiguous (${count} matches)` });
    } else {
      newText = newText.replace(c.original, c.corrected);
      applied.push(c);
    }
  }
  return [newText, applied, skipped];
}

/** Parse a generic JSON response, tolerating code fences and thinking blocks. */
export function parseJsonResponse(raw: string): unknown {
  let text = raw.trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "");
    text = text.replace(/\s*```\s*$/, "");
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    text = text.slice(first, last + 1);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
