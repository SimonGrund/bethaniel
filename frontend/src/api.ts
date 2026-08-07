// ── API helper ──

import type {
  CatalogEntry,
  HardwareInfo,
  InstalledModel,
  ModelRecommendation,
} from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "";

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}/api${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as Record<string, string>).error ?? `HTTP ${res.status}`,
    );
  }
  return res;
}

export async function uploadFile(file: File) {
  const form = new FormData();
  form.append("file", file);
  const res = await apiFetch("/upload", { method: "POST", body: form });
  return res.json();
}

export async function getDocument(id: string) {
  const res = await apiFetch(`/documents/${id}`);
  return res.json();
}

export async function listDocuments() {
  const res = await apiFetch("/documents");
  return res.json();
}

export async function fetchModels(): Promise<string[]> {
  const res = await apiFetch("/models");
  const data = await res.json();
  return data.models ?? [];
}

/** Fetch model display names map (modelId → friendly name). */
export async function fetchModelInfo(): Promise<Record<string, string>> {
  const res = await apiFetch("/models");
  const data = await res.json();
  return data.modelInfo ?? {};
}

export interface SystemRecommendation {
  recommendedParallel: number;
  totalRamGb: number;
  freeRamGb: number;
  usableRamGb: number;
  cpuCount: number;
  modelSizeGb: number;
  modelSource: "measured" | "estimated";
  kvPerJobGb: number;
}

/** Hardware, catalog and installed models — everything the model runtime needs. */
export async function fetchModelEnvironment(): Promise<{
  hardware: HardwareInfo;
  catalog: CatalogEntry[];
  preferredOrder: string[];
  installed: InstalledModel[];
  models: string[];
}> {
  const [hardware, cat, inst, modelsData] = await Promise.all([
    apiFetch("/hardware").then((r) => r.json()),
    apiFetch("/models/catalog").then((r) => r.json()),
    apiFetch("/models/installed").then((r) => r.json()),
    apiFetch("/models").then((r) => r.json()),
  ]);
  return {
    hardware,
    catalog: cat.catalog ?? [],
    preferredOrder: cat.preferredOrder ?? [],
    installed: inst.installed ?? [],
    models: modelsData.models ?? [],
  };
}

/** Which Betty this machine should run, and why. */
export async function fetchModelRecommendation(): Promise<ModelRecommendation> {
  const res = await apiFetch("/models/recommendation");
  return res.json();
}

export async function fetchSystemRecommendation(
  model?: string,
): Promise<SystemRecommendation> {
  const qs = model ? `?model=${encodeURIComponent(model)}` : "";
  const res = await apiFetch(`/system/recommend${qs}`);
  return res.json();
}

export async function getStyleGuide(): Promise<string> {
  const res = await apiFetch("/style");
  const data = await res.json();
  return data.content ?? "";
}

export async function updateStyleGuide(content: string) {
  await apiFetch("/style", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}

export async function uploadStyleGuide(file: File): Promise<string> {
  const form = new FormData();
  form.append("file", file);
  const res = await apiFetch("/style/upload", { method: "POST", body: form });
  const data = await res.json();
  return data.content ?? "";
}

export async function addToQueue(params: {
  docId: string;
  units: { name: string; original: string }[];
  model: string;
  modes: string[];
  wordsPerChunk: number;
  overlapParagraphs: number;
  parallel: number;
  styleGuide?: string;
  editOptions?: Record<string, boolean> | object;
  targetLang?: string;
  manuscriptLang?: string;
  reviewMode?: boolean;
  reviewerThreshold?: number;
  reviewerCount?: number;
  spellCheck?: boolean;
  retextCheck?: boolean;
  grammarCheck?: boolean;
  dualEditor?: boolean;
  dualCount?: number;
  characterDedup?: boolean;
  styleComplianceAgent?: boolean;
  extraPass?: boolean;
  runMode?: string;
}): Promise<{ taskIds: string[]; jobId: string; warnings: string[] }> {
  const res = await apiFetch("/queue/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  return {
    taskIds: data.taskIds ?? [],
    jobId: data.jobId,
    warnings: data.warnings ?? [],
  };
}

export async function cancelQueue() {
  await apiFetch("/queue/cancel", { method: "DELETE" });
}

export async function cancelTask(taskId: string) {
  await apiFetch(`/queue/task/${taskId}`, { method: "DELETE" });
}

/** Stop one job: aborts its running task and clears its queued tasks. */
export async function cancelJob(jobId: string) {
  await apiFetch(`/queue/job/${jobId}/cancel`, { method: "DELETE" });
}

export async function retryTask(taskId: string): Promise<string> {
  const res = await apiFetch(`/queue/retry/${taskId}`, { method: "POST" });
  const data = await res.json();
  return data.taskId as string;
}

export async function clearQueue() {
  await apiFetch("/queue/clear", { method: "DELETE" });
}

export async function flushQueue() {
  await apiFetch("/queue/flush", { method: "DELETE" });
}

export async function deleteTask(taskId: string) {
  await apiFetch(`/queue/task/${taskId}/remove`, { method: "DELETE" });
}

export async function deleteJob(jobId: string) {
  await apiFetch(`/queue/job/${jobId}`, { method: "DELETE" });
}

export async function spawnWritingReport(jobId: string): Promise<string> {
  const res = await apiFetch(`/queue/job/${jobId}/writing-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json();
  return data.taskId as string;
}

export async function spawnJobSummary(
  jobId: string,
  type: "summary" | "blurb" = "summary",
): Promise<string> {
  const res = await apiFetch(`/queue/job/${jobId}/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
  });
  const data = await res.json();
  return data.taskId as string;
}

export async function getQueueStatus() {
  const res = await apiFetch("/queue/status");
  return res.json();
}

export async function getTaskResult(taskId: string) {
  const res = await apiFetch(`/results/${taskId}`);
  return res.json();
}

// ── Lazy result hydration (snapshots carry only resultMeta counts) ──

export async function fetchJobResults(
  jobId: string,
): Promise<Record<string, import("./types").TaskResult>> {
  const res = await apiFetch(`/queue/job/${jobId}/results`);
  const data = await res.json();
  return data.results ?? {};
}

export async function fetchTaskResult(
  taskId: string,
): Promise<import("./types").TaskResult | null> {
  const res = await apiFetch(`/queue/task/${taskId}/result`);
  const data = await res.json();
  return data.result ?? null;
}

export interface DocxExportOptions {
  sectionBreak?: "asterisks" | "dash" | "blank";
  /** Minor section breaks: empty line (default) or a centered "#" that
   *  survives Atticus's paste cleanup. */
  minorBreak?: "blank" | "hash";
  lineSpacing?: number;
}

export interface VerifyChapterPayload {
  before: string;
  after: string;
  corrections: { id: string; corrected: string }[];
}

export interface VerifyChapterResult {
  suspects: string[];
  offenders: { id: string; word: string }[];
  /** Errors the server repaired in place (reverted misspellings, collapsed
   *  doubled quote pairs and doubled punctuation, stripped stray emphasis
   *  markers). */
  autoFixes?: {
    kind: "spelling" | "quotes" | "punctuation" | "formatting";
    detail: string;
  }[];
  /** The chapter's `after` text with those repairs applied — present only
   *  when it differs from what was sent. */
  fixedAfter?: string;
}

/**
 * Spell-verify frontend-assembled chapters against their originals. Returns
 * introduced misspellings per chapter and the accepted corrections
 * responsible, so the caller can un-accept them before export.
 */
export async function verifyCorrections(
  chapters: VerifyChapterPayload[],
  opts?: {
    englishDialect?: string;
    styleGuide?: string;
    manuscriptLang?: string;
  },
): Promise<{ checked: boolean; chapters: VerifyChapterResult[] }> {
  const res = await apiFetch("/verify-corrections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chapters, ...opts }),
  });
  return res.json();
}

export async function exportDocx(
  markdown: string,
  options?: DocxExportOptions,
): Promise<Blob> {
  const res = await fetch(`${BASE}/api/export/docx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, options }),
  });
  if (!res.ok) throw new Error("DOCX export failed");
  return res.blob();
}

/** Export markdown to EPUB. `docId` resolves embedded images (media/<docId>/…). */
export async function exportEpub(
  markdown: string,
  meta?: { title?: string; author?: string },
): Promise<Blob> {
  const res = await fetch(`${BASE}/api/export/epub`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, ...meta }),
  });
  if (!res.ok) throw new Error("EPUB export failed");
  return res.blob();
}

/**
 * Run the AI "auto-format for ebook" pass over the final manuscript markdown.
 * Returns the reformatted markdown (neat headers + canonical scene breaks),
 * with images left untouched in place.
 */
export async function formatEbook(
  markdown: string,
  model: string,
): Promise<string> {
  const res = await apiFetch("/format-ebook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown, model }),
  });
  const data = await res.json();
  return data.md as string;
}

export async function runConsistencyCheck(docId: string, minOccurrences = 2) {
  const res = await apiFetch("/consistency", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, minOccurrences }),
  });
  return res.json();
}

// ── External Betty (API) ──

export async function fetchCustomModelConfig(): Promise<{
  configured: boolean;
  model: string;
}> {
  const res = await apiFetch("/models/custom/config");
  return res.json();
}

export async function saveCustomModelConfig(apiKey: string, model: string) {
  await apiFetch("/models/custom/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, model }),
  });
}

/** Change the External Betty model without re-entering the stored API key. */
export async function saveCustomModelName(model: string) {
  await apiFetch("/models/custom/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
}

export async function deleteCustomModelConfig() {
  await apiFetch("/models/custom/config", { method: "DELETE" });
}

// ── Custom Betty (custom GGUF path) ──

export async function fetchCustomGgufConfig(): Promise<{
  configured: boolean;
  path: string;
}> {
  const res = await apiFetch("/models/custom-gguf/config");
  return res.json();
}

export async function saveCustomGgufConfig(ggufPath: string) {
  await apiFetch("/models/custom-gguf/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ggufPath }),
  });
}

export async function deleteCustomGgufConfig() {
  await apiFetch("/models/custom-gguf/config", { method: "DELETE" });
}
