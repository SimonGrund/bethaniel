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
  parseJsonResponse,
} from "./ollama.js";

interface JobData {
  taskId: string;
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
    Object.assign(existing, update);
    broadcast();
  }
}

/** Process catalog/timeline analysis — single LLM call, structured JSON output. */
async function processAnalysisJob(
  job: JobData,
  ac: AbortController,
): Promise<void> {
  const { taskId, original, model, prompt } = job;

  updateTask(taskId, {
    status: "editing",
    startedAt: Date.now(),
    phase: "analyzing",
  });

  let acc = "";
  let tokCount = 0;
  const errors: string[] = [];
  let structuredData: unknown = null;

  try {
    for await (const tok of analyzeStream(model, original, prompt, ac.signal)) {
      acc += tok;
      tokCount++;
      if (tokCount === 1) {
        updateTask(taskId, { phase: "receiving analysis" });
      }
      // Report rough progress based on token count (analysis is one call)
      if (tokCount % 50 === 0) {
        updateTask(taskId, { phase: `analyzing (${tokCount} tokens)` });
      }
    }

    updateTask(taskId, { phase: "parsing" });
    structuredData = parseJsonResponse(acc);
    if (!structuredData) {
      errors.push("Failed to parse analysis output as JSON");
    }
  } catch (err) {
    errors.push(
      `analysis: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  abortControllers.delete(taskId);

  const result: TaskResult = {
    editedText: "",
    originalText: original,
    corrections: [],
    skipped: [],
    errors,
    structuredData,
  };

  updateTask(taskId, {
    status: errors.length > 0 && !structuredData ? "error" : "done",
    progress: 1,
    finishedAt: Date.now(),
    result,
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

  // Translation always uses rewrite (full text) mode, never fast/JSON corrections
  const useFast = mode === "translate" ? false : fast;

  updateTask(taskId, {
    status: "editing",
    startedAt: Date.now(),
    phase: "splitting",
  });

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

    try {
      updateTask(taskId, { phase: `sending chunk ${chunkLabel}` });

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
            updateTask(taskId, { phase: `receiving chunk ${chunkLabel}` });
          }
        }

        updateTask(taskId, { phase: `applying corrections ${chunkLabel}` });
        const cs = parseCorrectionsJson(acc);
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
        for await (const tok of editChunkStream(
          model,
          chunk.body,
          prompt,
          ac.signal,
        )) {
          acc += tok;
          tokCount++;
          if (tokCount === 1) {
            updateTask(taskId, { phase: `receiving chunk ${chunkLabel}` });
          }
        }
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

    updateTask(taskId, { progress: (j + 1) / chunks.length });
  }

  abortControllers.delete(taskId);

  const result: TaskResult = {
    editedText: pieces.join("\n\n").trim(),
    originalText: original,
    corrections,
    skipped,
    errors,
  };

  updateTask(taskId, {
    status: "done",
    progress: 1,
    finishedAt: Date.now(),
    result,
  });
}

function pump(): void {
  while (active < concurrency && pending.length > 0) {
    const job = pending.shift()!;
    active++;
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
        pump();
      });
  }
}

// ── Public API ──

export function initQueue(socketIo: SocketServer, conc = 1): void {
  io = socketIo;
  concurrency = Math.max(1, conc);
}

export function setConcurrency(n: number): void {
  concurrency = Math.max(1, n);
  pump();
}

export async function submitTask(
  data: Omit<JobData, "taskId">,
): Promise<string> {
  const taskId = uuidv4();

  tasks.set(taskId, {
    id: taskId,
    status: "queued",
    progress: 0,
    phase: "",
    name: data.name,
    source: data.source,
    mode: data.mode,
    wordCount: data.wordCount,
    submittedAt: Date.now(),
    result: null,
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

export function removeCompleted(): void {
  for (const [id, state] of tasks) {
    if (["done", "error", "cancelled"].includes(state.status)) {
      tasks.delete(id);
      abortControllers.delete(id);
    }
  }
  broadcast();
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
