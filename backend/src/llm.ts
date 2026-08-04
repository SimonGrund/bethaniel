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
import {
  readModelConfig,
  readApiConfig,
  type ModelSettings,
} from "./modelConfig.js";
import { appendLog } from "./logBus.js";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR =
  process.env.MODELS_DIR ?? path.resolve(__dirname, "../models");

/**
 * Average characters-per-token for our supported languages. Used everywhere we
 * estimate token counts from text length so prefill/decode logging and slot
 * budgeting agree (previously llm.ts used 3 and queue.ts used 3.5). 3.5 is a
 * conservative middle ground for English prose plus JSON formatting overhead.
 */
export const CHARS_PER_TOKEN = 3.5;

/** Estimate token count from raw text length using {@link CHARS_PER_TOKEN}. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Per-slot context window (tokens) for a model, from its active config. */
export function getContextWindow(model: string): number {
  return getActiveConfig(model).num_ctx;
}

/** Get the current model's config, or defaults if unavailable. */
function getActiveConfig(model: string): ModelSettings {
  const file = model.startsWith("custom:")
    ? model
    : model.endsWith(".gguf")
      ? model
      : model + ".gguf";
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
  model?: string,
): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  let dropped = 0;

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
          // Malformed SSE line — count it so a fully-garbled stream (which
          // otherwise surfaces only as "0 content tokens") is diagnosable.
          dropped++;
        }
      }
    }
  } finally {
    reader.releaseLock();
    if (dropped > 0) {
      appendLog({
        level: "warn",
        source: "engine",
        message: `Dropped ${dropped} malformed SSE line(s) from model stream${model ? ` (${model})` : ""}`,
        model,
      });
    }
  }
}

/**
 * On the external API, reasoning models (e.g. deepseek-reasoner) spend
 * max_tokens on hidden chain-of-thought BEFORE the visible answer, so the
 * tight per-call caps used for chat models (reviewer: ~corrections×50+512)
 * truncate the answer mid-line or return it empty. Give such models CoT
 * headroom on top of the requested visible-output cap, within DeepSeek's
 * 65536 output-token limit.
 */
export function apiMaxTokens(requested: number, apiModelName: string): number {
  if (!/reason|think|\br1\b/i.test(apiModelName)) return requested;
  return Math.min(65536, requested + 32768);
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

  // ── Route: external API model (e.g. DeepSeek) ──
  if (model.startsWith("custom:") && !model.startsWith("custom:gguf")) {
    const apiConfig = readApiConfig();
    if (!apiConfig?.apiKey) {
      throw new Error(
        "External Betty API key not configured. Go to Settings to add your API key.",
      );
    }

    const baseUrl = process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com";
    const apiModel = apiConfig.model || "deepseek-chat";
    const apiBody: Record<string, unknown> = {
      model: apiModel,
      messages,
      stream: true,
      temperature: options.temperature ?? cfg.temperature,
      top_p: options.top_p ?? cfg.top_p,
      max_tokens: apiMaxTokens(options.max_tokens ?? cfg.num_predict, apiModel),
    };
    if (options.top_k != null) apiBody.top_k = options.top_k ?? cfg.top_k;
    if (options.repeat_penalty != null) {
      apiBody.frequency_penalty =
        (options.repeat_penalty ?? cfg.repeat_penalty) - 1.0;
    }

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiConfig.apiKey}`,
      },
      body: JSON.stringify(apiBody),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`DeepSeek API error ${res.status}: ${text}`);
    }

    yield* parseSSE(res, signal, model);
    return;
  }

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

  yield* parseSSE(res, signal, model);
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

/**
 * Compute a max_tokens value that fits inside the llama-server slot context
 * budget. Each slot must hold (system + user prompt) + generated tokens
 * simultaneously; if max_tokens leaves no room, decode aborts mid-stream
 * with "Context size has been exceeded." Estimate prompt tokens via the shared
 * CHARS_PER_TOKEN ratio and reserve 256 tokens for chat-template/role overhead.
 */
function slotSafeMaxTokens(
  model: string,
  systemMsg: string,
  userText: string,
  requestedCap: number,
): number {
  const cfg = getActiveConfig(model);
  const promptTokenEst = estimateTokens(systemMsg + userText);
  const slotBudget = cfg.num_ctx - promptTokenEst - 256;
  return Math.max(256, Math.min(requestedCap, slotBudget));
}

/** Streaming edit — yields tokens as the model produces them. */
export async function* editChunkStream(
  model: string,
  chunkText: string,
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const cfg = getActiveConfig(model);
  const systemMsg = buildSystemMessage(model, systemPrompt);
  const cap = slotSafeMaxTokens(model, systemMsg, chunkText, cfg.num_predict);
  yield* chatStream(
    model,
    [
      { role: "system", content: systemMsg },
      { role: "user", content: chunkText },
    ],
    { max_tokens: cap },
    signal,
  );
}

/** Streaming corrections-mode call — yields raw JSON tokens. */
export async function* findCorrectionsStream(
  model: string,
  chunkText: string,
  systemPrompt: string,
  signal?: AbortSignal,
  maxTokensOverride?: number,
): AsyncGenerator<string> {
  const cfg = getActiveConfig(model);
  // The corrections JSON is usually smaller than the chunk it describes,
  // but dense dialect/error text can produce many overlapping entries that
  // balloon the response (each correction object is ~30-50 tokens). Cap at
  // 2× the input estimate + 512, and never exceed the model's num_predict.
  const estInputTokens = Math.ceil(chunkText.length / 3);
  const defaultCap = Math.min(
    cfg.num_predict,
    Math.ceil(estInputTokens * 2) + 512,
  );
  const requestedCap = maxTokensOverride
    ? Math.min(cfg.num_predict, maxTokensOverride)
    : defaultCap;
  const systemMsg = buildSystemMessage(model, systemPrompt);
  const cap = slotSafeMaxTokens(model, systemMsg, chunkText, requestedCap);
  yield* chatStream(
    model,
    [
      { role: "system", content: systemMsg },
      { role: "user", content: chunkText },
    ],
    {
      // NOTE: no response_format here — corrections are emitted as JSONL
      // (one JSON object per line), not as a single JSON object. Forcing
      // `json_object` would fight the prompt and re-introduce truncation
      // problems on long responses.
      max_tokens: cap,
    },
    signal,
  );
}

/** Streaming analysis call — collects JSON output for catalog/timeline modes.
 *  `numCtxOverride` requests a larger context window for this single call
 *  (story-read passes: chapter text + entity registry can exceed a local
 *  model's default context). */
export async function* analyzeStream(
  model: string,
  text: string,
  systemPrompt: string,
  signal?: AbortSignal,
  numCtxOverride?: number,
): AsyncGenerator<string> {
  const systemMsg = buildSystemMessage(model, systemPrompt);
  const cap = numCtxOverride
    ? Math.max(
        256,
        Math.min(4096, numCtxOverride - estimateTokens(systemMsg + text) - 256),
      )
    : slotSafeMaxTokens(model, systemMsg, text, 4096);
  yield* chatStream(
    model,
    [
      { role: "system", content: systemMsg },
      { role: "user", content: text },
    ],
    {
      max_tokens: cap,
      response_format: { type: "json_object" },
      numCtxOverride,
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
 * Parse the model's JSONL output into a list of corrections.
 *
 * Expected format: one `{"original": "...", "corrected": "..."}` per line.
 * Truncation simply drops the final partial line — no full-response loss.
 *
 * Tolerates: stray `<think>` blocks, leading/trailing code fences,
 * commentary lines between objects, missing newline between `}{` pairs,
 * and (as a back-compat fallback) the legacy `{"corrections":[...]}` shape.
 */
export function parseCorrectionsJson(raw: string): Correction[] {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  text = text.replace(/```(?:jsonl?|ndjson)?/gi, "").replace(/```/g, "");

  // Split on newlines, and also on `}{` joins in case the model forgot the
  // newline. Then drop anything that doesn't look like a complete JSON object.
  const lines = text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=\})\s*(?=\{)/));

  const cleaned: Correction[] = [];
  for (const line of lines) {
    const s = line.trim().replace(/^[,\s]+|[,\s]+$/g, "");
    if (!s || !s.startsWith("{") || !s.endsWith("}")) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      // Retry after sanitizing invalid escape sequences
      try {
        obj = JSON.parse(sanitizeJsonEscapes(s));
      } catch {
        continue;
      }
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const original = rec.original;
    const corrected = rec.corrected;
    if (
      typeof original === "string" &&
      typeof corrected === "string" &&
      original
    ) {
      const normalized = normalizeMarkdownMarkers(original, corrected);
      if (normalized === null) continue; // unrecoverable marker mismatch
      if (normalized === original) continue; // no-op after stripping spurious markup
      cleaned.push({ original, corrected: normalized });
    }
  }

  // Back-compat: legacy `{"corrections":[...]}` shape from older prompts or
  // non-llama models. Only attempt if JSONL parse yielded nothing.
  if (cleaned.length === 0 && /"corrections"\s*:\s*\[/.test(raw)) {
    return parseCorrectionsArrayLegacy(raw);
  }

  // Final fallback: regex-extract individual objects from malformed text.
  if (cleaned.length === 0 && /"original"\s*:/.test(raw)) {
    return extractCorrectionsRegex(raw);
  }

  return cleaned;
}

/** Legacy parser for the old `{"corrections":[...]}` envelope. */
function parseCorrectionsArrayLegacy(raw: string): Correction[] {
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

  let data: Record<string, unknown> | null = null;
  try {
    data = JSON.parse(text);
  } catch {
    try {
      data = JSON.parse(sanitizeJsonEscapes(text));
    } catch {
      const repaired = repairTruncatedJson(text);
      try {
        data = JSON.parse(repaired);
      } catch {
        try {
          data = JSON.parse(sanitizeJsonEscapes(repaired));
        } catch {
          return extractCorrectionsRegex(raw);
        }
      }
    }
  }

  const corrections = Array.isArray(data!.corrections) ? data!.corrections : [];
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
      const normalized = normalizeMarkdownMarkers(original, corrected);
      if (normalized === null) continue;
      if (normalized === original) continue;
      cleaned.push({ original, corrected: normalized });
    }
  }
  return cleaned;
}

/**
 * Models sometimes wrap the changed word in `**…**` (or `*…*`, `_…_`, `` `…` ``)
 * purely as a visual diff highlight — but the `corrected` string is spliced
 * verbatim into the manuscript, so this introduces unintended bold/italic.
 *
 * Strategy: if `corrected` has MORE emphasis markers than `original`, peel off
 * paired wrappers that aren't in `original`. If counts can be made to match,
 * return the cleaned string. Otherwise return null (reject the correction —
 * we can't tell what the model meant).
 */
function normalizeMarkdownMarkers(
  original: string,
  corrected: string,
): string | null {
  const markers = ["*", "_", "`"] as const;
  let out = corrected;

  // Models sometimes markdown-escape markers in their output (`\_s\_`). When
  // the original contains no backslashes, those escapes are model noise —
  // strip them, or the literal backslashes splice into the manuscript (the
  // marker counts below treat `\_` and `_` identically, so they'd pass).
  if (!original.includes("\\") && /\\[_*`]/.test(out)) {
    out = out.replace(/\\([_*`])/g, "$1");
  }

  // Iteratively peel off wrappers that add markers not present in the original.
  // Order matters: strip `**…**` before `*…*` so we don't half-strip bold.
  const peelers: { re: RegExp; ch: string }[] = [
    { re: /\*\*([^*\n]+?)\*\*/g, ch: "*" },
    { re: /__([^_\n]+?)__/g, ch: "_" },
    { re: /\*([^*\n]+?)\*/g, ch: "*" },
    { re: /_([^_\n]+?)_/g, ch: "_" },
    { re: /`([^`\n]+?)`/g, ch: "`" },
  ];

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const { re, ch } of peelers) {
      if (countChar(out, ch) <= countChar(original, ch)) continue;
      const next = out.replace(re, (match, inner) => {
        // Only strip this wrapper if doing so brings us closer to (or matches)
        // the original's marker count for this character.
        if (countChar(out, ch) > countChar(original, ch)) {
          return inner;
        }
        return match;
      });
      if (next !== out) {
        out = next;
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const ch of markers) {
    if (countChar(out, ch) !== countChar(original, ch)) return null;
  }
  return out;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++;
  return n;
}

/**
 * Best-effort repair of JSON truncated by a token-limit. Strips a trailing
 * partial object and closes any open `[`/`{`.
 */
function repairTruncatedJson(text: string): string {
  let s = text.trim();
  // Remove an in-progress incomplete object at the tail: cut back to the
  // last complete `}` inside an array.
  const lastCompleteObj = s.lastIndexOf("}");
  if (lastCompleteObj !== -1) {
    s = s.slice(0, lastCompleteObj + 1);
  }
  // Walk and balance brackets, ignoring those inside strings.
  let depthBrace = 0;
  let depthBracket = 0;
  let inString = false;
  let escape = false;
  for (const ch of s) {
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depthBrace++;
    else if (ch === "}") depthBrace--;
    else if (ch === "[") depthBracket++;
    else if (ch === "]") depthBracket--;
  }
  // Drop trailing comma if present
  s = s.replace(/,\s*$/, "");
  // Close any open brackets/braces in the right order
  while (depthBracket > 0) {
    s += "]";
    depthBracket--;
  }
  while (depthBrace > 0) {
    s += "}";
    depthBrace--;
  }
  return s;
}

/**
 * Sanitize invalid JSON escape sequences that LLMs sometimes produce.
 * Replaces non-standard escapes (e.g. \a, \x, \') with their literal character,
 * preserving valid JSON escapes (\" \\ \/ \b \f \n \r \t \uXXXX).
 */
function sanitizeJsonEscapes(s: string): string {
  // Replace invalid \X sequences with just X (the literal character),
  // but preserve valid JSON escapes.
  return s.replace(/\\(.)/g, (match, ch: string) => {
    switch (ch) {
      case '"':
      case "\\":
      case "/":
      case "b":
      case "f":
      case "n":
      case "r":
      case "t":
        return match; // valid escape — keep as-is
      case "u":
        return match; // \uXXXX — keep as-is (the digits follow)
      default:
        return ch; // invalid escape — drop the backslash
    }
  });
}

/**
 * Last-resort extraction: scan for `{"original": "...", "corrected": "..."}`
 * patterns even when the surrounding JSON is malformed.
 */
function extractCorrectionsRegex(raw: string): Correction[] {
  const out: Correction[] = [];
  // Match {"original": "...", "corrected": "..."} allowing escaped quotes and
  // whitespace/newlines between fields. The .*? for values must handle
  // escaped quotes via a non-greedy pattern that tolerates \" inside.
  const re =
    /\{\s*"original"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"corrected"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    try {
      let original: string;
      let corrected: string;
      try {
        original = JSON.parse(`"${m[1]}"`);
        corrected = JSON.parse(`"${m[2]}"`);
      } catch {
        // Sanitize invalid escapes and retry
        original = JSON.parse(`"${sanitizeJsonEscapes(m[1])}"`);
        corrected = JSON.parse(`"${sanitizeJsonEscapes(m[2])}"`);
      }
      if (typeof original === "string" && original) {
        const normalized = normalizeMarkdownMarkers(original, corrected);
        if (normalized === null || normalized === original) continue;
        out.push({ original, corrected: normalized });
      }
    } catch {
      // Skip entries that can't be parsed even after sanitization
      continue;
    }
  }
  return out;
}

// ── Reviewer — second-pass critical review of editor corrections ──

function buildReviewerUserMessage(
  chunkText: string,
  corrections: Correction[],
): string {
  let msg = "ORIGINAL TEXT:\n" + chunkText + "\n\nPROPOSED CORRECTIONS:\n";
  corrections.forEach((c, i) => {
    msg += `[${i}] "${c.original}" → "${c.corrected}"\n`;
  });
  return msg;
}

interface ReviewScore {
  confidence: number;
  reason: string;
}

export function parseReviewScores(raw: string): Map<number, ReviewScore> {
  const scores = new Map<number, ReviewScore>();
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  text = text.replace(/```(?:jsonl?|ndjson)?/gi, "").replace(/```/g, "");

  const lines = text
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?<=\})\s*(?=\{)/));

  for (const line of lines) {
    const s = line.trim().replace(/^[,\s]+|[,\s]+$/g, "");
    if (!s || !s.startsWith("{") || !s.endsWith("}")) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      try {
        obj = JSON.parse(sanitizeJsonEscapes(s));
      } catch {
        continue;
      }
    }
    if (typeof obj !== "object" || obj === null) continue;
    const rec = obj as Record<string, unknown>;
    const index = rec.index;
    const confidence = rec.confidence;
    const reason = rec.reason;
    if (
      typeof index === "number" &&
      typeof confidence === "number" &&
      confidence >= 1 &&
      confidence <= 5 &&
      typeof reason === "string"
    ) {
      scores.set(index, { confidence, reason });
    }
  }

  return scores;
}

/**
 * Simple one-shot LLM call for character identity resolution.
 * Collects the full (non-streamed) response and returns the trimmed text.
 */
export async function* reviewCorrectionsStream(
  model: string,
  chunkText: string,
  corrections: Correction[],
  systemPrompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const systemMsg = buildSystemMessage(model, systemPrompt);
  const userMsg = buildReviewerUserMessage(chunkText, corrections);
  const cap = slotSafeMaxTokens(
    model,
    systemMsg,
    userMsg,
    Math.max(256, corrections.length * 50 + 512),
  );
  yield* chatStream(
    model,
    [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
    { max_tokens: cap },
    signal,
  );
}

/**
 * Restore the original text's typographic conventions in an LLM-rewritten
 * output. Detects what the original uses (curly vs straight quotes, ellipsis
 * char vs dots, dash styles) and converts the output to match.
 *
 * This prevents the LLM from silently normalizing quotes/dashes in rewrite mode.
 */
export function restoreTypography(original: string, output: string): string {
  let result = output;

  // --- Double quotes ---
  const origCurlyDq = (original.match(/[\u201C\u201D]/g) ?? []).length;
  const origStraightDq = (original.match(/"/g) ?? []).length;
  const outCurlyDq = (result.match(/[\u201C\u201D]/g) ?? []).length;
  const outStraightDq = (result.match(/"/g) ?? []).length;

  if (origCurlyDq > origStraightDq && outStraightDq > outCurlyDq) {
    // Original uses curly, output switched to straight → convert back to curly
    result = smartenDoubleQuotes(result);
  } else if (origStraightDq > origCurlyDq && outCurlyDq > outStraightDq) {
    // Original uses straight, output switched to curly → convert back to straight
    result = result.replace(/[\u201C\u201D]/g, '"');
  }

  // --- Single quotes / apostrophes ---
  const origCurlySq = (original.match(/[\u2018\u2019]/g) ?? []).length;
  const origStraightSq = (original.match(/'/g) ?? []).length;
  const outCurlySq = (result.match(/[\u2018\u2019]/g) ?? []).length;
  const outStraightSq = (result.match(/'/g) ?? []).length;

  if (origCurlySq > origStraightSq && outStraightSq > outCurlySq) {
    // Original uses curly, output switched to straight → convert back
    result = smartenSingleQuotes(result);
  } else if (origStraightSq > origCurlySq && outCurlySq > outStraightSq) {
    // Original uses straight, output switched to curly → convert back
    result = result.replace(/[\u2018\u2019]/g, "'");
  }

  // --- Ellipsis ---
  const origEllipsis = (original.match(/\u2026/g) ?? []).length;
  const origDots = (original.match(/\.\.\./g) ?? []).length;
  const outEllipsis = (result.match(/\u2026/g) ?? []).length;
  const outDots = (result.match(/\.\.\./g) ?? []).length;

  if (origEllipsis > origDots && outDots > outEllipsis) {
    result = result.replace(/\.\.\./g, "\u2026");
  } else if (origDots > origEllipsis && outEllipsis > outDots) {
    result = result.replace(/\u2026/g, "...");
  }

  return result;
}

/** Convert straight double quotes to curly (context-aware open/close). */
function smartenDoubleQuotes(s: string): string {
  let open = true;
  return s.replace(/"/g, () => {
    const q = open ? "\u201C" : "\u201D";
    open = !open;
    return q;
  });
}

/** Convert straight single quotes to curly (heuristic: open after space/start). */
function smartenSingleQuotes(s: string): string {
  // After whitespace or start-of-string → opening quote; otherwise → closing/apostrophe
  return s.replace(/'/g, (_, offset) => {
    if (offset === 0) return "\u2018";
    const prev = s[offset - 1];
    if (/[\s(\[{]/.test(prev)) return "\u2018";
    return "\u2019";
  });
}

// Markdown markers a correction must not alter. The `locked` flag marks the
// inline emphasis/code markers whose count is fixed BOTH ways — a correction
// may neither strip nor add them (the prompt contract: their count in
// "corrected" must equal "original"). Adding them is how stray `okay_?_` /
// `him_._` artifacts sneak in. The structural markers (heading/list/blockquote/
// bracket) are removal-only, so a rewrite may legitimately introduce one.
const MARKDOWN_MARKER_PATTERNS: [string, RegExp, boolean][] = [
  ["triple-asterisk", /\*\*\*/g, true],
  ["double-asterisk (bold)", /\*\*/g, true],
  ["single-asterisk (italic)", /(?<!\*)\*(?!\*)/g, true],
  ["double-underscore (bold)", /__/g, true],
  ["single-underscore (italic)", /(?<!_)_(?!_)/g, true],
  ["backtick (code)", /`/g, true],
  ["heading marker (#)", /(?:^|\n)\s*#{1,6}\s/g, false],
  ["blockquote (>)", /(?:^|\n)\s*>/g, false],
  ["list marker", /(?:^|\n)\s*(?:[-*+]|\d+\.)\s/g, false],
  ["link/image bracket", /[\[\]]/g, false],
];

function countMatches(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  return (text.match(pattern) ?? []).length;
}

/**
 * Normalize typographic characters to their ASCII equivalents for comparison.
 * Used to detect corrections that only change quote/apostrophe/ellipsis style.
 */
function normalizeTypography(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u2039\u203A]/g, "'") // curly single quotes → straight
    .replace(/[\u201C\u201D\u201E\u00AB\u00BB]/g, '"') // curly double quotes → straight
    .replace(/\u2026/g, "...") // ellipsis char → three dots
    .replace(/\u2014/g, "--") // em dash → double hyphen
    .replace(/\u2013/g, "-"); // en dash → hyphen
}

/**
 * Returns true if the only difference between original and corrected is
 * typographic style (curly vs straight quotes/apostrophes, ellipsis char, dashes).
 */
function isTypographyOnlyChange(original: string, corrected: string): boolean {
  return normalizeTypography(original) === normalizeTypography(corrected);
}

/**
 * Returns true if the original already contains quote marks and the only
 * change is swapping one quote style for another (e.g. double → single).
 * Adding quotes where none existed or fixing misplaced quotes passes through.
 */
const QUOTE_CHARS_RE =
  /['\u2018\u2019\u201A\u2039\u203A"\u201C\u201D\u201E\u00AB\u00BB]/g;
function isQuoteStyleChange(original: string, corrected: string): boolean {
  const orgHasQuote = QUOTE_CHARS_RE.test(original);
  if (!orgHasQuote) return false;
  const orgStripped = original.replace(QUOTE_CHARS_RE, "");
  const corrStripped = corrected.replace(QUOTE_CHARS_RE, "");
  return orgStripped === corrStripped && original !== corrected;
}

/**
 * Returns true if the corrected text introduces doubled punctuation the
 * original didn't have (e.g. "..", "\"\"", ",,"). Excludes valid ellipsis.
 */
function hasDoublePunctuation(original: string, corrected: string): boolean {
  const dupRe = /([.!?,;:'")\]}])\1/;
  // A period jammed against another sentence-punctuation mark (".,", ",.",
  // "..", ".;", ".?", …) is a splice/duplication artifact, never a valid edit.
  // Only flag when `corrected` introduces it and `original` didn't (so the
  // author's own "etc.," stays untouched).
  const dotAdjRe = /\.[.,;:!?]|[.,;:!?]\./;
  return (
    (!dupRe.test(original) && dupRe.test(corrected)) ||
    (!dotAdjRe.test(original) && dotAdjRe.test(corrected))
  );
}

/**
 * Trim edge punctuation from `corrected` that duplicates the mark already
 * adjacent to the located span in `text`. The model regularly emits an
 * `original` snippet that stops just short of the sentence-final mark while
 * `corrected` includes it ("…from his shoulder" → "…from his shoulder.");
 * splicing that before the manuscript's own period yields "shoulder..".
 * The manuscript's mark stays, so an adjacent ellipsis is never extended.
 */
const SEAM_PUNCT_RE = /[.,;:!?]/;
function absorbSeamPunctuation(
  text: string,
  pos: number,
  original: string,
  corrected: string,
): string {
  // Strip an introduced edge mark that duplicates the adjacent manuscript mark
  // ("shoulder"→"shoulder." before an existing "." → ".."). Also strip an
  // introduced trailing/leading PERIOD jammed against any adjacent sentence
  // punctuation ("home"→"home." before an existing "," → ".,"), which is never
  // valid.
  const last = corrected[corrected.length - 1] ?? "";
  const nextCh = text[pos + original.length] ?? "";
  if (
    SEAM_PUNCT_RE.test(last) &&
    !original.endsWith(last) &&
    (nextCh === last || (last === "." && SEAM_PUNCT_RE.test(nextCh)))
  ) {
    corrected = corrected.slice(0, -1);
  }
  const first = corrected[0] ?? "";
  const prevCh = pos > 0 ? text[pos - 1] : "";
  if (
    SEAM_PUNCT_RE.test(first) &&
    !original.startsWith(first) &&
    pos > 0 &&
    (prevCh === first || (first === "." && SEAM_PUNCT_RE.test(prevCh)))
  ) {
    corrected = corrected.slice(1);
  }
  return corrected;
}

/**
 * Re-attach terminal punctuation a correction strips from a paragraph-final
 * sentence. The model occasionally decides a paragraph's closing period is
 * "unnecessary" ("…a forced smile." → "…a forced smile") and reviewers wave
 * it through — but a prose paragraph never ends on a bare word. Rewrites that
 * end in other punctuation ("and—." → "and—", "home." → "home:") pass
 * untouched, as do mid-paragraph edits.
 */
const TERMINAL_END_RE = /[.!?…]$/;
const WORD_END_RE = /[\p{L}\p{N}]$/u;
function restoreParagraphEndPunctuation(
  text: string,
  pos: number,
  original: string,
  corrected: string,
): string {
  if (!TERMINAL_END_RE.test(original) || !WORD_END_RE.test(corrected)) {
    return corrected;
  }
  const after = text[pos + original.length];
  if (after === undefined || after === "\n" || after === "\r") {
    return corrected + original[original.length - 1];
  }
  return corrected;
}

/**
 * Detect if a correction only changes dialogue tag punctuation/casing.
 * Patterns: period→comma before tag, capital→lowercase on tag verb, etc.
 * e.g. `"Hello." She said` → `"Hello," she said`
 */
function isDialogueTagChange(original: string, corrected: string): boolean {
  // If the non-dialogue-related text is the same, it's a dialogue tag edit.
  // Normalize: replace the punctuation-before-closing-quote + next word casing
  const dialogueTagRe = /([.!?])([""\u201C\u201D''\u2018\u2019])\s+([A-Z])/g;
  const normDialogue = (s: string) =>
    s.replace(dialogueTagRe, (_, _p, q, ch) => `,${q} ${ch.toLowerCase()}`);
  return (
    normDialogue(original) === normDialogue(corrected) && original !== corrected
  );
}

function markdownMarkerViolation(
  original: string,
  corrected: string,
): string | null {
  for (const [label, pattern, locked] of MARKDOWN_MARKER_PATTERNS) {
    const beforeCount = countMatches(original, pattern);
    const afterCount = countMatches(corrected, pattern);
    if (afterCount < beforeCount) {
      return `removed ${beforeCount - afterCount}× ${label}`;
    }
    // Inline emphasis/code markers are count-locked both ways: a correction
    // that injects them (e.g. "okay?" → "okay_?_") is an artifact, not an edit.
    if (locked && afterCount > beforeCount) {
      return `added ${afterCount - beforeCount}× ${label}`;
    }
  }
  return null;
}

export interface ApplyCorrectionsOptions {
  /** Whether dialogue-tag corrections are allowed (matches CopyEditOptions.dialogueTags). */
  allowDialogueTags?: boolean;
  /**
   * Optional spell validator (from spellcheck.getWordValidator). When provided,
   * any correction whose `corrected` text introduces a word this predicate
   * rejects — and which wasn't already an unaccepted word in `original` — is
   * skipped. This stops the editor from turning a correctly-spelled word into a
   * brand-new non-word (e.g. "Apparently" → "Appwrently").
   */
  isAcceptableWord?: (word: string) => boolean;
}

/**
 * Word tokens for spell-vetting — matches spellcheck.ts WORD_RE (2+ letters).
 * Includes typographic apostrophes (’ ʼ) so a corrupted contraction like
 * "did’t" is vetted as one token instead of dissolving into "did" + "t";
 * the validator normalizes apostrophes before its dictionary lookup.
 */
const WORD_TOKEN_RE = /\p{L}[\p{L}'’ʼ-]*[\p{L}]/gu;

/**
 * Returns the first word `corrected` introduces that `isAcceptable` rejects and
 * that wasn't already an unaccepted word in `original`, or null if none. Used to
 * reject corrections that would inject a new misspelled non-word.
 */
function introducedBadWord(
  original: string,
  corrected: string,
  isAcceptable: (word: string) => boolean,
): string | null {
  const tokensOf = (s: string): string[] => s.match(WORD_TOKEN_RE) ?? [];
  const origBad = new Set(
    tokensOf(original).filter((w) => !isAcceptable(w)),
  );
  for (const w of tokensOf(corrected)) {
    if (!isAcceptable(w) && !origBad.has(w)) return w;
  }
  return null;
}

/**
 * True when a correction is a single-word → single-word substitution where both
 * sides are valid dictionary words (e.g. "form" → "from", "their" → "there").
 * The spell gate can't catch these (both are real words), yet they may be a
 * silent corruption rather than an intended fix — callers can route them to
 * review instead of applying them blindly.
 */
export function isRealWordSwap(
  original: string,
  corrected: string,
  isAcceptable: (word: string) => boolean,
): boolean {
  const a = original.match(WORD_TOKEN_RE) ?? [];
  const b = corrected.match(WORD_TOKEN_RE) ?? [];
  if (a.length !== 1 || b.length !== 1 || a[0] === b[0]) return false;
  return isAcceptable(a[0]) && isAcceptable(b[0]);
}

// Characters that continue a word (letters, digits, apostrophes, hyphens).
// Used for word-boundary checks so a single-word correction can't be matched
// inside a larger word (e.g. "from" must not match within "formal").
const WORD_CHAR_RE = /[\p{L}\p{N}'’-]/u;
function isWordChar(ch: string): boolean {
  return ch !== "" && WORD_CHAR_RE.test(ch);
}

// A letter/digit at a match edge must not butt against a word character in
// the surrounding text. This generalizes whole-word matching to multi-word
// needles: "the student" must not match inside "the students, soldiers" —
// that splice produced "the studentss" on export. Edges that are themselves
// punctuation (quotes, apostrophes, dashes) carry no boundary requirement.
const EDGE_ALNUM_RE = /[\p{L}\p{N}]/u;
function hasCleanWordEdges(text: string, pos: number, match: string): boolean {
  if (match.length === 0) return false;
  if (EDGE_ALNUM_RE.test(match[0]) && pos > 0 && isWordChar(text[pos - 1])) {
    return false;
  }
  const afterIdx = pos + match.length;
  if (
    EDGE_ALNUM_RE.test(match[match.length - 1]) &&
    afterIdx < text.length &&
    isWordChar(text[afterIdx])
  ) {
    return false;
  }
  return true;
}

/** All start positions of `needle` in `text` whose word edges are clean. */
function findOccurrences(text: string, needle: string): number[] {
  const out: number[] = [];
  let pos = text.indexOf(needle);
  while (pos !== -1) {
    if (hasCleanWordEdges(text, pos, needle)) out.push(pos);
    pos = text.indexOf(needle, pos + 1);
  }
  return out;
}

// Capitalized token ending in a lowercase letter (a likely proper noun).
const PROPER_NOUN_RE = /[A-Z\p{Lu}][\p{Ll}'’-]*\p{Ll}/gu;

/**
 * Returns the first proper-noun-like token `original` contains that the
 * correction alters or drops, or null if none. A capitalized token whose
 * lowercased form is NOT an acceptable dictionary word is treated as a name
 * (this lets ordinary sentence-initial words like "Apparently" through, since
 * "apparently" is a real word, while protecting "Aaron").
 */
function altersProperNoun(
  original: string,
  corrected: string,
  isAcceptable: (word: string) => boolean,
): string | null {
  const correctedTokens = new Set(corrected.match(WORD_TOKEN_RE) ?? []);
  for (const token of original.match(PROPER_NOUN_RE) ?? []) {
    if (isAcceptable(token.toLowerCase())) continue; // ordinary capitalized word
    if (!correctedTokens.has(token)) return token; // name altered or dropped
  }
  return null;
}

/** Result of a fuzzy text search. */
interface FuzzyMatch {
  pos: number;
  /** The actual matching substring from the text. */
  match: string;
}

/**
 * Try to find `needle` in `text` with flexible whitespace AND typographic
 * character variants (curly/straight quotes, em/en dashes, ellipsis).
 *
 * The LLM sometimes returns "original" text with slightly different
 * characters than the raw chunk (e.g. straight apostrophes when the chunk
 * has curly ones).  This function builds a regex that matches all common
 * typographic equivalents so those corrections aren't lost.
 *
 * Returns null when there is not exactly one match.
 */
function fuzzyFind(text: string, needle: string): FuzzyMatch | null {
  // Collapse whitespace first so we don't emit redundant \s+
  const collapsed = needle.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;

  // Build a regex character-by-character, replacing:
  //  - literal spaces → \s+
  //  - typographic chars → equivalence class
  //  - everything else → regex-escaped literal
  let pattern = "";
  for (let i = 0; i < collapsed.length; i++) {
    const ch = collapsed[i];

    if (ch === " ") {
      pattern += "\\s+";
    } else if (
      ch === "." &&
      collapsed[i + 1] === "." &&
      collapsed[i + 2] === "."
    ) {
      // Ellipsis: match three dots or the ellipsis character
      pattern += "(?:\\.\\.\\.|\\u2026)";
      i += 2;
    } else {
      pattern += typographicClass(ch);
    }
  }

  try {
    const re = new RegExp(pattern, "g");
    const first = re.exec(text);
    if (!first) return null;
    return { pos: first.index, match: first[0] };
  } catch {
    return null; // malformed regex (shouldn't happen)
  }
}

/** Return a regex character class that matches `ch` and its typographic equivalents. */
function typographicClass(ch: string): string {
  // Single quotes / apostrophes
  if (/['\u2018\u2019\u201A\u2039\u203A]/.test(ch)) {
    return "['\u2018\u2019\u201A\u2039\u203A]";
  }
  // Double quotes
  if (/["\u201C\u201D\u201E\u00AB\u00BB]/.test(ch)) {
    return '["\u201C\u201D\u201E\u00AB\u00BB]';
  }
  // Dashes (hyphen, en-dash, em-dash)
  if (/[-\u2013\u2014]/.test(ch)) {
    return "[-\u2013\u2014]";
  }
  // Escape everything else for regex
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply a list of corrections to text using a two-pass strategy:
 *
 *  **Pass 1** — validate every correction and locate it in the **original**
 *  text (before any mutation).  Corrections that cannot be found exactly get
 *  a fuzzy-whitespace fallback.
 *
 *  **Pass 2** — sort the located corrections by position descending and apply
 *  them from end to start.  Because we work against the original positions,
 *  earlier corrections cannot invalidate the search for later ones — the
 *  cascading-mutation problem is eliminated.
 *
 * Returns [newText, applied, skipped].
 */
export function applyCorrections(
  text: string,
  corrections: Correction[],
  opts?: ApplyCorrectionsOptions,
): [string, Correction[], Correction[]] {
  const skipped: Correction[] = [];

  // ── Pass 1: validate & locate in ORIGINAL text ──
  interface Located {
    pos: number;
    original: string; // the exact substring to replace (may differ from c.original when fuzzy)
    corrected: string;
    correction: Correction;
  }
  const located: Located[] = [];

  for (const c of corrections) {
    // ── Rejection gates (unchanged) ──
    if (c.original === c.corrected) {
      skipped.push({ ...c, reason: "no-op" });
      continue;
    }
    if (isTypographyOnlyChange(c.original, c.corrected)) {
      skipped.push({
        ...c,
        reason: "typography-only change (quote/dash style)",
      });
      continue;
    }
    if (isQuoteStyleChange(c.original, c.corrected)) {
      skipped.push({
        ...c,
        reason: "quote style change (e.g. double → single)",
      });
      continue;
    }
    if (hasDoublePunctuation(c.original, c.corrected)) {
      skipped.push({
        ...c,
        reason: "introduces doubled or misplaced punctuation (e.g. '..' or '.,')",
      });
      continue;
    }
    if (
      !opts?.allowDialogueTags &&
      isDialogueTagChange(c.original, c.corrected)
    ) {
      skipped.push({ ...c, reason: "dialogue tag change (not selected)" });
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
    if (opts?.isAcceptableWord) {
      const badWord = introducedBadWord(
        c.original,
        c.corrected,
        opts.isAcceptableWord,
      );
      if (badWord) {
        skipped.push({
          ...c,
          reason: `introduces misspelled word: ${badWord}`,
        });
        continue;
      }
      const name = altersProperNoun(
        c.original,
        c.corrected,
        opts.isAcceptableWord,
      );
      if (name) {
        skipped.push({ ...c, reason: `alters proper noun: ${name}` });
        continue;
      }
    }

    // ── Locate in the ORIGINAL text ──
    // Matching is edge-boundary-checked: a fix like "from" can't be spliced
    // inside an unrelated word ("formal"), and a multi-word original like
    // "the student" can't match the prefix of "the students".
    const positions = findOccurrences(text, c.original);
    if (positions.length > 0) {
      // Apply the same correction at every (boundary-checked) occurrence.
      for (const pos of positions) {
        located.push({
          pos,
          original: c.original,
          corrected: restoreParagraphEndPunctuation(
            text,
            pos,
            c.original,
            absorbSeamPunctuation(text, pos, c.original, c.corrected),
          ),
          correction: c,
        });
      }
    } else {
      // Approach 3: fuzzy whitespace-flexible fallback
      const fuzzy = fuzzyFind(text, c.original);
      if (fuzzy && hasCleanWordEdges(text, fuzzy.pos, fuzzy.match)) {
        // The replaced span is fuzzy.match, not c.original — re-check the
        // marker guard against what is actually spliced out, so a match that
        // swallowed surrounding *italic*/_underscore_ markers is rejected
        // instead of silently deleting them.
        const fuzzyIssue = markdownMarkerViolation(fuzzy.match, c.corrected);
        if (fuzzyIssue) {
          skipped.push({ ...c, reason: `would alter markdown: ${fuzzyIssue}` });
          continue;
        }
        located.push({
          pos: fuzzy.pos,
          original: fuzzy.match,
          corrected: restoreParagraphEndPunctuation(
            text,
            fuzzy.pos,
            fuzzy.match,
            absorbSeamPunctuation(text, fuzzy.pos, fuzzy.match, c.corrected),
          ),
          correction: c,
        });
      } else {
        skipped.push({ ...c, reason: "not found" });
      }
    }
  }

  // ── Pass 2a: resolve overlapping spans — the larger edit wins ──
  // A sentence rewrite and a word fix inside it would otherwise splice
  // end→start: the inner fix mutates the sentence first and the rewrite is
  // skipped. The larger edit carries the contained change (ingestion folds
  // it in via foldContainedCorrections), so it takes precedence. Rival
  // rewrites of the same span keep the first-listed version.
  const byLength = [...located].sort(
    (a, b) => b.original.length - a.original.length,
  );
  const chosen: Located[] = [];
  const overlapSkipped = new Set<Correction>();
  for (const item of byLength) {
    const clash = chosen.find(
      (k) =>
        item.pos < k.pos + k.original.length &&
        k.pos < item.pos + item.original.length,
    );
    if (!clash) {
      chosen.push(item);
      continue;
    }
    if (overlapSkipped.has(item.correction)) continue;
    overlapSkipped.add(item.correction);
    skipped.push({
      ...item.correction,
      reason:
        clash.correction.original === item.correction.original
          ? "alternative rewrite of the same text (another version was applied)"
          : "overlaps a larger applied edit",
    });
  }

  // ── Pass 2b: apply end→start using original positions ──
  chosen.sort((a, b) => b.pos - a.pos);

  const applied: Correction[] = [];
  let newText = text;

  for (const item of chosen) {
    // Verify the text slice still matches (it always should because we
    // process end→start, but overlapping fuzzy matches can shift things).
    const slice = newText.slice(item.pos, item.pos + item.original.length);
    if (slice === item.original) {
      newText =
        newText.slice(0, item.pos) +
        item.corrected +
        newText.slice(item.pos + item.original.length);
      applied.push(item.correction);
    } else {
      // The region shifted — try a (boundary-checked) indexOf in the current text.
      const idx = findOccurrences(newText, item.original)[0] ?? -1;
      if (idx !== -1) {
        newText =
          newText.slice(0, idx) +
          item.corrected +
          newText.slice(idx + item.original.length);
        applied.push(item.correction);
      } else {
        // Check if this correction was already applied by an overlapping
        // correction (e.g. two corrections targeting the same word with
        // different amounts of context, where the longer one was applied
        // first and already covers this change).
        const sliceAtOrigPos = newText.slice(
          item.pos,
          item.pos + item.corrected.length,
        );
        if (sliceAtOrigPos === item.corrected) {
          applied.push(item.correction);
        } else {
          // Last resort: fuzzy search in the already-mutated text.
          const fuzzy = fuzzyFind(newText, item.original);
          if (fuzzy && hasCleanWordEdges(newText, fuzzy.pos, fuzzy.match)) {
            newText =
              newText.slice(0, fuzzy.pos) +
              item.corrected +
              newText.slice(fuzzy.pos + fuzzy.match.length);
            applied.push(item.correction);
          } else {
            skipped.push({
              ...item.correction,
              reason: "not found (collision with nearby edit)",
            });
          }
        }
      }
    }
  }

  return [newText, applied, skipped];
}

const MAX_REVERT_ITERATIONS = 5;

/**
 * Map each introduced suspect word to the first correction whose `corrected`
 * side contains it (case-insensitive, word-boundary; apostrophes — straight
 * and typographic — count as word characters). Suspects contained in no
 * correction are omitted: they are assembly artifacts the caller reports
 * rather than reverts. Shared by applyCorrectionsVerified and the
 * /verify-corrections export check.
 */
export function attributeSuspects<T extends { corrected: string }>(
  suspects: string[],
  corrections: T[],
): Map<T, string> {
  const wordRe = (word: string) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}'’ʼ-])${escaped}(?![\\p{L}'’ʼ-])`, "iu");
  };
  const offenders = new Map<T, string>();
  for (const word of suspects) {
    const re = wordRe(word);
    let attributed = false;
    for (const c of corrections) {
      if (re.test(c.corrected)) {
        if (!offenders.has(c)) offenders.set(c, word);
        attributed = true;
      }
    }
    if (attributed) continue;
    // Fallback for contraction splices: a multi-word correction whose
    // original ends mid-contraction ("He hadn" → "He had" applied inside
    // "He hadn’t") leaves a suspect ("had’t") whose full form appears in no
    // correction — but its apostrophe-split stem ("had") does. Segments
    // under 3 chars are skipped ("t") to avoid matching everything.
    const segments = word.split(/[’'ʼ]/).filter((s) => s.length >= 3);
    for (const seg of segments) {
      const segRe = wordRe(seg);
      for (const c of corrections) {
        if (!offenders.has(c) && segRe.test(c.corrected)) offenders.set(c, word);
      }
    }
  }
  return offenders;
}

/**
 * applyCorrections plus a post-apply safety net: if the applied result
 * contains suspect words that were absent from the input text (per the
 * injected `findNewSuspects`, normally spellcheck.findNewSuspectWords), the
 * corrections responsible are excluded and the whole set is re-applied from
 * scratch on the ORIGINAL text — reusing the battle-tested two-pass apply
 * rather than surgically undoing splices. Loops until clean (Hunspell only,
 * cheap). Reverted corrections come back flagged so the user sees what was
 * undone. Suspects attributable to no correction (overlap/fuzzy artifacts)
 * are left for the caller's chapter-level check to report.
 */
export function applyCorrectionsVerified(
  text: string,
  corrections: Correction[],
  opts?: ApplyCorrectionsOptions & {
    findNewSuspects?: (before: string, after: string) => string[] | null;
  },
): [string, Correction[], Correction[], Correction[]] {
  let active = corrections;
  const reverted: Correction[] = [];

  for (let iteration = 0; ; iteration++) {
    const [newText, applied, skipped] = applyCorrections(text, active, opts);
    if (iteration >= MAX_REVERT_ITERATIONS) {
      return [newText, applied, skipped, reverted];
    }
    const suspects = opts?.findNewSuspects?.(text, newText);
    if (!suspects || suspects.length === 0) {
      return [newText, applied, skipped, reverted];
    }

    // Attribute each introduced suspect to the applied correction(s) whose
    // `corrected` side contains it. `applied` holds references into `active`,
    // so offenders can be excluded by identity on the next iteration.
    const offenders = attributeSuspects(suspects, applied);
    if (offenders.size === 0) {
      return [newText, applied, skipped, reverted];
    }

    for (const [c, word] of offenders) {
      reverted.push({
        ...c,
        flagged: true,
        reviewReason: `applying introduced misspelling "${word}" — reverted`,
      });
    }
    active = active.filter((c) => !offenders.has(c));
  }
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
