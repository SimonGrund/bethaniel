#!/usr/bin/env node
// ── scripts/fetch-languagetool.mjs ──
// Downloads the LanguageTool grammar server + a matching Temurin JRE into
// electron/resources/languagetool/ so `npm run dist` bundles a self-contained
// (no system Java needed) grammar checker. Called from build.mjs per target
// platform; can also be run standalone:
//
//   node scripts/fetch-languagetool.mjs --platform mac|win|linux
//
// Idempotent: skips a download whose output already exists (so a locally
// dropped-in distribution is reused). Fetch failures throw — a published build
// should either include LanguageTool or fail visibly, not ship it silently
// half-present.

import { promises as fs, createWriteStream, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { tmpdir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LT_DIR = join(ROOT, "electron", "resources", "languagetool");

// Pinned for reproducible builds. LanguageTool 6.6 requires Java 17+.
const LT_VERSION = "6.6";
const LT_URL = `https://languagetool.org/download/LanguageTool-${LT_VERSION}.zip`;
const JAVA_FEATURE = "17";

/** (platform, arch) → Adoptium (os, arch) tokens + JRE archive type. */
function jreTarget(platform, arch) {
  const adoptiumArch = arch === "arm64" ? "aarch64" : "x64";
  switch (platform) {
    case "mac":
      return { os: "mac", arch: adoptiumArch, kind: "tar.gz" };
    case "win":
      return { os: "windows", arch: adoptiumArch, kind: "zip" };
    case "linux":
      return { os: "linux", arch: adoptiumArch, kind: "tar.gz" };
    default:
      throw new Error(`Unknown platform: ${platform}`);
  }
}

async function download(url, dest, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`  ↻ download attempt ${i} failed (${err.message}); retrying…`);
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function extractArchive(archive, destDir, kind) {
  if (kind === "tar.gz") {
    execSync(`tar -xzf "${archive}" -C "${destDir}"`, { stdio: "pipe" });
  } else if (process.platform === "win32") {
    // Expand-Archive is built into every Windows runner and handles .zip.
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force"`,
      { stdio: "pipe" },
    );
  } else {
    execSync(`unzip -o -q "${archive}" -d "${destDir}"`, { stdio: "pipe" });
  }
}

/** The single top-level directory inside a freshly-extracted archive dir. */
async function soleDir(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length !== 1) {
    throw new Error(`expected one directory in ${dir}, found ${dirs.length}`);
  }
  return join(dir, dirs[0].name);
}

/** Move the CONTENTS of srcDir into destDir (destDir kept if it exists).
 *  rename() fails with EXDEV when src (temp) and dest are on different drives
 *  (e.g. C: temp vs D: workspace on Windows runners), so fall back to copy. */
async function mergeInto(srcDir, destDir) {
  await ensureDir(destDir);
  for (const name of await fs.readdir(srcDir)) {
    const from = join(srcDir, name);
    const to = join(destDir, name);
    try {
      await fs.rename(from, to);
    } catch (err) {
      if (err?.code !== "EXDEV") throw err;
      await fs.cp(from, to, { recursive: true });
      await fs.rm(from, { recursive: true, force: true });
    }
  }
}

/** Recursively delete files with the given extension. */
async function removeByExt(dir, ext) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await removeByExt(p, ext);
    else if (e.name.endsWith(ext)) await fs.rm(p, { force: true });
  }
}

async function fetchLanguageToolJar() {
  if (existsSync(join(LT_DIR, "languagetool-server.jar"))) {
    console.log("  ✓ LanguageTool distribution already present — skipping.");
    return;
  }
  console.log(`  ↓ LanguageTool ${LT_VERSION} …`);
  const tmp = await fs.mkdtemp(join(tmpdir(), "lt-"));
  const zip = join(tmp, "lt.zip");
  await download(LT_URL, zip);
  extractArchive(zip, tmp, "zip"); // → tmp/LanguageTool-<ver>/
  await mergeInto(await soleDir(tmp), LT_DIR); // flatten into LT_DIR
  await fs.rm(tmp, { recursive: true, force: true });
  console.log("  ✓ LanguageTool jars in place.");
}

/**
 * Fetch the JRE for one (platform, arch) into jre-<platform>-<arch>/.
 *
 * Per arch, not per platform: macOS builds Apple Silicon and Intel in one
 * electron-builder run, and electron-builder.yml picks jre-${os}-${arch}/ for
 * each app. One shared jre/ would give one of the two a Java it cannot run.
 */
async function fetchJre(platform, arch) {
  const javaExe = platform === "win" ? "java.exe" : "java";
  const jreDir = join(LT_DIR, `jre-${platform}-${arch}`);
  if (existsSync(join(jreDir, "bin", javaExe))) {
    console.log(`  ✓ Bundled JRE for ${platform}-${arch} already present — skipping.`);
    return;
  }
  const { os, arch: adoptiumArch, kind } = jreTarget(platform, arch);
  const url = `https://api.adoptium.net/v3/binary/latest/${JAVA_FEATURE}/ga/${os}/${adoptiumArch}/jre/hotspot/normal/eclipse`;
  console.log(`  ↓ Temurin ${JAVA_FEATURE} JRE (${os}/${adoptiumArch}) …`);
  const tmp = await fs.mkdtemp(join(tmpdir(), "jre-"));
  const archive = join(tmp, `jre.${kind === "tar.gz" ? "tar.gz" : "zip"}`);
  await download(url, archive);
  extractArchive(archive, tmp, kind); // → tmp/jdk-…-jre/
  const home = await soleDir(tmp);
  // On macOS the runtime lives under Contents/Home; flatten it so the resolved
  // path is jre/bin/java on every platform.
  const jreRoot = existsSync(join(home, "Contents", "Home"))
    ? join(home, "Contents", "Home")
    : home;
  await mergeInto(jreRoot, jreDir);
  await fs.rm(tmp, { recursive: true, force: true });
  // Class-Data-Sharing archives aren't code-signable and are regenerated at
  // runtime — removing them fixes macOS codesign ("classes.jsa: Permission
  // denied") and trims the bundle.
  await removeByExt(jreDir, ".jsa");
  if (process.platform !== "win32") {
    // Make the tree writable so macOS codesign can embed signatures, and keep
    // the launcher executable.
    execSync(`chmod -R u+w "${jreDir}"`, { stdio: "pipe" });
    try {
      await fs.chmod(join(jreDir, "bin", javaExe), 0o755);
    } catch {}
  }
  console.log(`  ✓ JRE in place at electron/resources/languagetool/jre-${platform}-${arch}/.`);
}

/**
 * Fetch LanguageTool + a JRE for each of `arches` on `platform`
 * ("mac"|"win"|"linux"). The jars are shared; the JREs are not.
 */
export async function fetchLanguageTool(platform, arches) {
  await ensureDir(LT_DIR);
  await fetchLanguageToolJar();
  for (const arch of arches) await fetchJre(platform, arch);
}

// ── Standalone entry ──
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--platform");
  const platform =
    i !== -1 && args[i + 1]
      ? args[i + 1]
      : process.platform === "darwin"
        ? "mac"
        : process.platform === "win32"
          ? "win"
          : "linux";
  fetchLanguageTool(platform)
    .then(() => console.log("LanguageTool bundle ready."))
    .catch((err) => {
      console.error("fetch-languagetool failed:", err);
      process.exit(1);
    });
}
