// ── llama-server supervisor ──
// Manages a single llama-server child process. Supports loading / swapping
// GGUF models, health-polling, and graceful shutdown.

import { ChildProcess, spawn, execFileSync, execSync } from "child_process";
import * as path from "path";
import * as http from "http";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { readModelConfig } from "./modelConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Try to locate the bundled llama-server binary when LLAMA_BIN isn't set. */
function resolveLlamaBin(): string {
  if (process.env.LLAMA_BIN) return process.env.LLAMA_BIN;

  const platformArch = `${process.platform}-${process.arch}`;
  const binaryName =
    process.platform === "win32" ? "llama-server.exe" : "llama-server";

  // Candidate locations (dev + packaged)
  const candidates = [
    // backend/dist/llamaServer.js → ../../electron/resources/llama/...
    path.resolve(
      __dirname,
      "..",
      "..",
      "electron",
      "resources",
      "llama",
      platformArch,
      binaryName,
    ),
    // backend/src/llamaServer.ts (tsx dev) → ../../electron/resources/llama/...
    path.resolve(
      __dirname,
      "..",
      "..",
      "..",
      "electron",
      "resources",
      "llama",
      platformArch,
      binaryName,
    ),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: rely on system PATH
  return "llama-server";
}

const LLAMA_BIN = resolveLlamaBin();
const LLAMA_PORT = parseInt(process.env.LLAMA_PORT ?? "8012", 10);
const LLAMA_HOST = "127.0.0.1";

/** Remove macOS quarantine attribute and ensure the binary is executable. */
function prepareBinary(binPath: string): void {
  if (process.platform !== "darwin") return;
  try {
    execSync(`xattr -dr com.apple.quarantine "${binPath}"`, { stdio: "pipe" });
  } catch {}
  try {
    fs.chmodSync(binPath, 0o755);
  } catch {}
}
const MODELS_DIR =
  process.env.MODELS_DIR ?? path.resolve(__dirname, "../models");

/** Base URL for the llama-server HTTP API. */
export function getLlamaBaseUrl(): string {
  return process.env.LLAMA_BASE_URL || `http://${LLAMA_HOST}:${LLAMA_PORT}`;
}

/** Check if the llama-server binary is available. */
export function isLlamaServerAvailable(): boolean {
  try {
    prepareBinary(LLAMA_BIN);
    execFileSync(LLAMA_BIN, ["--version"], { timeout: 3000, stdio: "pipe" });
    return true;
  } catch {
    // Also check if the path exists directly (Electron bundles it)
    if (LLAMA_BIN !== "llama-server" && fs.existsSync(LLAMA_BIN)) return true;
    return false;
  }
}

let childProcess: ChildProcess | null = null;
let currentModel: string | null = null;
let currentCtx: number | null = null;
let loadPromise: Promise<void> | null = null;

/** Return the currently loaded model file name (or null). */
export function getCurrentModel(): string | null {
  return currentModel;
}

// ── GPU layer detection ──

/**
 * Decide how many layers to offload to GPU.
 * On Apple Silicon, we have unified memory — offloading everything is fine as
 * long as the model fits comfortably in (total RAM − working-set headroom).
 * For oversized models we partially offload to avoid GPU memory pressure.
 */
function detectNGL(modelSizeBytes = 0): number {
  // Apple Silicon: unified memory, scale by available RAM
  if (process.platform === "darwin" && process.arch === "arm64") {
    const totalRamGb = os.totalmem() / 1024 ** 3;
    const modelGb = modelSizeBytes / 1024 ** 3;
    // Reserve ~6 GB for OS + app + KV cache headroom
    const usableGb = Math.max(4, totalRamGb - 6);
    if (modelGb === 0 || modelGb < usableGb) return 999; // fully offload
    // Model is larger than headroom: partial offload proportional to fit
    const fraction = Math.max(0.3, usableGb / modelGb);
    return Math.max(8, Math.floor(80 * fraction));
  }
  // NVIDIA: offload everything if a GPU is present
  try {
    const nvidiaSmi =
      process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
    const { execFileSync } =
      require("child_process") as typeof import("child_process");
    execFileSync(nvidiaSmi, ["--query-gpu=name", "--format=csv,noheader"], {
      timeout: 3000,
      stdio: "pipe",
    });
    return 999;
  } catch {
    // No NVIDIA GPU or nvidia-smi not found
  }
  // CPU-only
  return 0;
}

// ── Health polling ──

function pollHealth(timeoutMs = 60000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(
        `http://${LLAMA_HOST}:${LLAMA_PORT}/health`,
        (res) => {
          if (res.statusCode === 200) return resolve();
          retry();
        },
      );
      req.on("error", retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(`llama-server health check timed out after ${timeoutMs}ms`),
        );
      }
      setTimeout(check, 500);
    };
    check();
  });
}

// ── Kill helper ──

function killChild(): Promise<void> {
  return new Promise((resolve) => {
    if (!childProcess || childProcess.killed) {
      childProcess = null;
      currentModel = null;
      return resolve();
    }
    const timeout = setTimeout(() => {
      childProcess?.kill("SIGKILL");
    }, 3000);
    childProcess.once("exit", () => {
      clearTimeout(timeout);
      childProcess = null;
      currentModel = null;
      resolve();
    });
    childProcess.kill("SIGTERM");
  });
}

// ── Public API ──

/**
 * Ensure the given model file is loaded in llama-server with the requested
 * context window size. If the model is already running with the same context,
 * the call is a no-op. Otherwise the server is restarted.
 * Pass `numCtxOverride` to request a larger context than the model's default
 * (e.g. for the final analysis-summary synthesis step).
 * Serialized — concurrent calls wait on the same promise.
 */
export function ensureModelLoaded(
  modelFile: string,
  numCtxOverride?: number,
): Promise<void> {
  // Normalize to bare filename
  const file = modelFile.endsWith(".gguf") ? modelFile : modelFile + ".gguf";

  // Determine the context size this call wants.
  const targetCtx = numCtxOverride ?? readModelConfig(MODELS_DIR, file).num_ctx;

  if (
    currentModel === file &&
    currentCtx === targetCtx &&
    childProcess &&
    !childProcess.killed
  ) {
    return Promise.resolve();
  }

  if (loadPromise) {
    // Already loading — chain
    loadPromise = loadPromise.then(() => doLoad(file, targetCtx));
  } else {
    loadPromise = doLoad(file, targetCtx);
  }
  return loadPromise;
}

async function doLoad(file: string, numCtx: number): Promise<void> {
  // Kill existing server if running
  await killChild();

  const modelPath = path.join(MODELS_DIR, file);
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model file not found: ${modelPath}`);
  }

  const modelSize = fs.statSync(modelPath).size;
  const ngl = detectNGL(modelSize);
  const threads = Math.max(1, os.cpus().length - 2);
  const cfg = readModelConfig(MODELS_DIR, file);

  const args = [
    "-m",
    modelPath,
    "--host",
    LLAMA_HOST,
    "--port",
    String(LLAMA_PORT),
    "-c",
    String(numCtx),
    "-ngl",
    String(ngl),
    "-t",
    String(threads),
  ];

  if (cfg.no_mmap) {
    args.push("--no-mmap");
  }

  console.log(`[llama-server] Starting: ${LLAMA_BIN} ${args.join(" ")}`);

  prepareBinary(LLAMA_BIN);

  // GGML_METAL_PATH_RESOURCES tells llama.cpp where to find ggml-metal.metal
  const llamaDir = path.dirname(LLAMA_BIN);

  childProcess = spawn(LLAMA_BIN, args, {
    stdio: "pipe",
    env: {
      ...process.env,
      GGML_METAL_PATH_RESOURCES: llamaDir,
    },
  });

  // Handle spawn errors (e.g. binary not found)
  const spawnError = new Promise<never>((_, reject) => {
    childProcess!.on("error", (err) => {
      console.error(`[llama-server] Spawn error: ${err.message}`);
      childProcess = null;
      currentModel = null;
      loadPromise = null;
      reject(
        new Error(
          `Failed to start llama-server: ${err.message}. ` +
            (LLAMA_BIN === "llama-server"
              ? "Install llama.cpp (brew install llama.cpp) or check the bundled binary."
              : `Binary not found at: ${LLAMA_BIN}`),
        ),
      );
    });
  });

  childProcess.stdout?.on("data", (d: Buffer) =>
    console.log("[llama-server]", d.toString().trimEnd()),
  );
  childProcess.stderr?.on("data", (d: Buffer) =>
    console.log("[llama-server]", d.toString().trimEnd()),
  );

  childProcess.on("exit", (code) => {
    console.log(`[llama-server] exited with code ${code}`);
    if (currentModel === file) {
      currentModel = null;
      currentCtx = null;
    }
  });

  // Wait for health endpoint (or spawn error)
  await Promise.race([pollHealth(), spawnError]);
  currentModel = file;
  currentCtx = numCtx;
  loadPromise = null;
  console.log(`[llama-server] Model loaded: ${file} (ctx=${numCtx})`);
}

/** Unload the current model (kill llama-server). */
export function unloadCurrentModel(): boolean {
  if (!childProcess) return false;
  killChild().catch(() => {});
  return true;
}

/** Graceful shutdown — called on process exit. */
export async function shutdownLlamaServer(): Promise<void> {
  await killChild();
}

// Cleanup on process exit
process.on("SIGTERM", () => void shutdownLlamaServer());
process.on("SIGINT", () => void shutdownLlamaServer());
