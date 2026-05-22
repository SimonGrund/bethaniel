// ── LLM integration — OpenAI-compatible client for llama-server ──
// All models are local GGUF files loaded by the bundled llama-server.
// No external dependencies (Ollama, etc.) required.

import type { Correction } from "./types.js";
import {
  ensureModelLoaded,
  unloadCurrentModel,
  getCurrentModel,
  getLlamaBaseUrl,
} from "./llamaServer.js";
import { readModelConfig, type ModelSettings } from "./modelConfig.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR =
  process.env.MODELS_DIR ?? path.resolve(__dirname, "../models");

/** Get the current model's config, or defaults if unavailable. */
function getActiveConfig(model: string): ModelSettings {
  const file = model.endsWith(".gguf") ? model : model + ".gguf";
  return readModelConfig(MODELS_DIR, file);
}

// ── Model listing (reads GGUF files on disk) ──

/** List locally available model files. */
export async function listModels(): Promise<string[]> {
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
  const current = getCurrentModel();
  return current ? [current] : [];
}

/** Unload a model from memory. */
export async function unloadModel(_name: string): Promise<boolean> {
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

// ── Core streaming chat via OpenAI-compatible API ──

async function* chatStream(
  model: string,
  messages: { role: string; content: string }[],
  options: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    repeat_penalty?: number;
    max_tokens?: number;
    response_format?: { type: string };
    /** Override the context window size for this request. When set the
     *  llama-server will be restarted with `-c <numCtxOverride>` if the
     *  currently running instance was started with a different context size. */
    numCtxOverride?: number;
  },
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const cfg = getActiveConfig(model);

  // Ensure the model is loaded in llama-server with the required context size.
  await ensureModelLoaded(model, options.numCtxOverride);

  // All sampling params come from the per-model config (catalog defaults +
  // user sidecar overrides). Per-call options are only used for niche
  // overrides; in normal flows callers pass none.
  const body: Record<string, unknown> = {
    messages,
    stream: true,
    temperature: options.temperature ?? cfg.temperature,
    top_p: options.top_p ?? cfg.top_p,
    top_k: options.top_k ?? cfg.top_k,
    repeat_penalty: options.repeat_penalty ?? cfg.repeat_penalty,
    max_tokens: options.max_tokens ?? cfg.num_predict,
  };
  if (options.response_format) {
    body.response_format = options.response_format;
  }

  const baseUrl = getLlamaBaseUrl();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
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
  // The shared BASE_SYSTEM_PROMPT (defined in modelCatalog.ts) already ends
  // with /no_think; only append the marker if neither part already has it.
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
    {},
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
  const cfg = getActiveConfig(model);
  // The corrections JSON is always strictly smaller than the chunk it
  // describes (it only lists changes). Cap max_tokens proportionally to
  // bound runaway generation if the model misses a closing bracket. ~3
  // chars/token is a safe cheap estimate for English-ish text.
  const estInputTokens = Math.ceil(chunkText.length / 3);
  const cap = Math.min(cfg.num_predict, Math.ceil(estInputTokens * 1.2) + 256);
  yield* chatStream(
    model,
    [
      { role: "system", content: buildSystemMessage(model, systemPrompt) },
      { role: "user", content: chunkText },
    ],
    {
      response_format: { type: "json_object" },
      max_tokens: cap,
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

/** Stream a free-text (Markdown) synthesis from a JSON payload.
 *  `numCtxOverride` allows the caller to request a larger context window for
 *  this single call (e.g. when the merged analysis JSON exceeds the model's
 *  default context). The llama-server is restarted with the new size if
 *  needed and will be restarted back to the default size on the next
 *  non-overridden call. */
export async function* synthesizeStream(
  model: string,
  jsonPayload: string,
  systemPrompt: string,
  numCtxOverride?: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  yield* chatStream(
    model,
    [
      { role: "system", content: buildSystemMessage(model, systemPrompt) },
      { role: "user", content: jsonPayload },
    ],
    { max_tokens: 1500, numCtxOverride },
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
