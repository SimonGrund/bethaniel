#!/usr/bin/env node
// ── scripts/build.mjs ──
// Cross-platform build orchestrator for the Bethaniel Electron app.
//
// Usage:
//   node scripts/build.mjs                  # build for current host OS
//   node scripts/build.mjs --platform mac   # macOS only
//   node scripts/build.mjs --platform win   # Windows only (needs Wine on non-Windows)
//   node scripts/build.mjs --platform linux # Linux only
//   node scripts/build.mjs --platform all   # all platforms
//   node scripts/build.mjs --skip-llama     # skip llama binary download (dev)

import { promises as fs } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { execSync, execFileSync } from "child_process";
import { createWriteStream } from "fs";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Parse CLI args ──

const args = process.argv.slice(2);
let targetPlatform = null;
let skipLlama = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--platform" && args[i + 1]) {
    targetPlatform = args[++i];
  } else if (args[i] === "--skip-llama") {
    skipLlama = true;
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log(`
Bethaniel Electron Build Script

Usage:
  node scripts/build.mjs [options]

Options:
  --platform <mac|win|linux|all>  Target platform (default: current host)
  --skip-llama                     Skip downloading llama-server binaries
  -h, --help                       Show this help

Notes:
  • Building for Windows on macOS/Linux requires Wine.
  • Building for Linux on macOS works natively via electron-builder.
  • Building for macOS only works on macOS.
`);
    process.exit(0);
  }
}

// ── Helpers ──

function run(cmd, opts = {}) {
  console.log(`\n  $ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function hostPlatform() {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "win32":
      return "win";
    default:
      return "linux";
  }
}

function hostArch() {
  return process.arch; // arm64 | x64
}

// ── Determine targets ──

const platform = targetPlatform ?? hostPlatform();
const platforms = platform === "all" ? ["mac", "win", "linux"] : [platform];

// Map our platform names to electron-builder + llama manifest keys
function electronBuilderFlag(p) {
  switch (p) {
    case "mac":
      return "--mac";
    case "win":
      return "--win";
    case "linux":
      return "--linux";
    default:
      throw new Error(`Unknown platform: ${p}`);
  }
}

function llamaManifestKeys(p) {
  switch (p) {
    case "mac":
      // Build for both arm64 and x64 on macOS
      return ["darwin-arm64", "darwin-x64"];
    case "win":
      return ["win32-x64"];
    case "linux":
      return ["linux-x64"];
    default:
      return [];
  }
}

// ── Step 1: Install dependencies ──

console.log("━━━ Step 1: Install dependencies ━━━");
run("npm install");

// ── Step 2: Build frontend ──

console.log("\n━━━ Step 2: Build frontend ━━━");
run("npm run build --workspace=frontend");
run("node scripts/wire-frontend.mjs");

// ── Step 3: Build backend ──

console.log("\n━━━ Step 3: Build backend ━━━");
run("npm run build --workspace=backend");

// ── Step 3b: Install backend production deps (standalone) ──
// npm workspaces hoists deps to root, but electron-builder needs them
// in backend/node_modules/ inside the asar. We do a standalone install.
console.log("\n━━━ Step 3b: Install backend production deps ━━━");
{
  const backendDir = join(ROOT, "backend");
  const tmpDir = join(ROOT, ".build-tmp-backend");

  // Clean
  try {
    await fs.rm(tmpDir, { recursive: true });
  } catch {}
  await fs.mkdir(tmpDir, { recursive: true });

  // Copy package files
  await fs.copyFile(
    join(backendDir, "package.json"),
    join(tmpDir, "package.json"),
  );
  try {
    await fs.copyFile(
      join(backendDir, "package-lock.json"),
      join(tmpDir, "package-lock.json"),
    );
  } catch {} // lock may not exist standalone

  // Install production deps in isolation
  run("npm install --omit=dev --ignore-scripts", { cwd: tmpDir });

  // Copy resulting node_modules into backend/
  const destNm = join(backendDir, "node_modules");
  try {
    await fs.rm(destNm, { recursive: true });
  } catch {}
  await fs.cp(join(tmpDir, "node_modules"), destNm, { recursive: true });

  // Rebuild native modules (better-sqlite3) for the current arch
  run("npx --no-install @electron/rebuild --module-dir backend", { cwd: ROOT });

  // Clean tmp
  try {
    await fs.rm(tmpDir, { recursive: true });
  } catch {}
  console.log("  ✓ Backend production deps ready");
}

// ── Step 4: Build electron ──

console.log("\n━━━ Step 4: Build Electron main/preload ━━━");
run("npx tsc -p electron/tsconfig.json");

// ── Step 5: Download llama-server binaries ──

if (!skipLlama) {
  console.log("\n━━━ Step 5: Download llama-server binaries ━━━");

  const manifest = JSON.parse(
    await fs.readFile(join(ROOT, "scripts", "llama-manifest.json"), "utf-8"),
  );

  for (const p of platforms) {
    const keys = llamaManifestKeys(p);
    for (const key of keys) {
      const asset = manifest.assets[key];
      if (!asset) {
        console.warn(`  ⚠ No manifest entry for ${key} — skipping`);
        continue;
      }

      const destDir = join(ROOT, "electron", "resources", "llama", key);
      const binaryName = key.startsWith("win32")
        ? "llama-server.exe"
        : "llama-server";
      const destBinary = join(destDir, binaryName);

      // Skip if already present
      try {
        await fs.access(destBinary);
        console.log(`  ✓ ${key}: already present`);
        continue;
      } catch {
        // need to download
      }

      console.log(`  ↓ ${key}: downloading from ${asset.url}`);

      await fs.mkdir(destDir, { recursive: true });
      const zipPath = join(destDir, "llama.zip");

      // Download
      const res = await fetch(asset.url, { redirect: "follow" });
      if (!res.ok) {
        console.error(`    ✗ HTTP ${res.status} for ${asset.url}`);
        continue;
      }

      const fileStream = createWriteStream(zipPath);
      const reader = res.body.getReader();
      const hash = createHash("sha256");
      let downloaded = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fileStream.write(value);
        hash.update(value);
        downloaded += value.byteLength;
      }
      fileStream.end();
      await new Promise((resolve, reject) => {
        fileStream.on("finish", resolve);
        fileStream.on("error", reject);
      });

      // Verify sha256 if specified
      const digest = hash.digest("hex");
      if (asset.sha256 && digest !== asset.sha256) {
        console.error(
          `    ✗ SHA-256 mismatch for ${key}: expected ${asset.sha256}, got ${digest}`,
        );
        await fs.unlink(zipPath).catch(() => {});
        continue;
      }

      // Extract
      console.log(`  ⊞ ${key}: extracting...`);
      try {
        execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: "pipe" });
      } catch {
        // Try 7z on Windows
        try {
          execSync(`7z x "${zipPath}" -o"${destDir}" -y`, { stdio: "pipe" });
        } catch {
          console.error(`    ✗ Could not extract ${zipPath}`);
          continue;
        }
      }

      // Move binary to expected location
      const extractedBinary = join(destDir, asset.binary);
      try {
        await fs.access(extractedBinary);
        if (extractedBinary !== destBinary) {
          await fs.copyFile(extractedBinary, destBinary);
        }
        // Make executable on Unix
        if (!key.startsWith("win32")) {
          await fs.chmod(destBinary, 0o755);
        }
        console.log(`  ✓ ${key}: ready`);
      } catch (err) {
        // The binary might be at the root of the zip
        const altBinary = join(destDir, binaryName);
        try {
          await fs.access(altBinary);
          if (!key.startsWith("win32")) {
            await fs.chmod(altBinary, 0o755);
          }
          console.log(`  ✓ ${key}: ready (found at root)`);
        } catch {
          console.error(
            `    ✗ Could not find ${asset.binary} in extracted archive`,
          );
          // List what was extracted for debugging
          try {
            const files = execSync(
              `find "${destDir}" -type f -name "llama-server*"`,
              { encoding: "utf-8" },
            );
            if (files.trim()) {
              console.log(`    Found: ${files.trim()}`);
              // Copy first match
              const first = files.trim().split("\n")[0];
              await fs.copyFile(first, destBinary);
              if (!key.startsWith("win32")) await fs.chmod(destBinary, 0o755);
              console.log(`  ✓ ${key}: ready (found at ${first})`);
            }
          } catch {}
        }
      }

      // Clean up zip
      await fs.unlink(zipPath).catch(() => {});
    }
  }
} else {
  console.log(
    "\n━━━ Step 5: Skipping llama-server download (--skip-llama) ━━━",
  );
}

// ── Step 6: Run electron-builder ──

console.log("\n━━━ Step 6: Package with electron-builder ━━━");

for (const p of platforms) {
  // Check cross-compilation feasibility
  if (p === "mac" && process.platform !== "darwin") {
    console.warn("  ⚠ Skipping macOS build — can only build on macOS");
    continue;
  }
  if (p === "win" && process.platform !== "win32") {
    // Check for Wine
    try {
      execFileSync("wine", ["--version"], { stdio: "pipe" });
    } catch {
      console.warn(
        "  ⚠ Skipping Windows build — Wine not found. Install Wine to cross-compile for Windows.",
      );
      continue;
    }
  }

  const flag = electronBuilderFlag(p);
  console.log(`\n  Building for ${p}...`);
  run(
    `node_modules/.bin/electron-builder ${flag} --config electron-builder.yml`,
  );
}

// ── Cleanup: remove intermediate build artifacts ──
console.log("\n━━━ Cleaning up build artifacts ━━━");
const distDir = join(ROOT, "dist");
const entries = await fs.readdir(distDir, { withFileTypes: true });
for (const entry of entries) {
  const full = join(distDir, entry.name);
  // Keep only installer files (.dmg, .exe, .AppImage, .deb, .snap)
  if (entry.isDirectory()) {
    // Remove unpacked app dirs (mac/, mac-arm64/, linux-unpacked/, win-unpacked/)
    await fs.rm(full, { recursive: true });
    console.log(`  removed ${entry.name}/`);
  } else if (/\.(blockmap|yml|yaml)$/i.test(entry.name)) {
    await fs.rm(full);
    console.log(`  removed ${entry.name}`);
  }
}

console.log("\n━━━ Build complete ━━━");
const remaining = (await fs.readdir(distDir)).filter((f) => !f.startsWith("."));
console.log(`Output in: ${distDir}/`);
for (const f of remaining) {
  const stat = await fs.stat(join(distDir, f));
  const mb = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`  ${f}  (${mb} MB)`);
}
