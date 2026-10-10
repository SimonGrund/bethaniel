// ── Installing a GPU engine (Windows) ──
//
// The bundled Windows llama-server has no GPU backend: shipping the CUDA
// build (well over 1 GB with its cuBLAS/cuDART runtime) or the Vulkan build
// in every installer would bloat every machine without the card. Instead the
// one this machine can use (gpuDetect.ts) is fetched into userData — it
// survives app updates and needs no elevated permissions — and tested before
// it is used (gpuEngineManager.ts). Pure Node, so it runs under tsx too.

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

export interface CudaRuntimeDllAsset {
  url: string;
  sha256?: string;
  dllPaths: string[];
}

export interface LlamaManifestAsset {
  url: string;
  sha256?: string;
  binary: string;
  cudaRuntimeDlls?: CudaRuntimeDllAsset[];
}

export function hasEngineInstalled(finalDir: string): boolean {
  return fs.existsSync(path.join(finalDir, "llama-server.exe"));
}

async function downloadToFile(
  url: string,
  destPath: string,
  onBytes?: (n: number) => void,
): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  const body = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
  if (onBytes) body.on("data", (chunk: Buffer) => onBytes(chunk.length));
  await pipeline(body, fs.createWriteStream(destPath));
}

/** The size of a download, from its headers; 0 when the server will not say. */
async function contentLength(url: string): Promise<number> {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow" });
    return Number(res.headers.get("content-length")) || 0;
  } catch {
    return 0;
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const rs = fs.createReadStream(filePath);
    rs.on("data", (chunk) => hash.update(chunk));
    rs.on("end", () => resolve(hash.digest("hex")));
    rs.on("error", reject);
  });
}

/** Extracts a zip via PowerShell's Expand-Archive. Note: it refuses by file
 *  EXTENSION, not content — the source path must end in `.zip`. */
export function extractZip(zipPath: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ],
    { stdio: "pipe", timeout: 180_000 },
  );
}

/**
 * Extracts one specific entry from a zip straight to `destFilePath`, via
 * .NET's ZipFile API rather than Expand-Archive.
 *
 * This is NOT just an optimization: the CUDA runtime wheels bundle their full
 * include/ header trees (entries observed up to 70+ chars long), and
 * Expand-Archive replicates the zip's internal folder structure under
 * whatever (potentially long) destination directory it's given. Once that
 * combined path clears Windows' ~260-char MAX_PATH, ExtractToDirectory fails
 * — and Expand-Archive was observed swallowing that failure as a
 * non-terminating error, exiting 0 with the destination left completely
 * empty. Pulling a single entry out to a short, caller-chosen file path (no
 * directory tree to replicate) sidesteps the whole path-length class of
 * failure, and also skips extracting hundreds of MB of headers we don't need.
 */
export function extractZipEntryToFile(
  zipPath: string,
  entryPath: string,
  destFilePath: string,
): void {
  fs.mkdirSync(path.dirname(destFilePath), { recursive: true });
  const script = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `$z = [System.IO.Compression.ZipFile]::OpenRead('${zipPath}')`,
    "try {",
    `  $entry = $z.Entries | Where-Object { $_.FullName -eq '${entryPath}' }`,
    "  if (-not $entry) { throw \"entry not found: " + entryPath + "\" }",
    `  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, '${destFilePath}', $true)`,
    "} finally { $z.Dispose() }",
  ].join("\n");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    stdio: "pipe",
    timeout: 60_000,
  });
}

/** extractZipEntryToFile, retried a few times — mirrors extractZipVerified's
 *  defense against the transient Windows file-lock/AV-scan races seen right
 *  after a download completes. */
async function extractZipEntryVerified(
  zipPath: string,
  entryPath: string,
  destFilePath: string,
  attempts = 4,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.rmSync(destFilePath, { force: true });
      extractZipEntryToFile(zipPath, entryPath, destFilePath);
      if (fs.existsSync(destFilePath) && fs.statSync(destFilePath).size > 0) {
        return;
      }
      lastErr = new Error(`${entryPath} missing/empty after extraction`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Find a file by exact relative-or-basename match under a freshly extracted dir. */
export function findExtractedFile(
  root: string,
  relOrBaseName: string,
): string | null {
  const direct = path.join(root, relOrBaseName);
  if (fs.existsSync(direct)) return direct;
  const baseName = path.basename(relOrBaseName);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === baseName) return full;
    }
  }
  return null;
}

/**
 * Extracts a zip and verifies every expected file actually landed, retrying
 * the whole extraction a few times on failure. Expand-Archive can exit 0
 * having extracted nothing — observed against a file that had just finished
 * downloading, most likely a transient Windows file-lock/AV-scan race — so a
 * bare exit-code check isn't trustworthy here.
 */
async function extractZipVerified(
  zipPath: string,
  destDir: string,
  expectedRelPaths: string[],
  attempts = 6,
): Promise<Map<string, string>> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
      extractZip(zipPath, destDir);
      const found = new Map<string, string>();
      for (const rel of expectedRelPaths) {
        const f = findExtractedFile(destDir, rel);
        if (f) found.set(rel, f);
      }
      if (found.size === expectedRelPaths.length) return found;
      const missing = expectedRelPaths.filter((r) => !found.has(r));
      lastErr = new Error(
        `extraction incomplete for ${zipPath}: missing ${missing.join(", ")}`,
      );
    } catch (err) {
      lastErr = err;
    }
    // Windows Defender's real-time scan of a batch of freshly-written
    // executables can hold file locks well past a short retry window —
    // observed taking several seconds when many new .exe/.dll files land in
    // the same folder tree right before this runs. Back off accordingly.
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 2000));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Downloads a pinned llama-server build (CUDA or Vulkan) and, for CUDA, its
 * runtime DLLs (cudart/cublas — not in the llama.cpp release; NVIDIA
 * distributes them as pip wheels, which are plain zips), and installs them
 * into `finalDir`. Everything happens under `tmpDir` first; `finalDir` is
 * only replaced by a rename once every step has succeeded, so a failed
 * download never leaves a half-installed engine behind. Throws on any
 * failure — the caller keeps the CPU build.
 */
export async function installEngine(opts: {
  asset: LlamaManifestAsset;
  finalDir: string;
  tmpDir: string;
  log?: (message: string) => void;
  /** Bytes so far and in all, across every file. */
  onProgress?: (bytes: number, total: number) => void;
}): Promise<void> {
  const { asset, finalDir, tmpDir } = opts;
  const log = opts.log ?? (() => {});
  const urls = [asset.url, ...(asset.cudaRuntimeDlls ?? []).map((d) => d.url)];
  const total = (await Promise.all(urls.map(contentLength))).reduce((a, b) => a + b, 0);
  let bytes = 0;
  const onBytes = (n: number) => {
    bytes += n;
    opts.onProgress?.(bytes, Math.max(total, bytes));
  };

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. llama-server
  log(`downloading ${asset.url} ...`);
  const llamaZip = path.join(tmpDir, "llama.zip");
  await downloadToFile(asset.url, llamaZip, onBytes);
  if (asset.sha256) {
    const actual = await sha256File(llamaZip);
    if (actual !== asset.sha256) throw new Error(`SHA-256 mismatch for ${asset.url}`);
  }
  const llamaExtractDir = path.join(tmpDir, "llama-extracted");
  const llamaFound = await extractZipVerified(llamaZip, llamaExtractDir, [asset.binary]);
  const serverExe = llamaFound.get(asset.binary)!;
  const stagedDir = path.join(tmpDir, "staged");
  fs.mkdirSync(stagedDir, { recursive: true });
  for (const entry of fs.readdirSync(path.dirname(serverExe))) {
    fs.cpSync(path.join(path.dirname(serverExe), entry), path.join(stagedDir, entry), { recursive: true });
  }

  // 2. CUDA runtime DLLs (cudart/cublas). Pulled as single zip entries (see
  // extractZipEntryToFile) rather than extracted wholesale — these wheels
  // bundle their full include/ header trees, which is both wasted work (we
  // only want 1-3 DLLs) and, at depth, a Windows MAX_PATH risk.
  for (const dll of asset.cudaRuntimeDlls ?? []) {
    log(`downloading ${dll.url} ...`);
    const wheelPath = path.join(tmpDir, path.basename(dll.url));
    await downloadToFile(dll.url, wheelPath, onBytes);
    if (dll.sha256) {
      const actual = await sha256File(wheelPath);
      if (actual !== dll.sha256) {
        throw new Error(`SHA-256 mismatch for ${dll.url}: expected ${dll.sha256}, got ${actual}`);
      }
    }
    for (const dllRelPath of dll.dllPaths) {
      const destFile = path.join(stagedDir, path.basename(dllRelPath));
      await extractZipEntryVerified(wheelPath, dllRelPath, destFile);
    }
  }

  // All steps succeeded — atomically become the final install.
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(finalDir), { recursive: true });
  fs.renameSync(stagedDir, finalDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  log(`installed at ${finalDir}`);
}
