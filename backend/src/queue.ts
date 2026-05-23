// ── In-memory task queue ──
// Single-user local app — no Redis needed.

import { v4 as uuidv4 } from "uuid";
import type { Server as SocketServer } from "socket.io";
import type { TaskState, TaskResult, TaskMode, Correction } from "./types.js";
import { ANALYSIS_MODES } from "./types.js";
import { splitIntoChunks, stripOverlapFromResponse } from "./chunking.js";
import {
  editChunkStream,
  findCorrectionsStream,
  parseCorrectionsJson,
  applyCorrections,
  analyzeStream,
  synthesizeStream,
  parseJsonResponse,
  listLoadedModels,
  unloadModel,
} from "./llm.js";
import { mergeAnalysisParts } from "./analysisMerge.js";
import { ANALYSIS_SUMMARY_PROMPT } from "./prompts.js";
import { appendLog, diagnoseTaskError } from "./logBus.js";
import { ensureModelLoaded } from "./llamaServer.js";
import {
  saveTaskState,
  loadTaskStates,
  deleteTaskState,
  deleteTaskStatesIn,
} from "./db.js";

/**
 * Force every entry in a parsed analysis result to claim it belongs to
 * `chapterName`. Models often invent chapter numbers per-chunk; this guarantees
 * downstream aggregation groups everything under the real chapter.
 */
function forceChapterLabel(parsed: unknown, chapterName: string): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const obj = parsed as Record<string, unknown>;

  const fixNamedList = (key: string) => {
    const v = obj[key];
    if (!Array.isArray(v)) return;
    for (const item of v) {
      if (item && typeof item === "object") {
        (item as Record<string, unknown>).chapters = [chapterName];
        delete (item as Record<string, unknown>).firstMention;
      }
    }
  };
  fixNamedList("characters");
  fixNamedList("locations");

  const events = obj.events;
  if (Array.isArray(events)) {
    for (const ev of events) {
      if (ev && typeof ev === "object") {
        (ev as Record<string, unknown>).chapter = chapterName;
      }
    }
  }
  return obj;
}

/**
 * Strip common AI sign-offs / preambles from a generated prose summary.
 * The model is also instructed not to produce these, but a regex safety net
 * keeps stray ones from leaking into the user's document.
 */
function stripAiSignoff(text: string): string {
  let out = text;

  // Strip leading meta-preamble lines until the first heading or content.
  out = out.replace(
    /^(?:(?:sure|certainly|of course|here(?:'s| is)|below(?:'s| is)?)[^\n]*\n+)+/i,
    "",
  );

  // Iteratively peel off trailing meta-paragraphs.
  const tailPattern =
    /\n\s*(?:[-*>]\s*)?(?:_+|\*+)?\s*(?:this (?:summary|analysis|overview|response)|i hope (?:this|that)|hope (?:this|that) helps|let me know|feel free|if you (?:have|need|want|'d)|please (?:let|feel|note)|note(?:[:,]| that)|should you|happy to|do not hesitate|don't hesitate|in conclusion|to (?:summari[sz]e|conclude)|overall,)[^\n]*\.?\s*$/i;
  let prev: string;
  do {
    prev = out;
    out = out.replace(tailPattern, "").trimEnd();
  } while (out !== prev);

  return out.trim();
}

/**
 * Detect transient network errors that warrant a retry. llama-server can drop
 * connections under load (cold model load races, KV-cache reallocations,
 * parallel-slot saturation) producing generic "fetch failed" / undici errors.
 */
function isTransientFetchError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("cancelled") || msg.includes("aborted")) return false;
  return (
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("terminated") ||
    msg.includes("network") ||
    msg.includes("eof") ||
    msg.includes("undici") ||
    msg.includes("etimedout") ||
    msg.includes("epipe")
  );
}

interface JobData {
  taskId: string;
  jobId: string;
  name: string;
  source: string;
  original: string;
  wordCount: number;
  model: string;
  mode: TaskMode;
  prompt: string;
  fast: boolean;
  wpc: number;
  overlap: number;
  editOptions?: Record<string, boolean | string>;
  targetLang?: string;
}

const tasks = new Map<string, TaskState>();
const pending: JobData[] = [];
const abortControllers = new Map<string, AbortController>();
let io: SocketServer | null = null;
let concurrency = 1;
let active = 0;

function broadcast(): void {
  if (io) {
    const snapshot = Object.fromEntries(tasks);
    console.log(
      `[Queue] broadcast ${tasks.size} tasks to ${io.engine?.clientsCount ?? "?"} clients`,
    );
    io.emit("queue:update", snapshot);
  }
}

function updateTask(id: string, update: Partial<TaskState>): void {
  const existing = tasks.get(id);
  if (existing) {
    const prevStatus = existing.status;
    Object.assign(existing, update);
    if (existing.status === "editing" && prevStatus !== "editing") {
      // New editing run for this task: restart milestone tracking from 0%.
      lastProgressLogDecile.delete(id);
    }
    if (typeof update.progress === "number") {
      emitProgressMilestone(id, update.progress);
    }
    // Surface lifecycle transitions as user-facing log entries (once per
    // transition). Engine logs cover model load; these cover the queue.
    if (existing.status === "editing" && prevStatus !== "editing") {
      appendLog({
        level: "info",
        source: "task",
        message: `Editing ${existing.name} (${existing.mode})…`,
        model: existing.model,
        taskId: id,
      });
    }
    if (existing.status === "done" && prevStatus !== "done") {
      appendLog({
        level: "info",
        source: "task",
        message: `Done: ${existing.name} (${existing.mode})`,
        model: existing.model,
        taskId: id,
      });
    }
    // Surface terminal errors as user-facing log entries (once per transition).
    if (
      existing.status === "error" &&
      prevStatus !== "error" &&
      existing.result
    ) {
      const errs = existing.result.errors ?? [];
      const summary = errs.length > 0 ? errs.join(" · ") : "unknown error";
      const diag = diagnoseTaskError(summary);
      appendLog({
        level: "error",
        source: "task",
        message: `${existing.name} (${existing.mode}) failed: ${summary}`,
        hintKey: diag?.hintKey,
        model: existing.model,
        taskId: id,
      });
    }
    // Persist any task that has reached a terminal state so it survives a restart.
    if (
      existing.status === "done" ||
      existing.status === "error" ||
      existing.status === "cancelled"
    ) {
      lastProgressLogDecile.delete(id);
      try {
        saveTaskState(existing);
      } catch (err) {
        console.warn(`[Queue] failed to persist task ${id}:`, err);
      }
    }
    broadcast();
  }
}

/**
 * Throttle progress broadcasts during streaming so the socket doesn't get
 * flooded. Only updates if value changed by >= 0.5 % or > 250 ms since last
 * broadcast.
 */
const lastProgressBroadcast = new Map<string, { at: number; value: number }>();
/** Last logged progress decile per task — used to emit milestone log lines
 *  (10%, 20%, …) into the UI engine-status feed without spamming. */
const lastProgressLogDecile = new Map<string, number>();

function emitProgressMilestone(id: string, value: number): void {
  const clamped = Math.max(0, Math.min(1, value));
  const decile = Math.floor(clamped * 10);
  if (decile < 1 || decile > 10) return;
  const prev = lastProgressLogDecile.get(id) ?? 0;
  if (decile <= prev) return;
  lastProgressLogDecile.set(id, decile);

  const task = tasks.get(id);
  appendLog({
    level: "info",
    source: "task",
    message: `Editing${task ? ` ${task.name}` : ""}: ${decile * 10}%`,
    model: task?.model,
    taskId: id,
  });
}

function updateProgress(id: string, value: number): void {
  const last = lastProgressBroadcast.get(id);
  const now = Date.now();
  if (last && now - last.at < 250 && Math.abs(value - last.value) < 0.005) {
    return;
  }
  lastProgressBroadcast.set(id, { at: now, value });
  updateTask(id, { progress: value });

  emitProgressMilestone(id, value);
}

/** Saturating curve for JSON corrections where output length is unknown. */
function creepingProgress(tokens: number): number {
  // Reach high percentages earlier so UI progress does not look stalled
  // when a chunk has relatively few output tokens.
  return 1 - Math.exp(-tokens / 120);
}

/**
 * Process catalog/timeline analysis using map-reduce over chunks.
 * Each chunk is analyzed independently (map), then partial JSONs are merged
 * by deduplicating characters/locations on name+aliases and concatenating
 * timeline events (reduce). This lets analysis scale beyond the model's
 * context window.
 */
async function processAnalysisJob(
  job: JobData,
  ac: AbortController,
): Promise<void> {
  const {
    taskId,
    name: chapterName,
    original,
    model,
    prompt,
    wpc,
    overlap,
  } = job;

  updateTask(taskId, {
    status: "editing",
    startedAt: Date.now(),
    phase: "splitting",
  });

  // Smaller chunks for analysis: 8192 ctx must hold input prompt + system +
  // JSON output. ~2500 words ≈ 3500 tokens leaves ~4k tokens for output.
  const analysisTargetWords = Math.min(Math.max(wpc, 2500), 2500);
  const chunks = splitIntoChunks(original, analysisTargetWords, overlap);
  const totalChunks = chunks.length;
  updateTask(taskId, { phase: `0/${totalChunks} chunks` });

  const partialResults: unknown[] = [];
  const errors: string[] = [];
  let firstParseErrorRaw: string | null = null;

  // Inject the chapter name into the system prompt so the model labels every
  // entry's `chapter`/`chapters` field with this exact value (instead of
  // hallucinating "Chapter 1", "Chapter 2"… per chunk).
  const chapterAwarePrompt =
    prompt +
    `\n\nIMPORTANT: The text you are analyzing is from a single chapter named exactly "${chapterName}". For every entry, set the "chapter" field (or include "${chapterName}" in the "chapters" array) to "${chapterName}". Do NOT invent chapter numbers or use any other label.`;

  for (let j = 0; j < chunks.length; j++) {
    if (ac.signal.aborted) {
      updateTask(taskId, {
        status: "cancelled",
        finishedAt: Date.now(),
        result: {
          editedText: "",
          originalText: original,
          corrections: [],
          skipped: [],
          errors: ["cancelled"],
          structuredData: mergeAnalysisParts(partialResults),
        },
      });
      abortControllers.delete(taskId);
      return;
    }

    const chunk = chunks[j];
    const chunkLabel = `${j + 1}/${totalChunks}`;
    let acc = "";
    let tokCount = 0;

    try {
      const MAX_ATTEMPTS = 5;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (ac.signal.aborted) throw new Error("cancelled");
        acc = "";
        tokCount = 0;
        const phasePrefix = attempt === 1 ? "" : `retry ${attempt - 1} — `;
        try {
          updateTask(taskId, {
            phase: `${phasePrefix}analyzing chunk ${chunkLabel}`,
          });
          for await (const tok of analyzeStream(
            model,
            `[Chapter: ${chapterName}]\n\n${chunk.body}`,
            chapterAwarePrompt,
            ac.signal,
          )) {
            acc += tok;
            tokCount++;
            if (tokCount === 1) {
              updateTask(taskId, {
                phase: `${phasePrefix}receiving chunk ${chunkLabel}`,
              });
            }
            const intra = creepingProgress(tokCount);
            updateProgress(taskId, (j + intra) / totalChunks);
          }
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (!isTransientFetchError(err) || attempt === MAX_ATTEMPTS) {
            throw err;
          }
          const waitMs = 750 * attempt;
          console.warn(
            `[Queue] analysis chunk ${chunkLabel} attempt ${attempt} failed (${msg}); retrying in ${waitMs}ms`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      if (lastErr) throw lastErr;

      const parsed = parseJsonResponse(acc);
      if (parsed) {
        partialResults.push(forceChapterLabel(parsed, chapterName));
      } else {
        errors.push(`chunk ${chunkLabel}: failed to parse JSON`);
        if (!firstParseErrorRaw) firstParseErrorRaw = acc.slice(0, 500);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Queue] analysis chunk ${chunkLabel} failed: ${msg}`);
      errors.push(`chunk ${chunkLabel}: ${msg}`);
    }

    updateTask(taskId, { progress: (j + 1) / totalChunks });
  }

  updateTask(taskId, { phase: "merging results" });
  const merged = mergeAnalysisParts(partialResults);
  const hasAnyData =
    Object.keys(merged).length > 0 &&
    Object.values(merged).some((v) => Array.isArray(v) && v.length > 0);

  if (!hasAnyData && firstParseErrorRaw) {
    errors.push(`raw output sample: ${firstParseErrorRaw}`);
  }

  abortControllers.delete(taskId);

  const result: TaskResult = {
    editedText: "",
    originalText: original,
    corrections: [],
    skipped: [],
    errors,
    structuredData: hasAnyData ? merged : null,
  };

  // If any chunks failed, surface as error (even if we have partial data),
  // so the user knows to re-run this chapter. The partial data is preserved.
  const hadChunkFailure = errors.length > 0;
  updateTask(taskId, {
    status: hasAnyData && !hadChunkFailure ? "done" : "error",
    progress: 1,
    finishedAt: Date.now(),
    result,
  });

  // Once all per-chapter analysis tasks of this job are done, spawn a single
  // prose-summary task synthesising them.
  if (hasAnyData) {
    maybeSpawnAnalysisSummary(job);
  }
}

/**
 * If every analysis sibling task in this job is now done (or terminal),
 * queue an `analysis_summary` synthesis task. No-op if a summary task for
 * this job already exists or if some siblings are still running.
 */
function maybeSpawnAnalysisSummary(finishedJob: JobData): void {
  const jobId = finishedJob.jobId;
  const siblings: TaskState[] = [];
  let alreadyHasSummary = false;
  for (const t of tasks.values()) {
    if (t.jobId !== jobId) continue;
    if (t.mode === "analysis_summary") {
      alreadyHasSummary = true;
      break;
    }
    if (ANALYSIS_MODES.includes(t.mode)) siblings.push(t);
  }
  if (alreadyHasSummary || siblings.length === 0) return;

  const allTerminal = siblings.every((s) =>
    ["done", "error", "cancelled"].includes(s.status),
  );
  if (!allTerminal) return;

  const withData = siblings.filter((s) => s.result?.structuredData);
  if (withData.length === 0) return;

  void submitTask({
    jobId,
    name: "Summary",
    source: finishedJob.source,
    original: "",
    wordCount: 0,
    model: finishedJob.model,
    mode: "analysis_summary",
    prompt: ANALYSIS_SUMMARY_PROMPT,
    fast: false,
    wpc: finishedJob.wpc,
    overlap: 0,
  }).catch((err) => {
    console.error("[Queue] failed to spawn analysis_summary:", err);
  });
}

/**
 * Synthesise a prose summary from all completed per-chapter analysis tasks
 * sharing this job's jobId. Output goes into result.editedText as Markdown.
 */
async function processSynthesisJob(
  job: JobData,
  ac: AbortController,
): Promise<void> {
  const { taskId, jobId, model, prompt } = job;
  updateTask(taskId, {
    status: "editing",
    startedAt: Date.now(),
    phase: "gathering chapter results",
  });

  // Collect merged structured data across siblings for this job.
  const partials: unknown[] = [];
  for (const t of tasks.values()) {
    if (
      t.jobId === jobId &&
      ANALYSIS_MODES.includes(t.mode) &&
      t.result?.structuredData
    ) {
      partials.push(t.result.structuredData);
    }
  }

  if (partials.length === 0) {
    updateTask(taskId, {
      status: "error",
      finishedAt: Date.now(),
      progress: 1,
      result: {
        editedText: "",
        originalText: "",
        corrections: [],
        skipped: [],
        errors: ["no analysis results available to summarise"],
      },
    });
    abortControllers.delete(taskId);
    return;
  }

  const merged = mergeAnalysisParts(partials);
  const payload = JSON.stringify(merged, null, 2);

  // ── Context-window sizing for the synthesis step ──────────────────────────
  // The merged JSON can be large (all characters + locations + events across
  // every chapter). Estimate token count (≈ 4 chars per token) and pick the
  // smallest standard context size that fits the payload + system prompt +
  // 1 500 output tokens. The llama-server will be restarted with -c <ctx> if
  // the currently loaded context is smaller.
  const CTX_STEPS = [8192, 16384, 32768, 65536, 131072];
  const payloadTokens = Math.ceil(payload.length / 4);
  const systemTokens = Math.ceil(prompt.length / 4) + 256; // 256 for system preamble
  const outputTokens = 1500;
  const totalNeeded = payloadTokens + systemTokens + outputTokens;
  const requiredCtx =
    CTX_STEPS.find((c) => c >= totalNeeded) ?? CTX_STEPS[CTX_STEPS.length - 1];
  console.log(
    `[Queue] synthesis ctx: payload≈${payloadTokens} + system≈${systemTokens} + out=${outputTokens} → need ${totalNeeded} → using ${requiredCtx}`,
  );

  updateTask(taskId, { phase: "writing prose summary" });
  let acc = "";
  let tokCount = 0;
  const errors: string[] = [];
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (ac.signal.aborted) break;
    acc = "";
    tokCount = 0;
    const phasePrefix = attempt === 1 ? "" : `retry ${attempt - 1} — `;
    try {
      updateTask(taskId, { phase: `${phasePrefix}writing prose summary` });
      for await (const tok of synthesizeStream(
        model,
        payload,
        prompt,
        requiredCtx,
        ac.signal,
      )) {
        acc += tok;
        tokCount++;
        if (tokCount === 1)
          updateTask(taskId, { phase: `${phasePrefix}receiving prose` });
        updateProgress(taskId, creepingProgress(tokCount));
      }
      break; // success
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isTransientFetchError(err) || attempt === MAX_ATTEMPTS) {
        console.error(`[Queue] synthesis failed: ${msg}`);
        errors.push(msg);
        break;
      }
      const waitMs = 750 * attempt;
      console.warn(
        `[Queue] synthesis attempt ${attempt} failed (${msg}); retrying in ${waitMs}ms`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  abortControllers.delete(taskId);

  const prose = stripAiSignoff(acc.trim());
  const success = prose.length > 0 && errors.length === 0;
  updateTask(taskId, {
    status: success ? "done" : "error",
    progress: 1,
    finishedAt: Date.now(),
    result: {
      editedText: prose,
      originalText: payload,
      corrections: [],
      skipped: [],
      errors,
      structuredData: merged,
    },
  });
}

async function processJob(job: JobData): Promise<void> {
  const { taskId, original, model, mode, prompt, fast, wpc, overlap } = job;
  const ac = new AbortController();
  abortControllers.set(taskId, ac);

  // Analysis modes (catalog / timeline) use a single LLM call, not chunking
  if (ANALYSIS_MODES.includes(mode)) {
    return processAnalysisJob(job, ac);
  }
  if (mode === "analysis_summary") {
    return processSynthesisJob(job, ac);
  }

  // Translation always uses rewrite (full text) mode, never fast/JSON corrections
  const useFast = mode === "translate" ? false : fast;

  const jobStart = performance.now();
  let totalOutTokens = 0;

  updateTask(taskId, {
    status: "editing",
    startedAt: Date.now(),
    phase: "splitting",
  });

  // Pre-load the model with a stable slot count equal to the queue's
  // configured concurrency (capped by hardware in detectParallelSlots).
  // Using the *configured* concurrency rather than `pending+1` keeps the
  // slot count constant across the lifetime of a batch, so we don't
  // restart the server every time another task joins the queue.
  const desiredSlots = Math.max(1, concurrency);
  try {
    await ensureModelLoaded(model, undefined, desiredSlots);
  } catch (err) {
    // Surface but continue — the first chunk call will re-attempt loading
    // and produce a more specific error if it really can't start.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Queue] preload of ${model} failed: ${msg}`);
  }

  const chunks = splitIntoChunks(original, wpc, overlap);
  updateTask(taskId, { phase: `0/${chunks.length} chunks` });

  const pieces: string[] = [];
  const corrections: Correction[] = [];
  const skipped: Correction[] = [];
  const errors: string[] = [];

  for (let j = 0; j < chunks.length; j++) {
    if (ac.signal.aborted) {
      updateTask(taskId, {
        status: "cancelled",
        finishedAt: Date.now(),
        result: {
          editedText: original,
          originalText: original,
          corrections: [],
          skipped: [],
          errors: ["cancelled"],
        },
      });
      abortControllers.delete(taskId);
      return;
    }

    const chunk = chunks[j];
    const chunkLabel = `${j + 1}/${chunks.length}`;
    let acc = "";
    let tokCount = 0;
    const chunkStart = performance.now();
    let firstTokenAt = 0;

    try {
      const MAX_ATTEMPTS = 5;
      let lastErr: unknown = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (ac.signal.aborted) throw new Error("cancelled");
        acc = "";
        tokCount = 0;
        firstTokenAt = 0;
        const phasePrefix = attempt === 1 ? "" : `retry ${attempt - 1} — `;
        try {
          updateTask(taskId, {
            phase: `${phasePrefix}sending chunk ${chunkLabel}`,
          });

          if (useFast) {
            for await (const tok of findCorrectionsStream(
              model,
              chunk.body,
              prompt,
              ac.signal,
            )) {
              acc += tok;
              tokCount++;
              if (tokCount === 1) {
                firstTokenAt = performance.now();
                updateTask(taskId, {
                  phase: `${phasePrefix}receiving chunk ${chunkLabel}`,
                });
              }
              const intra = creepingProgress(tokCount);
              updateProgress(taskId, (j + intra) / chunks.length);
            }
          } else {
            for await (const tok of editChunkStream(
              model,
              chunk.body,
              prompt,
              ac.signal,
            )) {
              acc += tok;
              tokCount++;
              if (tokCount === 1) {
                firstTokenAt = performance.now();
                updateTask(taskId, {
                  phase: `${phasePrefix}receiving chunk ${chunkLabel}`,
                });
              }
              const intra = Math.min(
                0.98,
                acc.length / Math.max(1, chunk.body.length),
              );
              updateProgress(taskId, (j + intra) / chunks.length);
            }
          }
          lastErr = null;
          break; // success
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (!isTransientFetchError(err) || attempt === MAX_ATTEMPTS) {
            throw err;
          }
          const waitMs = 750 * attempt;
          console.warn(
            `[Queue] chunk ${chunkLabel} attempt ${attempt} failed (${msg}); retrying in ${waitMs}ms`,
          );
          updateTask(taskId, {
            phase: `chunk ${chunkLabel} retrying after error`,
          });
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      if (lastErr) throw lastErr;

      if (useFast) {
        updateTask(taskId, { phase: `applying corrections ${chunkLabel}` });
        const cs = parseCorrectionsJson(acc);

        // Corrections are emitted as JSONL (one JSON object per line), so
        // truncation only ever drops the final partial line. No retry needed.
        // Just note when the response was likely cut off so users can spot
        // chunks where a few late corrections may have been lost.
        const trimmedAcc = acc.trim();
        const looksTruncated =
          acc.length > 800 &&
          trimmedAcc.length > 0 &&
          !trimmedAcc.endsWith("}");
        if (looksTruncated) {
          appendLog({
            level: "info",
            source: "engine",
            taskId,
            message: `Chunk ${chunkLabel}: response ended mid-line (${acc.length} chars, ${cs.length} corrections parsed). Last partial entry dropped — consider raising max output tokens if this happens often.`,
            model,
          });
        }

        // Debug: log raw response when parsing yields zero corrections
        if (cs.length === 0 && acc.length > 0) {
          const preview = acc.slice(0, 600);
          console.warn(
            `[Queue] chunk ${chunkLabel} JSON parse yielded 0 corrections. Raw (${acc.length} chars):\n${preview}`,
          );
          appendLog({
            level: "warn",
            source: "engine",
            message: `Chunk ${chunkLabel}: model returned ${acc.length} chars but 0 corrections parsed. Preview: ${acc.slice(0, 200)}`,
            model,
          });
        }

        const [newBody, applied, sk] = applyCorrections(chunk.body, cs);
        const core = stripOverlapFromResponse(
          newBody,
          chunk.overlapHeadParagraphs,
        );

        for (const c of applied) {
          corrections.push({
            ...c,
            chunk: `Chunk ${chunkLabel}`,
            id: uuidv4(),
          });
        }
        skipped.push(
          ...sk.map((s) => ({ ...s, chunk: `Chunk ${chunkLabel}` })),
        );
        pieces.push(core);
      } else {
        const core = stripOverlapFromResponse(
          acc.trim(),
          chunk.overlapHeadParagraphs,
        );
        pieces.push(core);
      }
    } catch (err) {
      pieces.push(chunk.core);
      errors.push(
        `chunk ${j + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Per-chunk timing summary
    {
      const now = performance.now();
      const prefillMs = firstTokenAt > 0 ? firstTokenAt - chunkStart : -1;
      const decodeMs = firstTokenAt > 0 ? now - firstTokenAt : -1;
      const tokPerSec =
        decodeMs > 0 && tokCount > 1
          ? ((tokCount - 1) / (decodeMs / 1000)).toFixed(1)
          : "n/a";
      // Rough input-token estimate (3.5 chars/token avg across our supported
      // languages) — gives a useful prefill tok/s number even though llama-
      // server's streaming endpoint doesn't expose exact prompt-token counts.
      const inputTokenEst = Math.ceil(chunk.body.length / 3.5);
      const prefillTps =
        prefillMs > 0 ? (inputTokenEst / (prefillMs / 1000)).toFixed(0) : "n/a";
      totalOutTokens += tokCount;
      console.log(
        `[Queue] chunk ${chunkLabel} timing: prefill=${prefillMs.toFixed(0)}ms (~${prefillTps} tok/s in) decode=${decodeMs.toFixed(0)}ms tokens=${tokCount} tok/s=${tokPerSec}`,
      );
      if (tokCount > 0) {
        appendLog({
          level: "info",
          source: "engine",
          message: `Chunk ${chunkLabel}: prefill ~${prefillTps} tok/s · decode ${tokPerSec} tok/s (${tokCount} tokens)`,
          model,
        });
      }
      if (tokCount === 0) {
        appendLog({
          level: "warn",
          source: "engine",
          message: `Chunk ${chunkLabel}: model returned 0 content tokens — check --reasoning flag or model template`,
          model,
        });
      }
    }

    updateTask(taskId, { progress: (j + 1) / chunks.length });
  }

  abortControllers.delete(taskId);

  const totalMs = performance.now() - jobStart;
  const overallTps =
    totalMs > 0 ? ((totalOutTokens / totalMs) * 1000).toFixed(1) : "n/a";
  console.log(
    `[Queue] job ${taskId} done: wall=${(totalMs / 1000).toFixed(1)}s chunks=${chunks.length} tokens=${totalOutTokens} tok/s=${overallTps}`,
  );
  if (totalOutTokens > 0) {
    appendLog({
      level: "info",
      source: "engine",
      message: `Job done: ${(totalMs / 1000).toFixed(1)}s · ${totalOutTokens} tokens · ${overallTps} tok/s`,
      model,
    });
  }

  const result: TaskResult = {
    editedText: pieces.join("\n\n").trim(),
    originalText: original,
    corrections,
    skipped,
    errors,
  };

  // If any chunks failed (after retries), the chapter is partially un-edited
  // (failed chunks fall back to the original text). Surface as error so the
  // user knows to re-run, while preserving the partial output.
  updateTask(taskId, {
    status: errors.length > 0 ? "error" : "done",
    progress: 1,
    finishedAt: Date.now(),
    result,
  });
}

function pump(): void {
  while (active < concurrency && pending.length > 0) {
    const job = pending.shift()!;
    active++;
    console.log(
      `[Queue] dispatch "${job.name}" — active=${active}/${concurrency}, pending=${pending.length}`,
    );
    processJob(job)
      .catch((err) => {
        updateTask(job.taskId, {
          status: "error",
          finishedAt: Date.now(),
          result: {
            editedText: job.original,
            originalText: job.original,
            corrections: [],
            skipped: [],
            errors: [
              `fatal: ${err instanceof Error ? err.message : String(err)}`,
            ],
          },
        });
      })
      .finally(() => {
        active--;
        console.log(
          `[Queue] finished "${job.name}" — active=${active}/${concurrency}, pending=${pending.length}`,
        );
        pump();
        // After everything for this job has settled (including any spawned
        // analysis_summary), unload models if no other jobs are running.
        scheduleIdleUnload(job.jobId);
      });
  }
}

// ── Idle-unload: free model RAM between separate jobs ────────────────────────

let unloadTimer: NodeJS.Timeout | null = null;

/**
 * After a job's tasks finish, schedule a check: if no jobs are queued or
 * running anywhere in the system, unload every loaded model from llama-server.
 * Debounced so the synthesis spawn (which arrives moments after siblings
 * complete) doesn't trip a premature unload.
 */
function scheduleIdleUnload(_jobId: string): void {
  if (unloadTimer) clearTimeout(unloadTimer);
  unloadTimer = setTimeout(() => {
    unloadTimer = null;
    void maybeUnloadIdleModels();
  }, 2000);
}

async function maybeUnloadIdleModels(): Promise<void> {
  // Anything still active? (queued or editing in any job)
  if (active > 0 || pending.length > 0) return;
  for (const t of tasks.values()) {
    if (t.status === "queued" || t.status === "editing") return;
  }

  try {
    const loaded = await listLoadedModels();
    if (loaded.length === 0) return;
    console.log(
      `[Queue] no active jobs — unloading ${loaded.length} model(s): ${loaded.join(", ")}`,
    );
    for (const name of loaded) {
      await unloadModel(name);
    }
  } catch (err) {
    console.warn("[Queue] idle unload failed:", err);
  }
}

// ── Public API ──

export function initQueue(socketIo: SocketServer, conc = 1): void {
  io = socketIo;
  concurrency = Math.max(1, conc);
  // Hydrate persisted tasks from previous sessions.
  try {
    const saved = loadTaskStates();
    for (const t of saved) {
      // Only hydrate terminal states; queued/editing tasks from a crashed run
      // would never resume, so mark them cancelled on load.
      if (t.status === "queued" || t.status === "editing") {
        t.status = "cancelled";
        t.finishedAt = t.finishedAt ?? Date.now();
      }
      // Backfill jobId for tasks saved before this field existed.
      if (!t.jobId) t.jobId = t.id;
      tasks.set(t.id, t);
    }
    if (saved.length > 0) {
      console.log(
        `[Queue] hydrated ${saved.length} tasks from previous sessions`,
      );
    }
  } catch (err) {
    console.warn("[Queue] failed to hydrate tasks:", err);
  }
}

export function setConcurrency(n: number): void {
  concurrency = Math.max(1, n);
  pump();
}

/** Current concurrency setting — exported so the model warm-up path can
 *  pre-allocate the right number of llama-server parallel slots up front
 *  and avoid mid-session reloads. */
export function getConcurrency(): number {
  return concurrency;
}

export async function submitTask(
  data: Omit<JobData, "taskId">,
): Promise<string> {
  const taskId = uuidv4();

  tasks.set(taskId, {
    id: taskId,
    jobId: data.jobId,
    status: "queued",
    progress: 0,
    phase: "",
    name: data.name,
    source: data.source,
    mode: data.mode,
    wordCount: data.wordCount,
    submittedAt: Date.now(),
    result: null,
    editOptions: data.editOptions,
    targetLang: data.targetLang,
    model: data.model,
    retrySpec: {
      name: data.name,
      source: data.source,
      original: data.original,
      wordCount: data.wordCount,
      model: data.model,
      mode: data.mode,
      prompt: data.prompt,
      fast: data.fast,
      wpc: data.wpc,
      overlap: data.overlap,
      editOptions: data.editOptions,
      targetLang: data.targetLang,
    },
  });

  pending.push({ taskId, ...data });
  broadcast();
  pump();
  return taskId;
}

export function cancelAll(): void {
  for (const job of pending) {
    updateTask(job.taskId, { status: "cancelled", finishedAt: Date.now() });
  }
  pending.length = 0;
  for (const ac of abortControllers.values()) ac.abort();
  broadcast();
}

/**
 * Cancel a single task by id. If queued, removes from pending. If running,
 * aborts the stream. If already terminal, no-op.
 */
export function cancelTask(id: string): boolean {
  const task = tasks.get(id);
  if (!task) return false;
  if (["done", "error", "cancelled"].includes(task.status)) return false;

  // Remove from pending queue if still waiting
  const idx = pending.findIndex((j) => j.taskId === id);
  if (idx !== -1) pending.splice(idx, 1);

  // Abort any in-flight stream
  const ac = abortControllers.get(id);
  if (ac) ac.abort();

  updateTask(id, { status: "cancelled", finishedAt: Date.now() });
  return true;
}

/**
 * Re-submit a failed/cancelled task using its stored retrySpec. Removes the
 * old task entry and creates a new one under the SAME jobId so it groups
 * back into the original job's review pane. Returns the new taskId, or
 * throws an Error with a user-facing message if it can't be retried.
 */
export async function retryTask(id: string): Promise<string> {
  const task = tasks.get(id);
  if (!task) {
    throw new Error("Task not found.");
  }
  if (!["error", "cancelled"].includes(task.status)) {
    throw new Error(
      `Task is "${task.status}" — only failed or cancelled tasks can be retried.`,
    );
  }
  if (!task.retrySpec) {
    throw new Error(
      "This task was created before retry support was added — its source text was not stored. Re-upload the manuscript and start a new job for this chapter.",
    );
  }

  const spec = task.retrySpec;
  const oldJobId = task.jobId;

  // Drop old entry first so the UI doesn't show two rows for the same chapter.
  tasks.delete(id);
  abortControllers.delete(id);
  try {
    deleteTaskState(id);
  } catch {
    /* ignore */
  }
  broadcast();

  const newTaskId = await submitTask({
    jobId: oldJobId,
    name: spec.name,
    source: spec.source,
    original: spec.original,
    wordCount: spec.wordCount,
    model: spec.model,
    mode: spec.mode,
    prompt: spec.prompt,
    fast: spec.fast,
    wpc: spec.wpc,
    overlap: spec.overlap,
    editOptions: spec.editOptions,
    targetLang: spec.targetLang,
  });
  return newTaskId;
}

export function removeCompleted(): void {
  const removed: string[] = [];
  for (const [id, state] of tasks) {
    if (["done", "error", "cancelled"].includes(state.status)) {
      tasks.delete(id);
      abortControllers.delete(id);
      removed.push(id);
    }
  }
  if (removed.length > 0) {
    try {
      deleteTaskStatesIn(removed);
    } catch (err) {
      console.warn("[Queue] failed to delete persisted tasks:", err);
    }
  }
  broadcast();
}

export function removeTask(id: string): void {
  // If the task is still active, cancel it first so we tear down any
  // in-flight stream before dropping the state.
  const task = tasks.get(id);
  if (task && (task.status === "queued" || task.status === "editing")) {
    const idx = pending.findIndex((j) => j.taskId === id);
    if (idx !== -1) pending.splice(idx, 1);
    const ac = abortControllers.get(id);
    if (ac) ac.abort();
  }
  tasks.delete(id);
  abortControllers.delete(id);
  try {
    deleteTaskState(id);
  } catch (err) {
    console.warn(`[Queue] failed to delete persisted task ${id}:`, err);
  }
  broadcast();
}

/**
 * Remove every task that belongs to the given jobId, regardless of status.
 * Active tasks are cancelled first. Returns the number of tasks removed.
 */
export function removeJob(jobId: string): number {
  const removed: string[] = [];
  for (const [id, state] of tasks) {
    if (state.jobId !== jobId) continue;
    if (state.status === "queued" || state.status === "editing") {
      const idx = pending.findIndex((j) => j.taskId === id);
      if (idx !== -1) pending.splice(idx, 1);
      const ac = abortControllers.get(id);
      if (ac) ac.abort();
    }
    tasks.delete(id);
    abortControllers.delete(id);
    removed.push(id);
  }
  if (removed.length > 0) {
    try {
      deleteTaskStatesIn(removed);
    } catch (err) {
      console.warn(
        `[Queue] failed to delete persisted tasks for job ${jobId}:`,
        err,
      );
    }
    broadcast();
  }
  return removed.length;
}

export function getTasksSnapshot(): Record<string, TaskState> {
  return Object.fromEntries(tasks);
}

export function getTask(id: string): TaskState | undefined {
  return tasks.get(id);
}

export function hasActive(): boolean {
  for (const state of tasks.values()) {
    if (state.status === "queued" || state.status === "editing") return true;
  }
  return false;
}

export async function closeQueue(): Promise<void> {
  cancelAll();
}
