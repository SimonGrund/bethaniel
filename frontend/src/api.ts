// ── API helper ──

import type {
  CatalogEntry,
  HardwareInfo,
  InstalledModel,
  ModelRecommendation,
  PurgeSelection,
  StorageUsage,
} from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "";

/**
 * The server looked at the file and said no: a scan, a cipher, a binary.
 *
 * Distinct from a failure, because the two deserve opposite responses. A
 * refusal is about the file and the user must pick another; a 500 or a dropped
 * connection says nothing about the file and must not cost them the manuscript
 * they already had loaded.
 */
export class RequestRefusedError extends Error {
  constructor(
    message: string,
    public status: number,
    public reason?: string,
  ) {
    super(message);
    this.name = "RequestRefusedError";
  }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${BASE}/api${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    const message = body.error ?? `HTTP ${res.status}`;
    if (res.status >= 400 && res.status < 500) {
      throw new RequestRefusedError(message, res.status, body.reason);
    }
    throw new Error(message);
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

/** What surgical export could not apply, so the caller can say so. */
export interface SurgicalReport {
  applied: number;
  skipped: number;
  detail: {
    skipped: {
      reason: string;
      /** The text that would have been replaced. */
      original: string;
      /** What it would have become. */
      replacement: string;
      /** The passage around it, so the user can find it in Word. */
      context: string;
      paragraphIndex: number;
    }[];
    unmapped: { reason: string; detail: string; paragraphIndex?: number }[];
    /** The detail was trimmed to fit the response header. */
    truncated: boolean;
    /** How many there really were, regardless of how many rows came through. */
    totalSkipped: number;
  };
}

export class NoOriginalDocxError extends Error {
  constructor(public reason: string) {
    super(`No original document available (${reason})`);
  }
}

/**
 * Export by editing the user's own .docx in place, preserving all formatting.
 *
 * Sends (original, edited) per chapter rather than joined markdown: the server
 * derives edit spans by diffing, because corrections carry no positions.
 * Throws NoOriginalDocxError when the document predates this feature or its
 * original was not kept — the caller falls back and tells the user.
 */
export async function exportDocxSurgical(
  docId: string,
  chapters: { original: string; edited: string }[],
): Promise<{ blob: Blob; report: SurgicalReport }> {
  const res = await fetch(`${BASE}/api/export/docx-surgical`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, chapters }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    throw new NoOriginalDocxError(body.reason ?? "unknown");
  }
  if (!res.ok) throw new Error("Surgical DOCX export failed");

  let detail: SurgicalReport["detail"] = {
    skipped: [],
    unmapped: [],
    truncated: false,
    totalSkipped: 0,
  };
  try {
    const raw = res.headers.get("X-Bethaniel-Report");
    if (raw) detail = JSON.parse(decodeURIComponent(raw));
  } catch {
    // A malformed report must not cost the user their document.
  }
  return {
    blob: await res.blob(),
    report: {
      applied: Number(res.headers.get("X-Bethaniel-Applied") ?? 0),
      skipped: Number(res.headers.get("X-Bethaniel-Skipped") ?? 0),
      detail,
    },
  };
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

// ── Storage & data ──

export async function fetchStorageUsage(): Promise<StorageUsage> {
  const res = await apiFetch("/storage/usage");
  return res.json();
}

export async function purgeStorage(
  selection: PurgeSelection,
): Promise<{ bytesFreed: number; removed: string[] }> {
  const res = await apiFetch("/storage/purge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(selection),
  });
  return res.json();
}
