// ── In-memory task queue ──
// Single-user local app — no Redis needed.

import { v4 as uuidv4 } from "uuid";
import type { Server as SocketServer } from "socket.io";
import type {
  TaskState,
  TaskResult,
  TaskMode,
  Correction,
  CopyEditOptions,
  CorrectionsDigest,
  EditUnit,
} from "./types.js";
import { ANALYSIS_MODES, DEFAULT_COPY_EDIT_OPTIONS } from "./types.js";
import { splitIntoChunks, stripOverlapFromResponse } from "./chunking.js";
import { buildPublicationScan } from "./publicationScan.js";
import {
  editChunkStream,
  findCorrectionsStream,
  parseCorrectionsJson,
  applyCorrections,
  applyCorrectionsVerified,
  isRealWordSwap,
  restoreTypography,
  analyzeStream,
  synthesizeStream,
  parseJsonResponse,
  reviewCorrectionsStream,
  parseReviewScores,
  listLoadedModels,
  unloadModel,
  estimateTokens,
  getContextWindow,
} from "./llm.js";
import {
  runWithRetry,
  aggregateReviewScores,
  flagUnanchoredCorrections,
} from "./reviewResilience.js";
import { mergeAnalysisParts } from "./analysisMerge.js";
import {
  sanitizeQuoteCorrections,
  foldContainedCorrections,
  collapseIntroducedPunctuationPairs,
  reconcileSpellWithEditor,
} from "./correctionHygiene.js";
import {
  buildAnalysisSummaryPrompt,
  buildBlurbPrompt,
  buildReviewerPrompt,
  buildTranslationReviewerPrompt,
  buildStyleCompliancePrompt,
  buildCopyEditCorrectionsPrompt,
  buildTranslationUpgradePrompt,
  buildFluencyReviewerPrompt,
  buildSpellHintBlock,
} from "./prompts.js";
import { runTranslationUpgrade } from "./translationUpgrade.js";
import {
  appendLog,
  clearLogs,
  diagnoseTaskError,
  resolveLogsForTask,
} from "./logBus.js";
import { buildClientSnapshot, type ClientTaskState } from "./snapshot.js";
import { ensureModelLoaded, getCurrentParallelSlots } from "./llamaServer.js";
import {
  runStoryAnalysis,
  type StoryAnalysisState,
  type LlmCall,
} from "./storyAnalysis.js";
import {
  runTextEvaluation,
  type TextEvaluatorState,
} from "./textEvaluator.js";
import { runDevelopmentalEdit } from "./developmentalEdit.js";
import {
  saveTaskState,
  loadTaskStates,
  deleteTaskState,
  deleteTaskStatesIn,
  deleteAllTaskStates,
  pruneOldTasks,
  recordThroughputSample,
  recordJobThroughput,
} from "./db.js";
import { isApiModel, isCustomGgufModel } from "./modelCatalog.js";
import { shouldAutoRetry, MAX_AUTO_ATTEMPTS } from "./retryPolicy.js";
import { computeJobProgress, computeRuntime } from "./runStats.js";
import { resolveRecommendation } from "./hardware.js";

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
 * Split text into non-empty trimmed paragraphs for translation review.
 * Paired by index — short paragraphs (headings, dialogue fragments) are kept.
 */
function srcParasForReview(text: string): string[] {
  return splitParagraphs(text);
}
function tgtParasForReview(text: string): string[] {
  return splitParagraphs(text);
}
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
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

const REVIEWER_MAX_ATTEMPTS = 3;

/**
 * One reviewer agent call with retries. Local inference fails via OOM, slot
 * exhaustion, and garbage output — not just network — so any error except
 * abort is retried. An output that parses to zero review scores (truncated,
 * <think>-only, prose) also counts as a failed attempt; if every attempt
 * falls short, the output with the most parsed scores is kept and the
 * still-unscored corrections are flagged downstream by aggregateReviewScores.
 */
function runReviewerAgentWithRetry(opts: {
  model: string;
  chunkText: string;
  cs: Correction[];
  reviewerPrompt: string;
  signal: AbortSignal;
  taskId: string;
  chunkLabel: string;
  agentLabel: string;
}): Promise<string> {
  return runWithRetry(
    async () => {
      let acc = "";
      for await (const tok of reviewCorrectionsStream(
        opts.model,
        opts.chunkText,
        opts.cs,
        opts.reviewerPrompt,
        opts.signal,
      )) {
        acc += tok;
      }
      return acc;
    },
    {
      maxAttempts: REVIEWER_MAX_ATTEMPTS,
      backoffMs: (attempt) => 750 * attempt,
      isValid: (out) => parseReviewScores(out).size > 0,
      isAborted: () => opts.signal.aborted,
      keepBest: (a, b) =>
        parseReviewScores(a).size >= parseReviewScores(b).size ? a : b,
      onRetry: (attempt, why) =>
        appendLog({
          level: "warn",
          source: "engine",
          taskId: opts.taskId,
          message: `${opts.agentLabel} retry ${attempt}/${REVIEWER_MAX_ATTEMPTS} for chunk ${opts.chunkLabel}: ${why}`,
          model: opts.model,
        }),
    },
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
  wpc: number;
  overlap: number;
  editOptions?: Record<string, boolean | string>;
  targetLang?: string;
  manuscriptLang?: string;
  reviewMode?: boolean;
  reviewerThreshold?: number;
  reviewerCount?: number;
  styleGuide?: string;
  spellCheck?: boolean;
  retextCheck?: boolean;
  grammarCheck?: boolean;
  dualEditor?: boolean;
  dualCount?: number;
  characterDedup?: boolean;
  styleComplianceAgent?: boolean;
  /** Thorough mode: run a second copy-edit pass over the edited text. */
  extraPass?: boolean;
  /** Run-mode preset the concrete knobs above were resolved from (logging only). */
  runMode?: string;
  /** Story analysis: all manuscript chapters (one task spans the whole book). */
  units?: EditUnit[];
  /** Story analysis: resume checkpoint from a cancelled/failed prior run. */
  resumeState?: unknown;
  /** Text evaluator: recurring-habit digest from a finished edit job. */
  correctionsDigest?: CorrectionsDigest;
}

const tasks = new Map<string, TaskState>();
const pending: JobData[] = [];
const abortControllers = new Map<string, AbortController>();
let io: SocketServer | null = null;
let concurrency = 1;
let active = 0;

function broadcast(): void {
  if (!io) return;
  // Coalesce multiple broadcast() calls within the same tick into one
  // emit. Many code paths call broadcast() synchronously back-to-back
  // (e.g. updateTask followed by another updateTask), and emitting the
  // full snapshot each time was producing huge JSON-stringify pressure
  // (OOM crashes with 200+ tasks). One emit per tick is plenty for the UI.
  if (broadcastScheduled) return;
  broadcastScheduled = true;
  setImmediate(flushBroadcast);
}

let broadcastScheduled = false;

function flushBroadcast(): void {
  broadcastScheduled = false;
  if (!io) return;
  // Client snapshots strip ALL heavy fields (retrySpec embeds the chapter
  // text; result embeds original/edited text + every correction — hundreds
  // of KB per task). The frontend hydrates results lazily via REST
  // (/queue/job/:id/results); snapshots carry only a resultMeta summary.
  console.log(
    `[Queue] broadcast ${tasks.size} tasks to ${io.engine?.clientsCount ?? "?"} clients`,
  );
  io.emit("queue:update", buildClientSnapshot(tasks.values()));

  // Separate event so the queue:update contract (Record<id, ClientTaskState>)
  // stays untouched.
  const all = [...tasks.values()];
  io.emit("run:stats", {
    jobProgress: computeJobProgress(all),
    runtime: computeRuntime(all, getCurrentParallelSlots()),
  });
  maybeLogProgress(all);
}

let lastProgressLogAt = 0;
const PROGRESS_LOG_INTERVAL_MS = 30_000;

/**
 * One progress line per 30s, globally — the Diagnostics feed is a single ring
 * buffer that users read after the fact, and per-tick lines would push
 * everything else out of it.
 */
function maybeLogProgress(all: TaskState[]): void {
  try {
    if (!all.some((t) => t.status === "editing")) return;
    const now = Date.now();
    if (now - lastProgressLogAt < PROGRESS_LOG_INTERVAL_MS) return;
    lastProgressLogAt = now;

    const progress = computeJobProgress(all);
    const runtime = computeRuntime(all, getCurrentParallelSlots());

    const entries = Object.entries(progress);
    for (const [jobId, p] of entries) {
      // Nothing useful to say about a job that finished cleanly.
      if (p.fraction >= 1 && p.failed === 0) continue;
      // LogEntry has no jobId field, so name the job inline — but only when
      // more than one is running, where the line would otherwise be ambiguous.
      const which = entries.length > 1 ? ` [${jobId.slice(0, 8)}]` : "";
      const pct = Math.round(p.fraction * 100);
      const words = p.wordsTotal
        ? ` (${p.wordsDone.toLocaleString()} of ${p.wordsTotal.toLocaleString()} words)`
        : "";
      const rate = runtime.activeStreams
        ? ` · ${runtime.aggregateTokPerSec} tok/s across ${runtime.activeStreams} stream${runtime.activeStreams === 1 ? "" : "s"}`
        : "";
      const failed = p.failed
        ? ` · ${p.failed} chapter${p.failed === 1 ? "" : "s"} failed`
        : "";
      appendLog({
        level: "info",
        source: "engine",
        message: `Job progress${which}: ${pct}%${words}${rate}${failed}`,
      });
    }
  } catch {
    // Best effort — a stats failure must never interrupt a run.
  }
}

// Advice already pushed to the client this process, keyed by "<tier>:<kind>".
// The recommendation is recomputed after every job, so without this the same
// "switch to a smaller Betty" would arrive after every single chapter.
const advicesSent = new Set<string>();

/**
 * Tell the UI when measured throughput disagrees with the model in use.
 *
 * Fires at most once per distinct piece of advice per process. The client also
 * remembers dismissals, so a user who says "keep going" is not asked again.
 */
function emitPerfAdvice(): void {
  if (!io) return;
  let rec;
  try {
    rec = resolveRecommendation();
  } catch (err) {
    console.warn("[Queue] could not resolve perf advice:", err);
    return;
  }
  if (!rec.advice) return;
  const key = `${rec.advice.from}:${rec.advice.kind}`;
  if (advicesSent.has(key)) return;
  advicesSent.add(key);
  io.emit("model:perf-advice", {
    ...rec.advice,
    // The download endpoint keys off the catalog id; the selection state keys
    // off the file name. Both are needed to act on this advice.
    recommendedModelId: rec.modelId,
    recommendedFileName: rec.fileName,
    recommendedName: rec.name,
    recommendedSizeBytes: rec.sizeBytes,
  });
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
      clearLogs();
      appendLog({
        level: "info",
        source: "task",
        message: `Editing ${existing.name} (${existing.mode})…`,
        model: existing.model,
        taskId: id,
      });
    }
    if (existing.status === "done" && prevStatus !== "done") {
      // The chapter came good, so its earlier complaints describe a state that
      // is no longer true — drop them rather than leave the panel flagging a
      // problem that fixed itself. Hooked here, on the transition, so every
      // completion path gets it rather than four separate call sites.
      const cleared = resolveLogsForTask(id);
      appendLog({
        level: "info",
        source: "task",
        message:
          cleared > 0
            ? `Done: ${existing.name} (${existing.mode}) — recovered after ${existing.attempts ?? 1} retry${(existing.attempts ?? 1) === 1 ? "" : "s"}`
            : `Done: ${existing.name} (${existing.mode})`,
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
    prompt: buildAnalysisSummaryPrompt(finishedJob.manuscriptLang),
    manuscriptLang: finishedJob.manuscriptLang,
    wpc: finishedJob.wpc,
    overlap: 0,
  }).catch((err) => {
    appendLog({
      level: "error",
      source: "engine",
      message: `Failed to spawn analysis summary: ${err instanceof Error ? err.message : String(err)}`,
      model: finishedJob.model,
    });
  });
}

/**
 * After the prose summary completes, spawn a marketing blurb synthesis task.
 * Same pattern as maybeSpawnAnalysisSummary but for the blurb.
 */
function maybeSpawnBlurb(summaryJob: JobData): void {
  const jobId = summaryJob.jobId;
  let alreadyHasBlurb = false;
  for (const t of tasks.values()) {
    if (t.jobId !== jobId) continue;
    if (t.mode === "blurb") {
      alreadyHasBlurb = true;
      break;
    }
  }
  if (alreadyHasBlurb) return;

  void submitTask({
    jobId,
    name: "Blurb",
    source: summaryJob.source,
    original: "",
    wordCount: 0,
    model: summaryJob.model,
    mode: "blurb",
    prompt: buildBlurbPrompt(summaryJob.manuscriptLang),
    manuscriptLang: summaryJob.manuscriptLang,
    wpc: summaryJob.wpc,
    overlap: 0,
  }).catch((err) => {
    appendLog({
      level: "error",
      source: "engine",
      message: `Failed to spawn blurb: ${err instanceof Error ? err.message : String(err)}`,
      model: summaryJob.model,
    });
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
  const { taskId, jobId, model, prompt, mode } = job;
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

  // The story-read pipeline produces ONE clean, identity-resolved result per
  // job — pass it through untouched. The heuristic re-merge is only for
  // combining multiple legacy per-chapter partials, and its name-containment
  // passes could wrongly re-merge entities the story read kept separate.
  const merged =
    partials.length === 1 &&
    typeof partials[0] === "object" &&
    partials[0] !== null
      ? { ...(partials[0] as Record<string, unknown>) }
      : mergeAnalysisParts(partials);

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

  // After the prose summary completes, spawn a marketing blurb
  if (success && mode === "analysis_summary") {
    maybeSpawnBlurb(job);
  }
}

/**
 * LLM adapter for the story-read orchestrator: collects analyzeStream into a
 * string, sizes the context window per call (chapter text + registry can
 * exceed a local model's default context), and retries transient fetch
 * errors with backoff (same policy as the edit pipeline).
 */
function makeStoryLlm(job: JobData, ac: AbortController): LlmCall {
  const CTX_STEPS = [8192, 16384, 32768, 65536, 131072];
  return async (system, user, opts) => {
    const outTokens = opts?.maxTokens ?? 4096;
    const needed = estimateTokens(system + user) + outTokens + 512;
    const requiredCtx = CTX_STEPS.find((c) => c >= needed) ?? CTX_STEPS.at(-1)!;
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; ; attempt++) {
      try {
        let acc = "";
        for await (const tok of analyzeStream(
          job.model,
          user,
          system,
          ac.signal,
          requiredCtx,
        )) {
          acc += tok;
        }
        return acc;
      } catch (err) {
        if (!isTransientFetchError(err) || attempt === MAX_ATTEMPTS) throw err;
        const waitMs = 750 * attempt;
        console.warn(
          `[Queue] story-analysis call attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}); retrying in ${waitMs}ms`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  };
}

/** Minimal shape check before trusting a persisted resume checkpoint. */
function isUsableCheckpoint(
  v: unknown,
  unitCount: number,
): v is StoryAnalysisState {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<StoryAnalysisState>;
  return (
    Array.isArray(s.registry) &&
    Array.isArray(s.events) &&
    Array.isArray(s.chapterSummaries) &&
    typeof s.nextChapterIndex === "number" &&
    s.nextChapterIndex <= unitCount
  );
}

/**
 * Sequential story-read analysis: ONE task spans the whole manuscript.
 * Chapters are read in order carrying an entity registry + story-so-far
 * (storyAnalysis.ts), which fixes the two failure modes of the old parallel
 * pipeline — duplicate/split entities and scrambled timelines. Progress is
 * per chapter; a checkpoint is persisted after every chapter so cancel/crash
 * + retry resumes instead of restarting.
 */
async function processStoryAnalysisJob(
  job: JobData,
  ac: AbortController,
): Promise<void> {
  const { taskId, model } = job;
  const units: EditUnit[] =
    job.units && job.units.length > 0
      ? job.units
      : [{ name: job.name, original: job.original }];

  updateTask(taskId, {
    status: "editing",
    startedAt: Date.now(),
    phase: "preparing story read",
  });

  try {
    await ensureModelLoaded(model, undefined, 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Queue] preload of ${model} failed: ${msg}`);
  }

  const resume = isUsableCheckpoint(job.resumeState, units.length)
    ? job.resumeState
    : undefined;
  if (resume) {
    appendLog({
      level: "info",
      source: "task",
      taskId,
      message: `Story analysis: resuming at chapter ${resume.nextChapterIndex + 1}/${units.length}.`,
      model,
    });
  }

  try {
    const { structuredData } = await runStoryAnalysis(units, {
      llm: makeStoryLlm(job, ac),
      styleGuide: job.styleGuide,
      manuscriptLang: job.manuscriptLang,
      signal: ac.signal,
      resumeFrom: resume,
      onProgress: (done, total, label) => {
        updateTask(taskId, {
          phase:
            done >= total
              ? "synthesizing story"
              : `reading chapter ${done + 1}/${total} — ${label}`,
        });
        updateProgress(taskId, Math.min(0.97, done / (total + 1)));
      },
      onCheckpoint: (state) => {
        const t = tasks.get(taskId);
        if (!t) return;
        t.analysisCheckpoint = structuredClone(state);
        try {
          saveTaskState(t); // survive a process crash mid-run
        } catch {
          /* checkpoint persistence is best-effort */
        }
      },
    });

    abortControllers.delete(taskId);
    updateTask(taskId, {
      status: "done",
      progress: 1,
      finishedAt: Date.now(),
      result: {
        editedText: "",
        originalText: "",
        corrections: [],
        skipped: [],
        errors: [],
        structuredData,
      },
    });
    maybeSpawnAnalysisSummary(job);
  } catch (err) {
    abortControllers.delete(taskId);
    const msg = err instanceof Error ? err.message : String(err);
    const cancelled = ac.signal.aborted || /cancelled/i.test(msg);
    // The checkpoint stays on the task (and in the DB), so retrying this
    // task resumes from the last completed chapter.
    updateTask(taskId, {
      status: cancelled ? "cancelled" : "error",
      progress: 1,
      finishedAt: Date.now(),
      result: {
        editedText: "",
        originalText: "",
        corrections: [],
        skipped: [],
        errors: [cancelled ? "cancelled" : msg],
        structuredData: null,
      },
    });
  }
}

/**
 * Developmental edit: ONE task spans the whole manuscript. Runs the sequential
 * story read (reusing its checkpoint so cancel/crash + retry resumes mid-read),
 * then a single developmental synthesis pass. The Markdown report is stored as
 * editedText and the structured read as structuredData.
 */
async function processDevelopmentalEditJob(
  job: JobData,
  ac: AbortController,
): Promise<void> {
  const { taskId, model } = job;
  const units: EditUnit[] =
    job.units && job.units.length > 0
      ? job.units
      : [{ name: job.name, original: job.original }];

  updateTask(taskId, {
    status: "editing",
    startedAt: Date.now(),
    phase: "reading manuscript",
  });

  try {
    await ensureModelLoaded(model, undefined, 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Queue] preload of ${model} failed: ${msg}`);
  }

  const resume = isUsableCheckpoint(job.resumeState, units.length)
    ? job.resumeState
    : undefined;
  if (resume) {
    appendLog({
      level: "info",
      source: "task",
      taskId,
      message: `Developmental edit: resuming at chapter ${resume.nextChapterIndex + 1}/${units.length}.`,
      model,
    });
  }

  try {
    const { report, structuredData } = await runDevelopmentalEdit(units, {
      llm: makeStoryLlm(job, ac),
      styleGuide: job.styleGuide,
      manuscriptLang: job.manuscriptLang,
      signal: ac.signal,
      resumeFrom: resume,
      onProgress: (done, total, label) => {
        updateTask(taskId, {
          phase:
            done >= total
              ? "writing developmental report"
              : `reading chapter ${done + 1}/${total} — ${label}`,
        });
        updateProgress(taskId, Math.min(0.97, done / (total + 1)));
      },
      onCheckpoint: (state) => {
        const t = tasks.get(taskId);
        if (!t) return;
        t.analysisCheckpoint = structuredClone(state);
        try {
          saveTaskState(t); // survive a process crash mid-run
        } catch {
          /* checkpoint persistence is best-effort */
        }
      },
    });

    abortControllers.delete(taskId);
    updateTask(taskId, {
      status: "done",
      progress: 1,
      finishedAt: Date.now(),
      result: {
        editedText: stripAiSignoff(report),
        originalText: "",
        corrections: [],
        skipped: [],
        errors: [],
        structuredData,
      },
    });
  } catch (err) {
    abortControllers.delete(taskId);
    const msg = err instanceof Error ? err.message : String(err);
    const cancelled = ac.signal.aborted || /cancelled/i.test(msg);
    // The read checkpoint stays on the task, so retrying resumes the read.
    updateTask(taskId, {
      status: cancelled ? "cancelled" : "error",
      progress: 1,
      finishedAt: Date.now(),
      result: {
        editedText: "",
        originalText: "",
        corrections: [],
        skipped: [],
        errors: [cancelled ? "cancelled" : msg],
        structuredData: null,
      },
    });
  }
}

/** Minimal shape check before trusting a persisted evaluator checkpoint. */
function isUsableTextEvalCheckpoint(v: unknown): v is TextEvaluatorState {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<TextEvaluatorState>;
  return (
    Array.isArray(s.passages) &&
    Array.isArray(s.observations) &&
    typeof s.nextPassageIndex === "number" &&
    s.nextPassageIndex <= s.passages.length
  );
}

/**
 * Text evaluator: ONE task spans the whole manuscript. Passages sampled
 * across the selected chapters are critiqued one by one (textEvaluator.ts),
 * then a single narrative writing report is synthesized. A checkpoint is
 * persisted after every passage so cancel/crash + retry resumes. The optional
 * corrections digest (post-edit variant) feeds the "recurring habits" section.
 */
async function processTextEvaluatorJob(
  job: JobData,
  ac: AbortController,
): Promise<void> {
  const { taskId, model } = job;
  const units: EditUnit[] =
    job.units && job.units.length > 0
      ? job.units
      : [{ name: job.name, original: job.original }];

  updateTask(taskId, {
    status: "editing",
    startedAt: Date.now(),
    phase: "sampling passages",
  });

  try {
    await ensureModelLoaded(model, undefined, 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Queue] preload of ${model} failed: ${msg}`);
  }

  const resume = isUsableTextEvalCheckpoint(job.resumeState)
    ? job.resumeState
    : undefined;
  if (resume) {
    appendLog({
      level: "info",
      source: "task",
      taskId,
      message: `Writing report: resuming at passage ${resume.nextPassageIndex + 1}/${resume.passages.length}.`,
      model,
    });
  }

  try {
    const { report, structuredData } = await runTextEvaluation(units, {
      llm: makeStoryLlm(job, ac),
      styleGuide: job.styleGuide,
      manuscriptLang: job.manuscriptLang,
      correctionsDigest: job.correctionsDigest,
      signal: ac.signal,
      resumeFrom: resume,
      onProgress: (done, total, label) => {
        updateTask(taskId, {
          phase:
            done >= total - 1
              ? "writing report"
              : `critiquing passage ${done + 1}/${total - 1} — ${label}`,
        });
        updateProgress(taskId, Math.min(0.97, done / total));
      },
      onCheckpoint: (state) => {
        const t = tasks.get(taskId);
        if (!t) return;
        t.analysisCheckpoint = structuredClone(state);
        try {
          saveTaskState(t); // survive a process crash mid-run
        } catch {
          /* checkpoint persistence is best-effort */
        }
      },
    });

    abortControllers.delete(taskId);
    updateTask(taskId, {
      status: "done",
      progress: 1,
      finishedAt: Date.now(),
      result: {
        editedText: stripAiSignoff(report),
        originalText: "",
        corrections: [],
        skipped: [],
        errors: [],
        structuredData,
      },
    });
  } catch (err) {
    abortControllers.delete(taskId);
    const msg = err instanceof Error ? err.message : String(err);
    const cancelled = ac.signal.aborted || /cancelled/i.test(msg);
    // The checkpoint stays on the task (and in the DB), so retrying this
    // task resumes from the last completed passage.
    updateTask(taskId, {
      status: cancelled ? "cancelled" : "error",
      progress: 1,
      finishedAt: Date.now(),
      result: {
        editedText: "",
        originalText: "",
        corrections: [],
        skipped: [],
        errors: [cancelled ? "cancelled" : msg],
        structuredData: null,
      },
    });
  }
}

// Publication readiness scan: a deterministic, whole-manuscript structural
// check (no LLM). Runs instantly over all chapters and stores a findings report
// in structuredData, exactly like the analysis path.
async function processPublicationScanJob(
  job: JobData,
  ac: AbortController,
): Promise<void> {
  const { taskId } = job;
  const units: EditUnit[] =
    job.units && job.units.length > 0
      ? job.units
      : [{ name: job.name, original: job.original }];

  updateTask(taskId, {
    status: "editing",
    startedAt: Date.now(),
    phase: "scanning structure",
  });

  try {
    const report = buildPublicationScan(
      units.map((u) => ({ name: u.name, original: u.original })),
    );
    abortControllers.delete(taskId);
    updateTask(taskId, {
      status: "done",
      progress: 1,
      finishedAt: Date.now(),
      result: {
        editedText: "",
        originalText: "",
        corrections: [],
        skipped: [],
        errors: [],
        structuredData: report,
      },
    });
  } catch (err) {
    abortControllers.delete(taskId);
    const msg = err instanceof Error ? err.message : String(err);
    const cancelled = ac.signal.aborted || /cancelled/i.test(msg);
    updateTask(taskId, {
      status: cancelled ? "cancelled" : "error",
      progress: 1,
      finishedAt: Date.now(),
      result: {
        editedText: "",
        originalText: "",
        corrections: [],
        skipped: [],
        errors: [cancelled ? "cancelled" : msg],
        structuredData: null,
      },
    });
  }
}

async function processJob(job: JobData): Promise<void> {
  const {
    taskId,
    original,
    model,
    mode,
    prompt,
    wpc,
    overlap,
    editOptions,
  } = job;
  const ac = new AbortController();
  abortControllers.set(taskId, ac);

  // Analysis modes: sequential story-read over the whole manuscript
  // (entity registry + story-so-far carried between chapters).
  if (ANALYSIS_MODES.includes(mode)) {
    return processStoryAnalysisJob(job, ac);
  }
  if (mode === "analysis_summary" || mode === "blurb") {
    return processSynthesisJob(job, ac);
  }
  if (mode === "text_evaluator") {
    return processTextEvaluatorJob(job, ac);
  }
  if (mode === "developmental_edit") {
    return processDevelopmentalEditJob(job, ac);
  }
  if (mode === "publication_scan") {
    return processPublicationScanJob(job, ac);
  }

  // Edits always run corrections-mode (discrete {original,corrected} pairs).
  // Translation is the only mode that rewrites the whole chunk — it inherently
  // replaces the entire text (source → target language).
  const isCorrectionsMode = mode !== "translate";

  // Spell-safety validator — blocks any correction that would inject a new
  // non-word (e.g. "Apparently" → "Appwrently"). Uses the manuscript's
  // language dictionary (English + dialect by default); undefined when the
  // dictionary can't be loaded (e.g. unsupported language) or the mode never
  // applies corrections.
  let isAcceptableWord: ((word: string) => boolean) | undefined;
  // Post-apply safety net: reports dictionary-rejected words that applying
  // corrections *introduced* into a chunk, so the offending corrections can
  // be reverted and flagged. Same language/dialect as the validator; null
  // from findNewSuspectWords (no dictionary) degrades to no verification.
  let findNewSuspects:
    | ((before: string, after: string) => string[] | null)
    | undefined;
  if (isCorrectionsMode) {
    const { getWordValidator, findNewSuspectWords } = await import(
      "./spellcheck.js"
    );
    const editDialect = (editOptions as Record<string, unknown>)
      ?.englishDialect as string | undefined;
    const spellOpts = {
      englishDialect: editDialect,
      styleGuideNames: job.styleGuide ? [job.styleGuide] : undefined,
    };
    const spellGateLang = job.manuscriptLang ?? "en";
    isAcceptableWord = getWordValidator(spellGateLang, spellOpts) ?? undefined;
    findNewSuspects = (before: string, after: string) =>
      findNewSuspectWords(before, after, spellGateLang, spellOpts);
  }

  const jobStart = performance.now();
  let totalOutTokens = 0;
  let _dualMergedCorrections: Correction[] | null = null;

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

  const errors: string[] = [];
  let totalChunks = 0;

  // One full editor(+reviewer) pass over `sourceText`. Extracted as a closure
  // so thorough mode can run the identical pipeline a second time over the
  // first pass's output (with copy-edit prompts). Returns null when the job
  // is cancelled mid-pass. `pass.mode`/`pass.prompt` shadow the job-level
  // ones so the body below reads exactly as it did pre-extraction.
  const runCorrectionPass = async (
    sourceText: string,
    pass: {
      n: number;
      total: number;
      progressBase: number;
      progressSpan: number;
      mode: TaskMode;
      prompt: string;
    },
  ): Promise<{
    text: string;
    corrections: Correction[];
    skipped: Correction[];
  } | null> => {
    const { mode, prompt } = pass;
    const passPrefix = pass.total > 1 ? `pass ${pass.n}/${pass.total} — ` : "";
    const chunks = splitIntoChunks(sourceText, wpc, overlap);
    totalChunks += chunks.length;
    updateTask(taskId, { phase: `${passPrefix}0/${chunks.length} chunks` });

    const pieces: string[] = [];
    const corrections: Correction[] = [];
    const skipped: Correction[] = [];

    // Pending reviewer state: the reviewer for the *previous* chunk runs in
    // parallel with the *current* chunk's editor, hiding the reviewer's
    // latency behind the next prefill+decode.
    let pendingReview: {
      cs: Correction[];
      chunk: { body: string; core: string; overlapHeadParagraphs: number };
      chunkLabel: string;
      spellCorrections: Correction[];
      editorAcc: string;
      editorToks: number;
      editorStart: number;
      editorFirstTokenAt: number;
      promise: Promise<string[]>;
    } | null = null;

    async function collectPendingReview(): Promise<void> {
      if (!pendingReview) return;
      const pr = pendingReview;
      pendingReview = null;
      try {
        const reviewOutputs = await pr.promise;
        const threshold = job.reviewerThreshold ?? 3;

        // Merge scores from all reviewer agents:
        // each correction gets the MINIMUM confidence across reviewers.
        // If ANY reviewer flags it, it gets flagged. Corrections no reviewer
        // scored are flagged as unvetted rather than passed through.
        const allScores = reviewOutputs.map((output) => parseReviewScores(output));
        const { flaggedCount, unscoredCount } = aggregateReviewScores(
          pr.cs,
          allScores,
          threshold,
        );

        if (unscoredCount > 0) {
          appendLog({
            level: "warn",
            source: "engine",
            taskId,
            message: `Reviewer left ${unscoredCount}/${pr.cs.length} corrections unscored in chunk ${pr.chunkLabel}; they are flagged for manual review.`,
            model,
          });
        }
        appendLog({
          level: "info",
          source: "engine",
          taskId,
          message: flaggedCount > 0
            ? `Reviewer flagged ${flaggedCount}/${pr.cs.length} corrections in chunk ${pr.chunkLabel} (confidence < ${threshold}, ${reviewOutputs.length} agents).`
            : `Reviewer passed all ${pr.cs.length} corrections in chunk ${pr.chunkLabel} (${reviewOutputs.length} agents).`,
          model,
        });

        const toApply = pr.cs.filter((c) => !c.flagged);
        const flagged = pr.cs.filter((c) => c.flagged);

        // Spell-check and editor corrections are applied together so spell fixes
        // also get position-safe, word-boundary-aware splicing (not raw replaceAll).
        const [newBody, applied, sk, reverted] = applyCorrectionsVerified(
          pr.chunk.body,
          toApply,
          {
            allowDialogueTags: editOptions?.dialogueTags === true,
            isAcceptableWord,
            findNewSuspects,
          },
        );

        if (reverted.length > 0) {
          appendLog({
            level: "warn",
            source: "engine",
            taskId,
            message: `Post-apply spell check reverted ${reverted.length} correction(s) in chunk ${pr.chunkLabel} that introduced misspellings; they are flagged for manual review.`,
            model,
          });
        }

        const core = stripOverlapFromResponse(
          newBody,
          pr.chunk.overlapHeadParagraphs,
        );

        for (const c of applied) {
          corrections.push({
            ...c,
            chunk: `Chunk ${pr.chunkLabel}`,
            id: uuidv4(),
          });
        }
        for (const c of [...flagged, ...reverted]) {
          corrections.push({
            ...c,
            chunk: `Chunk ${pr.chunkLabel}`,
            id: uuidv4(),
          });
        }
        skipped.push(
          ...sk.map((s) => ({ ...s, chunk: `Chunk ${pr.chunkLabel}` })),
        );
        pieces.push(core);
      } catch (err) {
        // Reviewer exhausted its retries. Applying unvetted corrections is how
        // corrupted text reaches the manuscript, so apply NOTHING: keep the
        // chunk text unchanged and surface every correction as flagged so the
        // user can accept/dismiss them manually. Deliberately not pushed to
        // errors[] — the result is usable, the task stays "done".
        appendLog({
          level: "warn",
          source: "engine",
          taskId,
          message: `Reviewer failed for chunk ${pr.chunkLabel} after retries: ${err instanceof Error ? err.message : String(err)}. ${pr.cs.length} corrections flagged for manual review — none auto-applied.`,
          model,
        });

        for (const c of pr.cs) {
          corrections.push({
            ...c,
            flagged: true,
            reviewReason: "reviewer unavailable — not auto-applied",
            chunk: `Chunk ${pr.chunkLabel}`,
            id: uuidv4(),
          });
        }
        pieces.push(pr.chunk.core);
      }
    }

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
        return null;
      }

      const chunk = chunks[j];
      const chunkLabel =
        pass.n > 1
          ? `${j + 1}/${chunks.length} (pass ${pass.n})`
          : `${j + 1}/${chunks.length}`;
      let acc = "";
      let tokCount = 0;
      const chunkStart = performance.now();
      let firstTokenAt = 0;
      let spellCorrections: Correction[] = [];
      // Editor system prompt for THIS chunk: the job-level prompt plus any
      // per-chunk spell-check hints (see the spell block below). Deterministic
      // detection (Hunspell) feeds the LLM the words to fix in context.
      let chunkPrompt = prompt;

      // ── Collect previous chunk's reviewer result ──
      // The reviewer for chunk (j-1) ran in parallel with chunk j's editor.
      if (pendingReview) await collectPendingReview();

      try {
        const MAX_ATTEMPTS = 5;
        let lastErr: unknown = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          if (ac.signal.aborted) throw new Error("cancelled");
          acc = "";
          tokCount = 0;
          firstTokenAt = 0;
          _dualMergedCorrections = null;
          chunkPrompt = prompt;
          const phasePrefix = attempt === 1 ? "" : `retry ${attempt - 1} — `;
          try {
            updateTask(taskId, {
              phase: `${phasePrefix}processing chunk ${chunkLabel}`,
            });

            if (isCorrectionsMode) {
              // ── Spell-check: generate explicit corrections (not hints) ──
              spellCorrections = [];
              if (job.spellCheck) {
                const { getSpellCorrections } = await import("./spellcheck.js");
                const dialect = (job.editOptions as Record<string, unknown>)?.englishDialect as string | undefined;
                const chunkLang = job.manuscriptLang ?? "en";
                // Unsupported languages (no dictionary) yield [] — spell-check
                // is silently skipped rather than run against English.
                const spellLang =
                  chunkLang === "en"
                    ? dialect === "british"
                      ? "en_GB"
                      : "en_US"
                    : chunkLang;
                // No cap: surface every misspelling in the chunk. Pass the
                // style sheet so listed character/place names aren't flagged.
                spellCorrections = getSpellCorrections(chunk.body, spellLang, {
                  styleGuideNames: job.styleGuide ? [job.styleGuide] : undefined,
                });
                if (spellCorrections.length > 0) {
                  appendLog({
                    level: "info",
                    source: "engine",
                    taskId,
                    message: `Spell-check produced ${spellCorrections.length} corrections in chunk ${chunkLabel}`,
                    model,
                  });
                }

                // Also feed the detected suspects to the LLM editor as hints:
                // Hunspell's own top suggestion is unreliable ("teh"→"ten"),
                // but the LLM fixes the same words correctly in context. This
                // pairs deterministic detection with in-context correction.
                const { findSuspectWords } = await import("./spellcheck.js");
                const { suspectWords } = findSuspectWords(chunk.body, spellLang, {
                  styleGuideNames: job.styleGuide ? [job.styleGuide] : undefined,
                });
                if (suspectWords.length > 0) {
                  chunkPrompt = prompt + buildSpellHintBlock(suspectWords);
                }
              }

              // ── retext: deterministic prose checks (a/an, contractions,
              // doubled words, redundant acronyms, sentence spacing). English
              // only; merges into the deterministic bucket alongside spelling.
              if (job.retextCheck) {
                const { getRetextCorrections } = await import(
                  "./retextChecks.js"
                );
                const retextCs = await getRetextCorrections(
                  chunk.body,
                  job.manuscriptLang ?? "en",
                );
                if (retextCs.length > 0) {
                  spellCorrections = [...spellCorrections, ...retextCs];
                  appendLog({
                    level: "info",
                    source: "engine",
                    taskId,
                    message: `retext produced ${retextCs.length} corrections in chunk ${chunkLabel}`,
                    model,
                  });
                }
              }

              // ── LanguageTool: grammar/punctuation via a local server. Runs
              // only when available (jar + Java bundled); degrades to a no-op
              // otherwise. A failure here must never break the chunk.
              if (job.grammarCheck) {
                try {
                  const { checkText, INTRODUCTORY_COMMA_RULES } = await import(
                    "./languageTool.js"
                  );
                  const eo = job.editOptions as Record<string, unknown>;
                  const dialect = eo?.englishDialect as string | undefined;
                  // Match the LLM: when the introductory-comma option is off,
                  // silence LanguageTool's intro-comma rules too.
                  const disabledRules =
                    eo?.introductoryComma === true
                      ? []
                      : INTRODUCTORY_COMMA_RULES;
                  const grammarCs = await checkText(chunk.body, {
                    lang: job.manuscriptLang ?? "en",
                    dialect,
                    disabledRules,
                    signal: ac.signal,
                  });
                  if (grammarCs.length > 0) {
                    spellCorrections = [...spellCorrections, ...grammarCs];
                    appendLog({
                      level: "info",
                      source: "engine",
                      taskId,
                      message: `LanguageTool produced ${grammarCs.length} corrections in chunk ${chunkLabel}`,
                      model,
                    });
                  }
                } catch (err) {
                  if (ac.signal.aborted) throw err;
                  appendLog({
                    level: "warn",
                    source: "engine",
                    taskId,
                    message: `LanguageTool check failed for chunk ${chunkLabel}: ${err instanceof Error ? err.message : String(err)}. Grammar suggestions skipped for this chunk.`,
                    model,
                  });
                }
              }

              // ── Dialect: deterministic British↔American normalization ──
              // The prompt's "convert known pairs" instruction is unreliable
              // (LLMs miss occurrences); this pass catches every curated pair
              // mechanically. English manuscripts with a dialect setting only.
              {
                const dialectOpt = (job.editOptions as Record<string, unknown>)
                  ?.englishDialect as "american" | "british" | undefined;
                if (
                  (job.manuscriptLang ?? "en") === "en" &&
                  (dialectOpt === "american" || dialectOpt === "british") &&
                  (mode === "copy_edit" || mode === "combined_edit")
                ) {
                  const { getDialectCorrections } = await import(
                    "./dialect.js"
                  );
                  const dialectCorrections = getDialectCorrections(
                    chunk.body,
                    dialectOpt,
                    {
                      styleGuideNames: job.styleGuide
                        ? [job.styleGuide]
                        : undefined,
                    },
                  );
                  for (const dc of dialectCorrections) dc.reason = "dialect";
                  if (dialectCorrections.length > 0) {
                    appendLog({
                      level: "info",
                      source: "engine",
                      taskId,
                      message: `Dialect pass (${dialectOpt}) produced ${dialectCorrections.length} corrections in chunk ${chunkLabel}`,
                      model,
                    });
                    spellCorrections = [
                      ...dialectCorrections,
                      ...spellCorrections,
                    ];
                  }
                }
              }

              // ── Run editor(s) — single or multi ──
              // The normal editor prompt runs `baseEditorCount` times; when a
              // style sheet is present and the toggle is on, one extra agent runs
              // the dedicated style-compliance pass. Its corrections merge into
              // the same union-deduped set as the regular editors.
              const baseEditorCount = job.dualEditor ? (job.dualCount ?? 2) : 1;
              const styleAgentActive = !!(
                job.styleComplianceAgent &&
                job.styleGuide &&
                job.styleGuide.trim()
              );
              const editorPrompts: string[] = Array.from(
                { length: baseEditorCount },
                () => chunkPrompt,
              );
              if (styleAgentActive) {
                editorPrompts.push(
                  buildStyleCompliancePrompt(
                    job.styleGuide!,
                    mode,
                    job.manuscriptLang,
                  ),
                );
              }
              const editorCount = editorPrompts.length;
              if (editorCount > 1) {
                updateTask(taskId, {
                  phase: `${phasePrefix}editing chunk ${chunkLabel} (${editorCount} agents${styleAgentActive ? ", incl. style-sheet" : ""})`,
                });

                // Collect N editor streams in parallel. Record the earliest
                // first-token arrival across all agents so prefill/decode timing
                // is real (not measured after Promise.allSettled has already
                // joined every finished stream).
                let dualFirstTokenAt = 0;
                const collectStream = async (promptText: string) => {
                  let a = "";
                  for await (const t of findCorrectionsStream(model, chunk.body, promptText, ac.signal)) {
                    if (dualFirstTokenAt === 0) dualFirstTokenAt = performance.now();
                    a += t;
                  }
                  return a;
                };

                const promises = editorPrompts.map((pr) => collectStream(pr));
                const results = await Promise.allSettled(promises);

                // Build raw values per agent.
                let raws: string[] = [];
                const DUAL_RETRIES = 2;

                for (let idx = 0; idx < editorCount; idx++) {
                  const r = results[idx];
                  if (r.status === "fulfilled") {
                    raws.push(r.value);
                  } else {
                    const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
                    appendLog({
                      level: "warn",
                      source: "engine",
                      taskId,
                      message: `Editor agent ${idx + 1}/${editorCount} failed for chunk ${chunkLabel} (${reason}). Retrying…`,
                      model,
                    });

                    let retried = false;
                    for (let rt = 1; rt <= DUAL_RETRIES; rt++) {
                      try {
                        const val = await collectStream(editorPrompts[idx]);
                        raws.push(val);
                        retried = true;
                        appendLog({
                          level: "info",
                          source: "engine",
                          taskId,
                          message: `Editor agent ${idx + 1}/${editorCount} retry ${rt} succeeded for chunk ${chunkLabel}.`,
                          model,
                        });
                        break;
                      } catch (retryErr) {
                        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                        appendLog({
                          level: "warn",
                          source: "engine",
                          taskId,
                          message: `Editor agent ${idx + 1}/${editorCount} retry ${rt}/${DUAL_RETRIES} failed for chunk ${chunkLabel}: ${retryMsg}`,
                          model,
                        });
                      }
                    }
                    if (!retried) {
                      appendLog({
                        level: "warn",
                        source: "engine",
                        taskId,
                        message: `Editor agent ${idx + 1}/${editorCount} exhausted retries for chunk ${chunkLabel}.`,
                        model,
                      });
                      // Surface degraded results: this chunk ran with fewer
                      // editors than requested. Recorded on the task so the run
                      // doesn't silently report success with missing agents.
                      errors.push(
                        `chunk ${chunkLabel}: editor agent ${idx + 1}/${editorCount} failed after retries`,
                      );
                    }
                  }
                }

                if (raws.length === 0) {
                  throw new Error(`All ${editorCount} editor agents failed for chunk ${chunkLabel}`);
                }

                acc = raws.filter(Boolean).join("\n");
                if (dualFirstTokenAt > 0) firstTokenAt = dualFirstTokenAt;

                // Union-dedupe all correction sets by (original, corrected)
                const parseAll = (raw: string) => {
                  const parsed = parseCorrectionsJson(raw);
                  const out: Correction[] = [];
                  const seen = new Set<string>();
                  for (const c of parsed) {
                    const k = JSON.stringify([c.original, c.corrected]);
                    if (!seen.has(k)) { seen.add(k); out.push(c); }
                  }
                  return out;
                };
                const allCs = raws.flatMap((r) => parseAll(r));
                const merged: Correction[] = [];
                const seen = new Set<string>();
                for (const c of allCs) {
                  const k = JSON.stringify([c.original, c.corrected]);
                  if (!seen.has(k)) { seen.add(k); merged.push(c); }
                }
                _dualMergedCorrections = merged;
                // Aggregate output-token estimate across all parallel agents.
                // Paired with the real first-token time above this yields an
                // honest aggregate decode throughput (tokens / wall-clock).
                if (firstTokenAt > 0) tokCount = estimateTokens(acc);
              } else {
                for await (const tok of findCorrectionsStream(
                  model,
                  chunk.body,
                  chunkPrompt,
                  ac.signal,
                )) {
                acc += tok;
                tokCount++;
                if (tokCount === 1) {
                  firstTokenAt = performance.now();
                  updateTask(taskId, {
                    phase: `${phasePrefix}chunk ${chunkLabel}`,
                  });
                }
                // Live tok/s every 20 tokens
                if (tokCount > 1 && tokCount % 20 === 0 && firstTokenAt > 0) {
                  const elapsed = performance.now() - firstTokenAt;
                  if (elapsed > 0) {
                    updateTask(taskId, {
                      tokPerSec: ((tokCount - 1) / (elapsed / 1000)).toFixed(1),
                    });
                  }
                }
                const intra = creepingProgress(tokCount);
                updateProgress(taskId, (j + intra) / chunks.length);
              }
              }
            } else {
              // ── Single rewrite agent ──
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
                    phase: `${phasePrefix}chunk ${chunkLabel}`,
                  });
                }
                // Live tok/s every 20 tokens
                if (tokCount > 1 && tokCount % 20 === 0 && firstTokenAt > 0) {
                  const elapsed = performance.now() - firstTokenAt;
                  if (elapsed > 0) {
                    updateTask(taskId, {
                      tokPerSec: ((tokCount - 1) / (elapsed / 1000)).toFixed(1),
                    });
                  }
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

        if (isCorrectionsMode) {
          updateTask(taskId, { phase: `writing up corrections` });
          const editorCsRaw: Correction[] = _dualMergedCorrections ?? parseCorrectionsJson(acc);
          const isDual = _dualMergedCorrections !== null;
          _dualMergedCorrections = null;

          // ── Quote hygiene ──
          // The model regularly re-quotes dialogue whose quotation marks sit
          // just outside its "original" span — often in the other style —
          // which would splice doubled quotes (“"…"”) into the text. Strip
          // duplicated edge quotes, match added quotes to the manuscript's
          // style, and drop corrections that had nothing else to say.
          const quoteSan = sanitizeQuoteCorrections(chunk.body, editorCsRaw);
          if (quoteSan.dropped.length > 0 || quoteSan.adjusted > 0) {
            skipped.push(...quoteSan.dropped);
            appendLog({
              level: "info",
              source: "engine",
              taskId,
              message: `Chunk ${chunkLabel}: quote hygiene — ${quoteSan.adjusted} correction(s) restyled, ${quoteSan.dropped.length} dropped (would duplicate existing quotation marks).`,
              model,
            });
          }

          // ── Contained-correction folding ──
          // A word fix inside a sentence rewrite would collide with it at
          // apply time; merge it into the rewrite and drop the duplicate.
          const fold = foldContainedCorrections(chunk.body, quoteSan.kept);
          const editorCs = fold.kept;
          if (fold.dropped.length > 0 || fold.folded > 0) {
            skipped.push(...fold.dropped);
            appendLog({
              level: "info",
              source: "engine",
              taskId,
              message: `Chunk ${chunkLabel}: ${fold.dropped.length} smaller correction(s) merged into overlapping rewrites (${fold.folded} rewrite(s) absorbed a contained fix).`,
              model,
            });
          }

          // Merge deterministic corrections (spell-check + dialect, the
          // latter pre-tagged "dialect") with editor corrections. Spell fixes
          // an editor independently confirmed are pre-approved (bypass the
          // reviewer) and their editor duplicate is dropped.
          const dedupedEditorCs = reconcileSpellWithEditor(
            spellCorrections,
            editorCs,
          );
          for (const sc of spellCorrections) {
            sc.reason ??= "spell-check";
          }
          const cs: Correction[] = [...spellCorrections, ...dedupedEditorCs];

          // Corrections are emitted as JSONL (one JSON object per line), so
          // truncation only ever drops the final partial line. No retry needed.
          // Just note when the response was likely cut off so users can spot
          // chunks where a few late corrections may have been lost.
          const trimmedAcc = acc.trim();
          const looksTruncated =
            !isDual &&
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

          // If reviewMode is on, start a second LLM pass (reviewer) in the
          // BACKGROUND. It will run in parallel with the *next* chunk's editor.
          // When the next chunk's editor completes, the reviewer verdict is
          // collected and corrections are applied (see "collect previous chunk's
          // reviewer result" at the top of the loop). For the last chunk, the
          // reviewer is collected after the loop.
          if (job.reviewMode && cs.length > 0) {
            const reviewerPrompt = buildReviewerPrompt(
              job.styleGuide,
              mode,
              job.manuscriptLang,
            );
            const rCount = job.reviewerCount ?? 1;

            const reviewPromise = (async () => {
              const runOne = () =>
                runReviewerAgentWithRetry({
                  model,
                  chunkText: chunk.body,
                  cs,
                  reviewerPrompt,
                  signal: ac.signal,
                  taskId,
                  chunkLabel,
                  agentLabel: "Reviewer agent",
                });
              const results = await Promise.allSettled(
                Array.from({ length: rCount }, () => runOne()),
              );
              const outputs: string[] = [];
              for (const r of results) {
                if (r.status === "fulfilled" && r.value) outputs.push(r.value);
              }
              if (outputs.length === 0)
                throw new Error(
                  `All ${rCount} reviewer agents failed after ${REVIEWER_MAX_ATTEMPTS} attempts each`,
                );
              if (outputs.length < rCount) {
                // Survivors still vet every correction (min-confidence merge), so
                // this is a warning, not a task error — unscored corrections are
                // flagged by aggregateReviewScores either way.
                appendLog({
                  level: "warn",
                  source: "engine",
                  taskId,
                  message: `Only ${outputs.length}/${rCount} reviewer agents contributed for chunk ${chunkLabel}; scoring on survivors.`,
                  model,
                });
              }
              return outputs;
            })();

            pendingReview = {
              cs: [...cs],
              chunk,
              chunkLabel,
              spellCorrections: [...spellCorrections],
              editorAcc: acc,
              editorToks: tokCount,
              editorStart: chunkStart,
              editorFirstTokenAt: firstTokenAt,
              promise: reviewPromise,
            };
          } else {
            // No reviewer — apply corrections immediately. Because no reviewer
            // vetted them, real-word→real-word swaps in a copy edit (e.g.
            // "form"→"from") are surfaced as flagged rather than auto-applied, so
            // a possible silent corruption is shown for manual confirmation.
            const toApply: Correction[] = [];
            const flaggedSwaps: Correction[] = [];
            const flagSwaps = mode === "copy_edit" && !!isAcceptableWord;
            for (const c of cs) {
              if (
                flagSwaps &&
                isRealWordSwap(c.original, c.corrected, isAcceptableWord!)
              ) {
                flaggedSwaps.push({
                  ...c,
                  flagged: true,
                  reviewReason: "word substitution — verify",
                });
              } else {
                toApply.push(c);
              }
            }

            const [newBody, applied, sk, reverted] = applyCorrectionsVerified(
              chunk.body,
              toApply,
              {
                allowDialogueTags: editOptions?.dialogueTags === true,
                isAcceptableWord,
                findNewSuspects,
              },
            );

            if (reverted.length > 0) {
              appendLog({
                level: "warn",
                source: "engine",
                taskId,
                message: `Post-apply spell check reverted ${reverted.length} correction(s) in chunk ${chunkLabel} that introduced misspellings; they are flagged for manual review.`,
                model,
              });
            }

            const core = stripOverlapFromResponse(
              newBody,
              chunk.overlapHeadParagraphs,
            );

            for (const c of [...applied, ...flaggedSwaps, ...reverted]) {
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
          }
        } else {
          const rewritten = restoreTypography(chunk.body, acc.trim());

          // Translation: output the rewritten text directly. Running
          // diff → corrections → apply makes no sense for translation
          // (the entire text is "changed" source → target language), and
          // the reviewer would flag every word as "changing meaning".
          if (mode === "translate") {
            let translatedText = rewritten;

            if (job.reviewMode) {
              // Split into paragraphs and pair them for review
              const srcParas = srcParasForReview(chunk.body);
              const tgtParas = tgtParasForReview(translatedText);
              const n = Math.min(srcParas.length, tgtParas.length);

              if (n > 1) {
                const paraCorrections: Correction[] = srcParas
                  .slice(0, n)
                  .map((src, i) => ({
                    original: src,
                    corrected: tgtParas[i],
                  }));

                updateTask(taskId, {
                  phase: `reviewing translation for chunk ${chunkLabel}`,
                });

                const reviewerPrompt = buildTranslationReviewerPrompt(job.styleGuide);
                const rCount = job.reviewerCount ?? 1;
                const runOne = () =>
                  runReviewerAgentWithRetry({
                    model,
                    chunkText: chunk.body,
                    cs: paraCorrections,
                    reviewerPrompt,
                    signal: ac.signal,
                    taskId,
                    chunkLabel,
                    agentLabel: "Rewrite-reviewer agent",
                  });
                const reviewResults = await Promise.allSettled(
                  Array.from({ length: rCount }, () => runOne()),
                );
                const reviewOutputs: string[] = [];
                for (const r of reviewResults) {
                  if (r.status === "fulfilled" && r.value)
                    reviewOutputs.push(r.value);
                }
                if (reviewOutputs.length > 0 && reviewOutputs.length < rCount) {
                  appendLog({
                    level: "warn",
                    source: "engine",
                    taskId,
                    message: `Only ${reviewOutputs.length}/${rCount} rewrite-reviewer agents contributed for chunk ${chunkLabel}; scoring on survivors.`,
                    model,
                  });
                }

                if (reviewOutputs.length > 0) {
                  const allScores = reviewOutputs.map((o) =>
                    parseReviewScores(o),
                  );
                  const threshold = job.reviewerThreshold ?? 3;

                  const flagged: { idx: number; conf: number; reason: string }[] =
                    [];
                  for (let i = 0; i < n; i++) {
                    let minConf = 5;
                    let minReason = "";
                    for (const scores of allScores) {
                      const s = scores.get(i);
                      if (s && s.confidence < minConf) {
                        minConf = s.confidence;
                        minReason = s.reason;
                      }
                    }
                    if (minConf < threshold)
                      flagged.push({ idx: i, conf: minConf, reason: minReason });
                  }

                  if (flagged.length > 0) {
                    appendLog({
                      level: "info",
                      source: "engine",
                      taskId,
                      message: `Translation reviewer flagged ${flagged.length}/${n} paragraphs in chunk ${chunkLabel}. Re-translating…`,
                      model,
                    });

                    const revisedParas = [...tgtParas];
                    for (const f of flagged) {
                      try {
                        const rePrompt =
                          prompt +
                          `\n\nCRITICAL: Your previous translation of this paragraph was flagged: "${f.reason}". Provide an accurate, fluent, natural-feeling translation.`;
                        let reAcc = "";
                        for await (const tok of editChunkStream(
                          model,
                          srcParas[f.idx],
                          rePrompt,
                          ac.signal,
                        )) reAcc += tok;
                        const reTranslated = reAcc.trim();
                        if (reTranslated) {
                          revisedParas[f.idx] = reTranslated;
                          appendLog({
                            level: "info",
                            source: "engine",
                            taskId,
                            message: `Re-translated paragraph ${f.idx + 1}/${n} (was confidence ${f.conf}).`,
                            model,
                          });
                        }
                      } catch (err) {
                        appendLog({
                          level: "warn",
                          source: "engine",
                          taskId,
                          message: `Re-translation of paragraph ${f.idx + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
                          model,
                        });
                      }
                    }
                    translatedText = revisedParas.join("\n\n");
                  } else {
                    appendLog({
                      level: "info",
                      source: "engine",
                      taskId,
                      message: `Translation reviewer passed all ${n} paragraphs in chunk ${chunkLabel}.`,
                      model,
                    });
                  }
                }
              }
            }

            // UPGRADE PASS — monolingual target-language polish + fluency
            // review. Falls back to the accuracy-validated draft on any
            // failure, so this can never regress the plain translation.
            const targetLang = job.targetLang ?? "the target language";
            const upgraded = await runTranslationUpgrade(
              {
                draft: translatedText,
                upgradePrompt: buildTranslationUpgradePrompt(
                  targetLang,
                  job.styleGuide,
                ),
                reviewMode: !!job.reviewMode,
                reviewerCount: job.reviewerCount ?? 1,
                reviewerThreshold: job.reviewerThreshold ?? 3,
                chunkLabel,
                signal: ac.signal,
              },
              {
                editStream: async (text, systemPrompt) => {
                  let out = "";
                  for await (const tok of editChunkStream(
                    model,
                    text,
                    systemPrompt,
                    ac.signal,
                  ))
                    out += tok;
                  return out;
                },
                runReviewer: (draftChunk, pairs) =>
                  runReviewerAgentWithRetry({
                    model,
                    chunkText: draftChunk,
                    cs: pairs,
                    reviewerPrompt: buildFluencyReviewerPrompt(
                      targetLang,
                      job.styleGuide,
                    ),
                    signal: ac.signal,
                    taskId,
                    chunkLabel,
                    agentLabel: "Fluency-reviewer agent",
                  }),
                parseScores: parseReviewScores,
                log: (level, message) =>
                  appendLog({ level, source: "engine", taskId, message, model }),
                setPhase: (phase) => updateTask(taskId, { phase }),
              },
            );
            translatedText = restoreTypography(translatedText, upgraded);

            const core = stripOverlapFromResponse(
              translatedText,
              chunk.overlapHeadParagraphs,
            );
            pieces.push(core);
          }
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
        // Rough input-token estimate (shared CHARS_PER_TOKEN ratio) — gives a
        // useful prefill tok/s number even though llama-server's streaming
        // endpoint doesn't expose exact prompt-token counts.
        const inputTokenEst = estimateTokens(chunk.body);
        const prefillTps =
          prefillMs > 0 ? (inputTokenEst / (prefillMs / 1000)).toFixed(0) : "n/a";
        totalOutTokens += tokCount;

        // Context-budget telemetry: estimate what one editor request actually
        // occupies (system prompt + chunk body) against the model's per-slot
        // context window. This is the real signal for diagnosing prefill
        // slowness. Always surfaced to the diagnostics feed (info), escalating to
        // a warning once a request crowds the window (≥80%).
        {
          const ctxWindow = getContextWindow(model);
          const systemTokens = estimateTokens(prompt);
          const reqTokens = systemTokens + inputTokenEst;
          const pct = ctxWindow > 0 ? Math.round((reqTokens / ctxWindow) * 100) : 0;
          const msg = `Chunk ${chunkLabel} context: ~${reqTokens} tok (system ${systemTokens} + chunk ${inputTokenEst}) of ${ctxWindow} (${pct}%)`;
          console.log(`[Queue] ${msg}`);
          appendLog({
            level: pct >= 80 ? "warn" : "info",
            source: "engine",
            taskId,
            message: pct >= 80 ? `${msg} — near context limit; prefill may crawl` : msg,
            model,
          });
        }
        // Push live tok/s to task state for UI display
        if (tokPerSec !== "n/a") {
          updateTask(taskId, { tokPerSec });
          // Feed the same number into the machine's throughput profile. Only
          // local GGUFs: an API model's speed says nothing about this computer,
          // and a custom GGUF is not something we can recommend switching away
          // from. This is what lets a measurement overrule the GPU-class guess.
          if (!isApiModel(model) && !isCustomGgufModel(model)) {
            recordThroughputSample(model, Number(tokPerSec));
          }
        }
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

      updateTask(taskId, {
        progress: pass.progressBase + ((j + 1) / chunks.length) * pass.progressSpan,
      });
    }

    // Collect the final pending reviewer (last chunk).
    if (pendingReview) await collectPendingReview();

    return {
      text: pieces.join("\n\n").trim(),
      corrections,
      skipped,
    };
  };

  // Thorough mode: a second copy-edit pass over the first pass's output
  // catches residual errors (both leftovers and anything the pipeline itself
  // introduced). Limited to copy-edit checks — re-running line edits would
  // rewrite already-rewritten prose and drift from the author's voice — so it
  // only applies when the job includes copy_edit.
  const extraPass =
    job.extraPass === true &&
    isCorrectionsMode &&
    (mode === "copy_edit" || mode === "combined_edit");

  const pass1 = await runCorrectionPass(original, {
    n: 1,
    total: extraPass ? 2 : 1,
    progressBase: 0,
    progressSpan: extraPass ? 0.5 : 1,
    mode,
    prompt,
  });
  if (!pass1) return;

  let editedText = pass1.text;
  const corrections = pass1.corrections;
  const skipped = pass1.skipped;

  if (extraPass && !ac.signal.aborted) {
    appendLog({
      level: "info",
      source: "engine",
      taskId,
      message:
        "Thorough mode: running a second copy-edit pass over the edited text.",
      model,
    });
    const pass2 = await runCorrectionPass(editedText, {
      n: 2,
      total: 2,
      progressBase: 0.5,
      progressSpan: 0.5,
      mode: "copy_edit",
      prompt:
        mode === "copy_edit"
          ? prompt
          : buildCopyEditCorrectionsPrompt(
              {
                ...DEFAULT_COPY_EDIT_OPTIONS,
                ...editOptions,
              } as CopyEditOptions,
              job.styleGuide,
              undefined,
              job.manuscriptLang,
            ),
    });
    if (pass2) {
      editedText = pass2.text;
      // Export locates accepted corrections in the TRUE original text (plain
      // indexOf in the frontend's applyAccepted), so pass-2 spans that only
      // exist in pass-1 output must be flagged rather than silently merged.
      const p2 = pass2.corrections.map((c) => ({ ...c, pass: 2 }));
      const unanchored = flagUnanchoredCorrections(original, p2);
      if (unanchored > 0) {
        appendLog({
          level: "info",
          source: "engine",
          taskId,
          message: `Second pass: ${unanchored}/${p2.length} corrections overlap first-pass changes and are flagged for manual review.`,
          model,
        });
      }
      corrections.push(...p2);
      skipped.push(...pass2.skipped);
    }
  }

  updateTask(taskId, { phase: "finalizing" });
  abortControllers.delete(taskId);

  const totalMs = performance.now() - jobStart;
  const overallTps =
    totalMs > 0 ? ((totalOutTokens / totalMs) * 1000).toFixed(1) : "n/a";
  console.log(
    `[Queue] job ${taskId} done: wall=${(totalMs / 1000).toFixed(1)}s chunks=${totalChunks} tokens=${totalOutTokens} tok/s=${overallTps}`,
  );
  if (totalOutTokens > 0) {
    appendLog({
      level: "info",
      source: "engine",
      message: `Job done: ${(totalMs / 1000).toFixed(1)}s · ${totalOutTokens} tokens · ${overallTps} tok/s`,
      model,
    });
  }

  // Manuscript words per second of wall clock. Unlike the per-chunk decode
  // figure this already accounts for parallel slots, review passes and
  // deterministic checks, so it is the number to build an honest "a 90,000-word
  // novel will take about N hours" estimate from.
  // `totalOutTokens > 0` is the load-bearing part: a job that failed fast (a
  // missing model file, an aborted load) still has a wall time, and dividing
  // the manuscript by it yields thousands of words per second — a garbage
  // sample that would make every later time estimate absurdly optimistic.
  if (
    totalMs > 0 &&
    totalOutTokens > 0 &&
    !isApiModel(model) &&
    !isCustomGgufModel(model)
  ) {
    const words = original.trim().split(/\s+/).length;
    recordJobThroughput(model, words / (totalMs / 1000));
    emitPerfAdvice();
  }

  // Deduplicate corrections — overlapping chunks and chunk boundaries can
  // produce the same correction multiple times, sometimes with extra context.
  {
    // Pass 1: exact dedup by (original, corrected) with whitespace normalisation.
    const seen = new Set<string>();
    const deduped: Correction[] = [];
    const norm = (s: string) => s.trim().replace(/\s+/g, " ");
    for (const c of corrections) {
      const k = JSON.stringify([norm(c.original), norm(c.corrected)]);
      if (!seen.has(k)) {
        seen.add(k);
        deduped.push(c);
      }
    }

    // Pass 2: remove corrections whose (original, corrected) pair is fully
    // contained within a shorter correction — i.e. the shorter one already
    // captures the same fix with less context, making the longer one redundant.
    const subsumeFree: Correction[] = [];
    for (const c of deduped) {
      const subsumed = deduped.some(
        (other) =>
          other !== c &&
          other.original.length < c.original.length &&
          c.original.includes(other.original) &&
          c.corrected.includes(other.corrected),
      );
      if (!subsumed) subsumeFree.push(c);
    }

    corrections.length = 0;
    corrections.push(...subsumeFree);
  }

  // Chapter-level punctuation net: doubled marks the original didn't have
  // are splice artifacts (correction snippets stopping short of a
  // sentence-final period) — collapse them and say so.
  const punctFix = collapseIntroducedPunctuationPairs(original, editedText);
  if (punctFix.fixes.length > 0) {
    editedText = punctFix.text;
    appendLog({
      level: "warn",
      source: "engine",
      taskId,
      message: `Chapter check: collapsed ${punctFix.fixes.length} doubled punctuation mark(s) introduced by editing (${[...new Set(punctFix.fixes)].join(" ")}).`,
      model,
    });
  }

  // Chapter-level spell net: anything reported here survived the per-chunk
  // verified apply, so it is an assembly/overlap-strip artifact with no
  // correction to attribute — report it, don't mutate the text.
  if (findNewSuspects) {
    const assemblySuspects = findNewSuspects(original, editedText);
    if (assemblySuspects && assemblySuspects.length > 0) {
      appendLog({
        level: "warn",
        source: "engine",
        taskId,
        message: `Chapter check: ${assemblySuspects.length} suspect word(s) present in the edited text but not the original: ${assemblySuspects.slice(0, 10).join(", ")}${assemblySuspects.length > 10 ? ", …" : ""}. Review the diff before export.`,
        model,
      });
    }
  }

  const result: TaskResult = {
    editedText,
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
        const message = err instanceof Error ? err.message : String(err);

        // A chapter that died for a transient reason gets another go. The job
        // descriptor is still in hand, so the retry re-dispatches *this* task
        // rather than calling retryTask(), which mints a new id — a new task
        // would leave the job holding both the failed original and its
        // replacement, double-counting that chapter's words in the progress
        // denominator. Cancellation still wins: every cancel path clears or
        // splices `pending`, so a cancelled job cannot resurrect itself.
        const hintKey = diagnoseTaskError(message)?.hintKey;
        const attempts = tasks.get(job.taskId)?.attempts ?? 0;
        if (shouldAutoRetry({ hintKey, attempts })) {
          const next = attempts + 1;
          updateTask(job.taskId, {
            status: "queued",
            progress: 0,
            attempts: next,
            phase: `retry ${next}/${MAX_AUTO_ATTEMPTS}`,
          });
          appendLog({
            level: "warn",
            source: "engine",
            taskId: job.taskId,
            message: `${job.name} failed (${hintKey}) — retrying, attempt ${next} of ${MAX_AUTO_ATTEMPTS}`,
          });
          pending.push(job);
          return;
        }

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
    const pruned = pruneOldTasks();
    if (pruned > 0) {
      console.log(`[Queue] pruned ${pruned} old tasks from database`);
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
    manuscriptLang: data.manuscriptLang,
    model: data.model,
    retrySpec: {
      name: data.name,
      source: data.source,
      original: data.original,
      wordCount: data.wordCount,
      model: data.model,
      mode: data.mode,
      prompt: data.prompt,
      wpc: data.wpc,
      overlap: data.overlap,
      editOptions: data.editOptions,
      targetLang: data.targetLang,
      manuscriptLang: data.manuscriptLang,
      reviewMode: data.reviewMode,
      reviewerThreshold: data.reviewerThreshold,
      reviewerCount: data.reviewerCount,
      styleGuide: data.styleGuide,
      spellCheck: data.spellCheck,
      retextCheck: data.retextCheck,
      grammarCheck: data.grammarCheck,
      dualEditor: data.dualEditor,
      dualCount: data.dualCount,
      characterDedup: data.characterDedup,
      styleComplianceAgent: data.styleComplianceAgent,
      extraPass: data.extraPass,
      runMode: data.runMode,
      units: data.units,
      correctionsDigest: data.correctionsDigest,
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
 * Cancel every non-terminal task of one job: queued tasks leave the pending
 * queue, the running task's stream is aborted, and all are marked cancelled.
 * Other jobs are untouched. Returns the number of tasks cancelled.
 */
export function cancelJob(jobId: string): number {
  let cancelled = 0;
  for (const task of tasks.values()) {
    if (task.jobId !== jobId) continue;
    if (["done", "error", "cancelled"].includes(task.status)) continue;
    const idx = pending.findIndex((j) => j.taskId === task.id);
    if (idx !== -1) pending.splice(idx, 1);
    const ac = abortControllers.get(task.id);
    if (ac) ac.abort();
    updateTask(task.id, { status: "cancelled", finishedAt: Date.now() });
    cancelled++;
  }
  if (cancelled > 0) {
    appendLog({
      level: "info",
      source: "engine",
      message: `Job ${jobId.slice(0, 8)} stopped by user — ${cancelled} task(s) cancelled.`,
    });
    broadcast();
  }
  return cancelled;
}

/**
 * Mark every non-terminal task as errored with the given reason. Called by the
 * process-level error handlers so a crash surfaces in the UI instead of tasks
 * appearing to hang or silently completing. Returns the number of tasks failed.
 */
export function failActiveTasks(reason: string): number {
  let failed = 0;
  for (const task of tasks.values()) {
    if (["done", "error", "cancelled"].includes(task.status)) continue;
    updateTask(task.id, {
      status: "error",
      finishedAt: Date.now(),
      result: {
        editedText: "",
        originalText: "",
        corrections: [],
        skipped: [],
        errors: [reason],
      },
    });
    failed++;
  }
  pending.length = 0;
  for (const ac of abortControllers.values()) ac.abort();
  if (failed > 0) broadcast();
  return failed;
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
  // Story analysis: carry the resume checkpoint into the retried task so it
  // continues from the last completed chapter instead of restarting.
  const resumeState = task.analysisCheckpoint;

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
    wpc: spec.wpc,
    overlap: spec.overlap,
    editOptions: spec.editOptions,
    targetLang: spec.targetLang,
    manuscriptLang: spec.manuscriptLang,
    reviewMode: spec.reviewMode,
    reviewerThreshold: spec.reviewerThreshold,
    reviewerCount: spec.reviewerCount,
    styleGuide: spec.styleGuide,
    spellCheck: spec.spellCheck,
    retextCheck: spec.retextCheck,
    grammarCheck: spec.grammarCheck,
    dualEditor: spec.dualEditor,
    dualCount: spec.dualCount,
    characterDedup: spec.characterDedup,
    styleComplianceAgent: spec.styleComplianceAgent,
    extraPass: spec.extraPass,
    units: spec.units,
    correctionsDigest: spec.correctionsDigest,
    resumeState,
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

/**
 * Flush the entire queue — cancel all active/pending tasks, then
 * remove every task from the in-memory map and persisted state.
 * Leaves the queue completely empty.
 */
export function flushAll(): void {
  cancelAll();
  const allIds = Array.from(tasks.keys());
  for (const id of allIds) {
    abortControllers.delete(id);
  }
  tasks.clear();
  if (allIds.length > 0) {
    try {
      deleteTaskStatesIn(allIds);
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

export function getTasksSnapshot(): Record<string, Omit<TaskState, "retrySpec">> {
  // Strip retrySpec — it embeds full chapter text per task. The frontend
  // only reads retrySpec via REST when the user clicks "retry".
  const snapshot: Record<
    string,
    Omit<TaskState, "retrySpec" | "analysisCheckpoint">
  > = {};
  for (const [id, task] of tasks) {
    const {
      retrySpec: _retrySpec,
      analysisCheckpoint: _checkpoint,
      ...rest
    } = task;
    snapshot[id] = rest;
  }
  return snapshot;
}

/**
 * Client-facing snapshot: like getTasksSnapshot but also strips `result`
 * (replaced by a resultMeta summary). Used for socket broadcasts and
 * /queue/status; the frontend hydrates full results lazily via REST.
 * getTasksSnapshot stays result-inclusive for internal consumers (writing
 * report, CLI).
 */
/** Current run statistics, for handing to a client that has just connected. */
export function getRunStats(): {
  jobProgress: ReturnType<typeof computeJobProgress>;
  runtime: ReturnType<typeof computeRuntime>;
} {
  const all = [...tasks.values()];
  return {
    jobProgress: computeJobProgress(all),
    runtime: computeRuntime(all, getCurrentParallelSlots()),
  };
}

export function getClientSnapshot(): Record<string, ClientTaskState> {
  return buildClientSnapshot(tasks.values());
}

/** Full results for every task of one job (empty for unknown jobs). */
export function getJobResults(jobId: string): Record<string, TaskResult> {
  const out: Record<string, TaskResult> = {};
  for (const [id, t] of tasks) {
    if (t.jobId === jobId && t.result) out[id] = t.result;
  }
  return out;
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
