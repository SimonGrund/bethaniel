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
  mode: string;
  fast: boolean;
  wordsPerChunk: number;
  overlapParagraphs: number;
  parallel: number;
  styleGuide?: string;
  editOptions?: Record<string, boolean> | object;
  targetLang?: string;
}): Promise<string[]> {
  const res = await apiFetch("/queue/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  return data.taskIds;
}

export async function cancelQueue() {
  await apiFetch("/queue/cancel", { method: "DELETE" });
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
