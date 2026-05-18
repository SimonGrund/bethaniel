// ── Ollama integration — ported from book_editor.py ──

import { Ollama } from "ollama";
import type { Correction } from "./types.js";

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";

let ollamaClient: Ollama | null = null;

function getClient(): Ollama {
  if (!ollamaClient) {
    ollamaClient = new Ollama({ host: OLLAMA_HOST });
  }
  return ollamaClient;
}

/** List locally available Ollama models. */
export async function listModels(): Promise<string[]> {
  try {
    const client = getClient();
    const response = await client.list();
    return response.models.map((m: { name: string }) => m.name);
  } catch {
    return [];
  }
}

/** Get on-disk size of a model in bytes (approximates loaded weight RAM). */
export async function getModelSizeBytes(name: string): Promise<number | null> {
  try {
    const client = getClient();
    const response = await client.list();
    const match = response.models.find(
      (m: { name: string; size?: number }) =>
        m.name === name || m.name.startsWith(name + ":"),
    );
    return match?.size ?? null;
  } catch {
    return null;
  }
}

/**
 * List currently loaded models (Ollama's "ps" — models holding RAM right now).
 */
export async function listLoadedModels(): Promise<string[]> {
  try {
    const client = getClient();
    // ollama-js exposes `ps()` for the running models endpoint.
    const resp = await (
      client as unknown as { ps: () => Promise<{ models: { name: string }[] }> }
    ).ps();
    return resp.models?.map((m) => m.name) ?? [];
  } catch {
    return [];
  }
}

/**
 * Ask Ollama to unload a model from memory immediately by issuing a no-op
 * generate call with keep_alive=0. Returns true on success.
 */
export async function unloadModel(name: string): Promise<boolean> {
  try {
    const client = getClient();
    await client.generate({
      model: name,
      prompt: "",
      keep_alive: 0,
      options: { num_predict: 0 },
    });
    return true;
  } catch (err) {
    console.warn(
      `[Ollama] unload "${name}" failed:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Common per-call options. Caps output length so the model can't spin forever. */
function llmOptions(extra: Record<string, unknown> = {}) {
  return {
    temperature: 0.0,
    top_p: 0.9,
    num_ctx: 8192,
    num_predict: 8192,
    ...extra,
  };
}

/** Append `/no_think` to instruct Qwen3 (and similar) to skip reasoning traces. */
function noThink(systemPrompt: string): string {
  return systemPrompt + "\n\n/no_think";
}

/** Streaming edit — yields tokens as the model produces them. */
export async function* editChunkStream(
  model: string,
  chunkText: string,
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const client = getClient();
  const stream = await client.chat({
    model,
    messages: [
      { role: "system", content: noThink(systemPrompt) },
      { role: "user", content: chunkText },
    ],
    think: false,
    options: llmOptions({ temperature: 0.1 }),
    stream: true,
  });

  for await (const part of stream) {
    if (signal?.aborted) break;
    const token = part.message?.content ?? "";
    if (token) yield token;
  }
}

/** Streaming corrections-mode call — yields raw JSON tokens. */
export async function* findCorrectionsStream(
  model: string,
  chunkText: string,
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const client = getClient();
  const stream = await client.chat({
    model,
    messages: [
      { role: "system", content: noThink(systemPrompt) },
      { role: "user", content: chunkText },
    ],
    think: false,
    format: "json",
    options: llmOptions(),
    stream: true,
  });

  for await (const part of stream) {
    if (signal?.aborted) break;
    const token = part.message?.content ?? "";
    if (token) yield token;
  }
}

/**
 * Parse the model's JSON output into a list of corrections.
 * Tolerates code fences and stray commentary.
 */
export function parseCorrectionsJson(raw: string): Correction[] {
  let text = raw.trim();
  // Strip <think>…</think> blocks (Qwen3 and other reasoning models)
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Strip code fences
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/, "");
    text = text.replace(/\s*```\s*$/, "");
  }
  // Find first { to last }
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
  // Reset lastIndex for global regex
  pattern.lastIndex = 0;
  return (text.match(pattern) ?? []).length;
}

/** Return a reason string if the correction strips a markdown marker. */
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

/**
 * Streaming analysis call — collects JSON output for catalog/timeline modes.
 * Map-reduce already keeps each chunk small (~4000 words = ~5500 tokens), so
 * 8192 ctx + 4096 output is plenty and keeps KV cache modest when
 * OLLAMA_NUM_PARALLEL is high.
 */
export async function* analyzeStream(
  model: string,
  text: string,
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const client = getClient();
  const stream = await client.chat({
    model,
    messages: [
      { role: "system", content: noThink(systemPrompt) },
      { role: "user", content: text },
    ],
    think: false,
    format: "json",
    options: llmOptions({ num_ctx: 8192, num_predict: 4096 }),
    stream: true,
  });

  for await (const part of stream) {
    if (signal?.aborted) break;
    const token = part.message?.content ?? "";
    if (token) yield token;
  }
}

/** Stream a free-text (Markdown) synthesis from a JSON payload. */
export async function* synthesizeStream(
  model: string,
  jsonPayload: string,
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const client = getClient();
  const stream = await client.chat({
    model,
    messages: [
      { role: "system", content: noThink(systemPrompt) },
      { role: "user", content: jsonPayload },
    ],
    think: false,
    options: llmOptions({ num_ctx: 8192, num_predict: 1500 }),
    stream: true,
  });

  for await (const part of stream) {
    if (signal?.aborted) break;
    const token = part.message?.content ?? "";
    if (token) yield token;
  }
}

/** Parse a generic JSON response, tolerating code fences and thinking blocks. */
export function parseJsonResponse(raw: string): unknown {
  let text = raw.trim();
  // Strip <think>…</think> blocks (Qwen3 and other reasoning models)
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
