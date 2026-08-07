// ── Local storage accounting & purge ──
// Everything Bethaniel writes at runtime lives under three dirs inside the
// Electron userData folder (MODELS_DIR / DATA_DIR). The GGUF models dominate —
// a full catalog is >20 GB — so both the in-app "Storage & data" screen and the
// uninstall flow need a way to measure and remove them.
//
// Dirs are read from the environment on every call (not at module load) so
// tests can point them at a temp directory.

import * as fs from "fs/promises";
import * as path from "path";
import { configPathForModel } from "./modelConfig.js";

export interface StorageUsage {
  models: { bytes: number; files: { name: string; bytes: number }[] };
  documents: { bytes: number; count: number };
  database: { bytes: number };
  settings: { bytes: number; hasApiKey: boolean };
  total: number;
}

export interface PurgeOptions {
  models?: boolean;
  documents?: boolean;
  settings?: boolean;
}

export interface PurgeResult {
  bytesFreed: number;
  removed: string[];
}

/** Files we consider ours inside MODELS_DIR. Anything else is left alone. */
const MODEL_FILE_RE = /\.(gguf|gguf\.partial|json)$/i;

/** Settings sidecars living directly in DATA_DIR. */
const SETTINGS_FILES = ["api-config.json", "custom-gguf-config.json"];

interface Dirs {
  modelsDir: string;
  dataDir: string;
  mediaDir: string;
  dbPath: string;
}

function resolveDirs(): Dirs {
  const modelsDir = process.env.MODELS_DIR ?? "./models";
  const dataDir = process.env.DATA_DIR ?? "./data";
  return {
    modelsDir,
    dataDir,
    mediaDir: path.join(dataDir, "media"),
    dbPath: path.join(dataDir, "bethaniel.db"),
  };
}

/** Size of one file, or 0 if it is missing. */
async function fileSize(p: string): Promise<number> {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/** Recursive byte total for a directory tree. Missing dir → 0. */
export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) total += await fileSize(full);
  }
  return total;
}

/**
 * Unlink a path, ignoring "already gone".
 * Returns the bytes freed and whether the file was actually there.
 */
async function unlinkCounting(
  p: string,
): Promise<{ bytes: number; existed: boolean }> {
  let bytes = 0;
  let existed = false;
  try {
    const st = await fs.stat(p);
    existed = st.isFile();
    bytes = existed ? st.size : 0;
  } catch {
    return { bytes: 0, existed: false };
  }
  try {
    await fs.unlink(p);
  } catch {
    return { bytes: 0, existed };
  }
  return { bytes, existed };
}

/**
 * Remove every on-disk trace of one catalog model: the GGUF itself, its config
 * sidecar, and any interrupted-download `.partial`. Callers are responsible for
 * validating `ggufFileName` against MODEL_CATALOG first (path-traversal guard).
 */
export async function deleteModelFiles(
  modelsDir: string,
  ggufFileName: string,
): Promise<PurgeResult> {
  const targets = [
    path.join(modelsDir, ggufFileName),
    path.join(modelsDir, `${ggufFileName}.partial`),
    configPathForModel(modelsDir, ggufFileName),
  ];
  let bytesFreed = 0;
  const removed: string[] = [];
  for (const t of targets) {
    const { bytes, existed } = await unlinkCounting(t);
    if (!existed) continue;
    bytesFreed += bytes;
    removed.push(path.basename(t));
  }
  return { bytesFreed, removed };
}

/** Count of immediate subdirectories (one per document) under MEDIA_DIR. */
async function countMediaDocs(mediaDir: string): Promise<number> {
  try {
    const entries = await fs.readdir(mediaDir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

/** Full breakdown of what Bethaniel is using on disk. */
export async function getStorageUsage(): Promise<StorageUsage> {
  const { modelsDir, dataDir, mediaDir, dbPath } = resolveDirs();

  const files: { name: string; bytes: number }[] = [];
  let modelBytes = 0;
  try {
    const entries = await fs.readdir(modelsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !MODEL_FILE_RE.test(e.name)) continue;
      const bytes = await fileSize(path.join(modelsDir, e.name));
      modelBytes += bytes;
      // Sidecars are a few hundred bytes — not worth listing individually.
      if (/\.gguf(\.partial)?$/i.test(e.name)) files.push({ name: e.name, bytes });
    }
  } catch {
    // no models dir yet
  }
  files.sort((a, b) => b.bytes - a.bytes);

  const mediaBytes = await dirSize(mediaDir);
  const dbBytes =
    (await fileSize(dbPath)) +
    (await fileSize(`${dbPath}-wal`)) +
    (await fileSize(`${dbPath}-shm`));

  let settingsBytes = 0;
  let hasApiKey = false;
  for (const name of SETTINGS_FILES) {
    const p = path.join(dataDir, name);
    settingsBytes += await fileSize(p);
    if (name === "api-config.json") {
      try {
        const raw = await fs.readFile(p, "utf-8");
        hasApiKey = !!(JSON.parse(raw) as { apiKey?: string })?.apiKey;
      } catch {}
    }
  }

  return {
    models: { bytes: modelBytes, files },
    documents: { bytes: mediaBytes, count: await countMediaDocs(mediaDir) },
    database: { bytes: dbBytes },
    settings: { bytes: settingsBytes, hasApiKey },
    total: modelBytes + mediaBytes + dbBytes + settingsBytes,
  };
}

/**
 * Delete the selected categories. Each is independent — purging models leaves
 * documents untouched and vice versa.
 *
 * Callers must stop llama-server before purging models: on Windows an open file
 * handle keeps the bytes allocated even after unlink.
 */
export async function purge(opts: PurgeOptions): Promise<PurgeResult> {
  const { modelsDir, dataDir, mediaDir, dbPath } = resolveDirs();
  let bytesFreed = 0;
  const removed: string[] = [];

  if (opts.models) {
    try {
      const entries = await fs.readdir(modelsDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !MODEL_FILE_RE.test(e.name)) continue;
        const { bytes, existed } = await unlinkCounting(
          path.join(modelsDir, e.name),
        );
        if (!existed) continue;
        bytesFreed += bytes;
        removed.push(e.name);
      }
    } catch {}
  }

  if (opts.documents) {
    bytesFreed += await dirSize(mediaDir);
    try {
      await fs.rm(mediaDir, { recursive: true, force: true });
      removed.push("media/");
    } catch {}
    // Clearing the rows is a DB concern; the dynamic import keeps sqlite out of
    // this module's import graph so file-level tests don't need the native
    // binding. The .db file won't shrink on DELETE — a full purge below removes
    // it outright, and a documents-only purge leaves the freed pages for reuse.
    const { deleteAllDocuments } = await import("./db.js");
    deleteAllDocuments();
  }

  if (opts.settings) {
    for (const name of SETTINGS_FILES) {
      const { bytes, existed } = await unlinkCounting(path.join(dataDir, name));
      if (!existed) continue;
      bytesFreed += bytes;
      removed.push(name);
    }
  }

  // A "delete everything" purge drops the database file outright.
  if (opts.models && opts.documents && opts.settings) {
    const { closeDb } = await import("./db.js");
    closeDb();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      const { bytes, existed } = await unlinkCounting(p);
      if (!existed) continue;
      bytesFreed += bytes;
      removed.push(path.basename(p));
    }
  }

  return { bytesFreed, removed };
}

/** Remove one document's extracted images. Safe to call for docs with none. */
export async function deleteDocumentMedia(docId: string): Promise<void> {
  const { mediaDir } = resolveDirs();
  // Guard against a crafted id escaping MEDIA_DIR.
  const target = path.resolve(mediaDir, docId);
  if (!target.startsWith(path.resolve(mediaDir) + path.sep)) return;
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch {}
}
