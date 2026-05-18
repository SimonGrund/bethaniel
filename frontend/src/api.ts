// ── API helper ──

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
  fast: boolean;
  wordsPerChunk: number;
  overlapParagraphs: number;
  parallel: number;
  styleGuide?: string;
  editOptions?: Record<string, boolean> | object;
  targetLang?: string;
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

export async function retryTask(taskId: string): Promise<string> {
  const res = await apiFetch(`/queue/retry/${taskId}`, { method: "POST" });
  const data = await res.json();
  return data.taskId as string;
}

export async function clearQueue() {
  await apiFetch("/queue/clear", { method: "DELETE" });
}

export async function getQueueStatus() {
  const res = await apiFetch("/queue/status");
  return res.json();
}

export async function getTaskResult(taskId: string) {
  const res = await apiFetch(`/results/${taskId}`);
  return res.json();
}

export async function exportDocx(markdown: string): Promise<Blob> {
  const res = await fetch(`${BASE}/api/export/docx`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  if (!res.ok) throw new Error("DOCX export failed");
  return res.blob();
}

export async function runConsistencyCheck(docId: string, minOccurrences = 2) {
  const res = await apiFetch("/consistency", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ docId, minOccurrences }),
  });
  return res.json();
}
