// ── On-demand CUDA engine download (Windows) ──
//
// The bundled Windows llama-server build has no GPU backend at all — shipping
// the CUDA build (well over 1 GB once its cuBLAS/cuDART runtime is included)
// in every installer would bloat non-NVIDIA installs for no benefit. Instead,
// when an NVIDIA GPU is detected and no CUDA build is present yet, main.ts
// downloads one into userData in the background (survives app updates, needs
// no elevated permissions) via downloadCudaEngine() below. Pure Node — no
// Electron API dependency — so it can run standalone under tsx for testing.

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

export function hasCudaEngineInstalled(finalDir: string): boolean {
  return fs.existsSync(path.join(finalDir, "llama-server.exe"));
}

async function downloadToFile(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as import("stream/web").ReadableStream),
    fs.createWriteStream(destPath),
  );
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
 * Downloads the pinned CUDA-enabled llama-server build + its CUDA runtime
 * DLLs (cudart/cublas — not bundled in the llama.cpp release; NVIDIA
 * distributes them as pip wheels, which are plain zips) and installs them
 * into `finalDir`. All work happens under `tmpDir` first; `finalDir` is only
 * ever replaced by an atomic rename once every step has succeeded, so a
 * crash or failed download never leaves a half-installed engine behind.
 *
 * Returns true if a fresh install happened, false if one was already present
 * (no-op). Throws on any download/extract/verify failure — callers should
 * catch and keep using the existing (CPU) build.
 */
export async function downloadCudaEngine(opts: {
  manifestPath: string;
  finalDir: string;
  tmpDir: string;
  log?: (message: string) => void;
}): Promise<boolean> {
  const { manifestPath, finalDir, tmpDir } = opts;
  const log = opts.log ?? (() => {});

  if (hasCudaEngineInstalled(finalDir)) return false;
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  const asset: LlamaManifestAsset | undefined =
    manifest?.assets?.["win32-x64-cuda"];
  if (!asset) throw new Error("no win32-x64-cuda entry in manifest");

  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. llama-server (CUDA build)
  log(`downloading ${asset.url} ...`);
  const llamaZip = path.join(tmpDir, "llama-cuda.zip");
  await downloadToFile(asset.url, llamaZip);
  const llamaExtractDir = path.join(tmpDir, "llama-extracted");
  const llamaFound = await extractZipVerified(llamaZip, llamaExtractDir, [
    asset.binary,
  ]);
  const serverExe = llamaFound.get(asset.binary)!;
  const stagedDir = path.join(tmpDir, "staged");
  fs.mkdirSync(stagedDir, { recursive: true });
  for (const entry of fs.readdirSync(path.dirname(serverExe))) {
    fs.cpSync(
      path.join(path.dirname(serverExe), entry),
      path.join(stagedDir, entry),
    );
  }

  // 2. CUDA runtime DLLs (cudart/cublas). Pulled as single zip entries (see
  // extractZipEntryToFile) rather than extracted wholesale — these wheels
  // bundle their full include/ header trees, which is both wasted work (we
  // only want 1-3 DLLs) and, at depth, a Windows MAX_PATH risk.
  for (const dll of asset.cudaRuntimeDlls ?? []) {
    log(`downloading ${dll.url} ...`);
    const wheelPath = path.join(tmpDir, path.basename(dll.url));
    await downloadToFile(dll.url, wheelPath);
    if (dll.sha256) {
      const actual = await sha256File(wheelPath);
      if (actual !== dll.sha256) {
        throw new Error(
          `SHA-256 mismatch for ${dll.url}: expected ${dll.sha256}, got ${actual}`,
        );
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
  return true;
}
