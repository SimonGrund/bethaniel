// ── On-demand LanguageTool download ──
//
// LanguageTool (jar + a matching JRE) is normally bundled by the release
// build (scripts/fetch-languagetool.mjs), but electron-builder.yml's own
// comment says shipping without it is fine — the backend degrades
// gracefully, grammar checks just don't run. A user on a build that skipped
// it (or missing a system Java before that fix existed) has no way to get it
// short of reinstalling. This lets them fetch it themselves, on demand, from
// inside the running app — mirrors electron/gpuEngine.ts's on-demand CUDA
// engine download (atomic install, retried/verified zip extraction).

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

// Pin a specific LanguageTool release + matching Java feature version.
// LanguageTool 6.6 requires Java 17+.
const LT_VERSION = "6.6";
const LT_URL = `https://languagetool.org/download/LanguageTool-${LT_VERSION}.zip`;
const JAVA_FEATURE = "17";

/** Where the on-demand download lives — alongside DATA_DIR/MODELS_DIR, so it
 *  survives app updates and needs no elevated permissions. */
export function languageToolInstallDir(): string {
  const dataDir = process.env.DATA_DIR ?? "./data";
  return path.join(path.dirname(path.resolve(dataDir)), "languagetool");
}

export function isLanguageToolInstalled(
  dir: string = languageToolInstallDir(),
): boolean {
  return fs.existsSync(path.join(dir, "languagetool-server.jar"));
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

/** Adoptium (os, arch) tokens + JRE archive type, per platform. */
function jreTarget(): { os: string; arch: string; kind: "zip" | "tar.gz" } {
  switch (process.platform) {
    case "darwin":
      return { os: "mac", arch: process.arch === "arm64" ? "aarch64" : "x64", kind: "tar.gz" };
    case "win32":
      return { os: "windows", arch: "x64", kind: "zip" };
    default:
      return { os: "linux", arch: "x64", kind: "tar.gz" };
  }
}

/** Extracts a zip/tar.gz, verifying the destination actually got populated
 *  and retrying a few times — Windows' Expand-Archive has been observed
 *  exiting 0 having extracted nothing (transient file-lock/AV-scan race
 *  right after a download finishes; see electron/gpuEngine.ts). Destination
 *  names are kept short deliberately: LanguageTool's resource tree nests
 *  fairly deep, and a long destination risks Windows' ~260-char MAX_PATH. */
async function extractVerified(
  archivePath: string,
  destDir: string,
  kind: "zip" | "tar.gz",
  attempts = 4,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.mkdirSync(destDir, { recursive: true });
      if (kind === "tar.gz") {
        execFileSync("tar", ["-xzf", archivePath, "-C", destDir], {
          stdio: "pipe",
          timeout: 180_000,
        });
      } else if (process.platform === "win32") {
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
          ],
          { stdio: "pipe", timeout: 180_000 },
        );
      } else {
        execFileSync("unzip", ["-o", "-q", archivePath, "-d", destDir], {
          stdio: "pipe",
          timeout: 180_000,
        });
      }
      if (fs.readdirSync(destDir).length > 0) return;
      lastErr = new Error(`extraction produced nothing for ${archivePath}`);
    } catch (err) {
      lastErr = err;
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** The single top-level directory inside a freshly-extracted archive dir. */
function soleDir(dir: string): string {
  const dirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory());
  if (dirs.length !== 1) {
    throw new Error(`expected one directory in ${dir}, found ${dirs.length}`);
  }
  return path.join(dir, dirs[0].name);
}

/** Move the CONTENTS of srcDir into destDir (destDir kept if it exists). */
function mergeInto(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    fs.cpSync(path.join(srcDir, name), path.join(destDir, name), {
      recursive: true,
    });
  }
}

/**
 * Downloads LanguageTool + a matching JRE and installs them into
 * `languageToolInstallDir()`. All work happens under a temp dir first; the
 * final directory is only ever replaced by an atomic rename once every step
 * has succeeded, so a crash or failed download never leaves a half-installed
 * distribution behind.
 *
 * Returns true if a fresh install happened, false if one was already present
 * (no-op). Throws on any download/extract failure — callers should catch and
 * keep degrading gracefully (no grammar checks).
 */
export async function downloadLanguageTool(opts?: {
  log?: (message: string) => void;
}): Promise<boolean> {
  const log = opts?.log ?? (() => {});
  const finalDir = languageToolInstallDir();
  if (isLanguageToolInstalled(finalDir)) return false;

  // A sibling of finalDir, NOT nested inside it — finalDir gets wiped and
  // replaced at the end, which would otherwise delete tmpDir (and the staged
  // result inside it) out from under the rename below. Named short and
  // deliberately: LanguageTool's own resource tree nests fairly deep, and
  // every extra character here eats into Windows' ~260-char MAX_PATH budget.
  const tmpDir = path.join(path.dirname(finalDir), ".lt-tmp");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // 1. LanguageTool server + all its dependency jars/resources
  log(`downloading ${LT_URL} ...`);
  const ltZip = path.join(tmpDir, "lt.zip");
  await downloadToFile(LT_URL, ltZip);
  const ltExtractDir = path.join(tmpDir, "lt");
  await extractVerified(ltZip, ltExtractDir, "zip");
  const stagedDir = path.join(tmpDir, "staged");
  mergeInto(soleDir(ltExtractDir), stagedDir);

  // 2. A matching JRE (Temurin), so no system Java is required either.
  const { os, arch, kind } = jreTarget();
  const jreUrl = `https://api.adoptium.net/v3/binary/latest/${JAVA_FEATURE}/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;
  log(`downloading Temurin ${JAVA_FEATURE} JRE (${os}/${arch}) ...`);
  const jreArchive = path.join(tmpDir, kind === "tar.gz" ? "jre.tar.gz" : "jre.zip");
  await downloadToFile(jreUrl, jreArchive);
  const jreExtractDir = path.join(tmpDir, "jre-x");
  await extractVerified(jreArchive, jreExtractDir, kind);
  const jreHome = soleDir(jreExtractDir);
  // macOS JREs nest the runtime under Contents/Home.
  const jreRoot = fs.existsSync(path.join(jreHome, "Contents", "Home"))
    ? path.join(jreHome, "Contents", "Home")
    : jreHome;
  mergeInto(jreRoot, path.join(stagedDir, "jre"));
  if (process.platform !== "win32") {
    const javaBin = path.join(stagedDir, "jre", "bin", "java");
    try {
      fs.chmodSync(javaBin, 0o755);
    } catch {
      // best-effort
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
