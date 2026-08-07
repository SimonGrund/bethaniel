// Storage accounting & purge.
//
// Uninstall (and the in-app "Storage & data" screen) must be able to reclaim
// the full ~21 GB the app writes at runtime. Two things were leaking before
// this module existed: deleting a model unlinked the .gguf but left its
// `<base>.json` config sidecar behind, and a cancelled/crashed download left a
// multi-GB `<file>.gguf.partial` that nothing ever cleaned up.
//
// db.ts resolves DB_PATH at module load, and purge() imports it lazily, so the
// whole file shares ONE temp dir — re-pointing DATA_DIR per test would silently
// hit the cached module.

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

let root: string;
let modelsDir: string;
let dataDir: string;
let mediaDir: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "bethaniel-storage-"));
  modelsDir = path.join(root, "models");
  dataDir = path.join(root, "data");
  mediaDir = path.join(dataDir, "media");
  await fs.mkdir(modelsDir, { recursive: true });
  await fs.mkdir(mediaDir, { recursive: true });
  process.env.MODELS_DIR = modelsDir;
  process.env.DATA_DIR = dataDir;
});

// Each test starts from an empty models/ and media/ so byte totals are exact.
// dataDir itself is left alone — it holds the sqlite file db.ts opened once.
beforeEach(async () => {
  for (const dir of [modelsDir, mediaDir]) {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.rm(path.join(dataDir, "api-config.json"), { force: true });
  await fs.rm(path.join(dataDir, "custom-gguf-config.json"), { force: true });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Write a file of `bytes` length and return its path. */
async function writeFile(dir: string, name: string, bytes: number) {
  const p = path.join(dir, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, Buffer.alloc(bytes, 1));
  return p;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

const GGUF = "Qwen3.5-4B-Q4_K_M.gguf";
const SIDECAR = "Qwen3.5-4B-Q4_K_M.json";

test("deleting a model removes the gguf, its sidecar, and any .partial", async () => {
  const { deleteModelFiles } = await import("../src/storage.ts");

  const gguf = await writeFile(modelsDir, GGUF, 4096);
  const sidecar = await writeFile(modelsDir, SIDECAR, 128);
  const partial = await writeFile(modelsDir, `${GGUF}.partial`, 2048);

  const result = await deleteModelFiles(modelsDir, GGUF);

  assert.equal(await exists(gguf), false, "gguf should be gone");
  assert.equal(await exists(sidecar), false, "config sidecar should be gone");
  assert.equal(await exists(partial), false, "partial download should be gone");
  assert.equal(result.bytesFreed, 4096 + 128 + 2048);
  assert.equal(result.removed.length, 3);
});

test("deleting a model that is already gone is a no-op, not an error", async () => {
  const { deleteModelFiles } = await import("../src/storage.ts");
  const result = await deleteModelFiles(modelsDir, "NotThere-Q4_K_M.gguf");
  assert.equal(result.bytesFreed, 0);
  assert.deepEqual(result.removed, []);
});

test("usage totals match the bytes actually written", async () => {
  const { getStorageUsage } = await import("../src/storage.ts");

  await writeFile(modelsDir, GGUF, 10_000);
  await writeFile(modelsDir, SIDECAR, 200);
  await writeFile(mediaDir, path.join("doc-a", "img1.png"), 500);
  await writeFile(mediaDir, path.join("doc-b", "img2.png"), 300);
  await writeFile(dataDir, "api-config.json", 0);
  await fs.writeFile(
    path.join(dataDir, "api-config.json"),
    JSON.stringify({ apiKey: "sk-test", model: "deepseek-chat" }),
  );

  const usage = await getStorageUsage();

  assert.equal(usage.models.bytes, 10_200, "gguf + sidecar counted");
  assert.equal(usage.documents.bytes, 800);
  assert.equal(usage.documents.count, 2, "one entry per document dir");
  assert.ok(usage.settings.hasApiKey, "should notice a stored API key");
  // Only the .gguf is listed individually; the sidecar is noise.
  assert.deepEqual(
    usage.models.files.map((f) => f.name),
    [GGUF],
  );
  assert.equal(
    usage.total,
    usage.models.bytes +
      usage.documents.bytes +
      usage.database.bytes +
      usage.settings.bytes,
  );
});

test("models-only purge leaves documents and settings alone", async () => {
  const { purge, getStorageUsage } = await import("../src/storage.ts");

  await writeFile(modelsDir, GGUF, 10_000);
  await writeFile(modelsDir, SIDECAR, 200);
  await writeFile(modelsDir, `${GGUF}.partial`, 5_000);
  await writeFile(mediaDir, path.join("doc-a", "img1.png"), 500);
  await fs.writeFile(
    path.join(dataDir, "api-config.json"),
    JSON.stringify({ apiKey: "sk-test" }),
  );

  const result = await purge({ models: true });

  assert.equal(result.bytesFreed, 15_200);
  const usage = await getStorageUsage();
  assert.equal(usage.models.bytes, 0, "every model file removed");
  assert.equal(usage.documents.bytes, 500, "documents untouched");
  assert.ok(usage.settings.hasApiKey, "API key untouched");
});

test("purge ignores unrelated files in the models dir", async () => {
  const { purge } = await import("../src/storage.ts");

  const stray = await writeFile(modelsDir, "README.txt", 42);
  await writeFile(modelsDir, GGUF, 1000);

  await purge({ models: true });

  assert.equal(await exists(stray), true, "non-model file must survive");
});

test("settings purge removes the stored API key", async () => {
  const { purge, getStorageUsage } = await import("../src/storage.ts");

  await fs.writeFile(
    path.join(dataDir, "api-config.json"),
    JSON.stringify({ apiKey: "sk-test" }),
  );

  await purge({ settings: true });

  const usage = await getStorageUsage();
  assert.equal(usage.settings.hasApiKey, false);
  assert.equal(usage.settings.bytes, 0);
});

test("documents purge clears media dirs and the documents table", async () => {
  const { purge, getStorageUsage } = await import("../src/storage.ts");
  const { saveDocument, listDocuments } = await import("../src/db.ts");

  saveDocument({
    id: "doc-a",
    name: "Test.docx",
    md: "# Hello",
    chapters: [],
    wordCount: 2,
    uploadedAt: 1_700_000_000_000,
  });
  await writeFile(mediaDir, path.join("doc-a", "img1.png"), 900);
  assert.equal(listDocuments().length, 1);

  const result = await purge({ documents: true });

  assert.equal(result.bytesFreed, 900);
  assert.equal(listDocuments().length, 0, "rows cleared");
  const usage = await getStorageUsage();
  assert.equal(usage.documents.count, 0);
});

test("deleteDocumentMedia refuses to escape the media dir", async () => {
  const { deleteDocumentMedia } = await import("../src/storage.ts");

  const victim = await writeFile(dataDir, "sentinel.txt", 64);
  await deleteDocumentMedia("../..");
  await deleteDocumentMedia("../sentinel.txt");

  assert.equal(await exists(victim), true, "traversal must not delete outside");
});
