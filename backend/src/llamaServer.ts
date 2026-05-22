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
import { appendLog, diagnoseEngineExit } from "./logBus.js";
import { getModelByFileName } from "./modelCatalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Friendly display name for a model file, falling back to the bare name. */
function modelDisplayName(file: string): string {
  return getModelByFileName(file)?.name ?? file;
}

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
    // Reserve ~3 GB for OS + app + KV cache headroom
    const usableGb = Math.max(4, totalRamGb - 3);
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

/**
 * Pick a thread count tuned for the active platform.
 * On Apple Silicon with full GPU offload the GPU does ~all the work; CPU
 * threads only handle tokenization/sampling/grammar, so we want a small
 * count of P-cores and to *avoid* E-cores (GGML waits on the slowest
 * thread, so mixing core types hurts throughput).
 */
function detectThreads(): number {
  if (process.platform === "darwin" && process.arch === "arm64") {
    try {
      const out = execSync("sysctl -n hw.perflevel0.physicalcpu", {
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      const pcores = parseInt(out, 10);
      if (Number.isFinite(pcores) && pcores > 0) {
        return Math.min(pcores, 4);
      }
    } catch {
      // sysctl missing or perflevel0 unavailable (older macOS) — fall through
    }
    return 4;
  }
  return Math.max(1, os.cpus().length - 2);
}

// ── Parallel slot detection ──

/**
 * Determine how many parallel inference slots to allocate in llama-server.
 * Each slot gets its own KV cache. We balance available RAM (after model
 * weights) against CPU cores so the server can handle concurrent requests.
 */
export function detectParallelSlots(
  modelSizeBytes: number,
  numCtx: number,
  desiredSlots?: number,
): number {
  const totalRamGb = os.totalmem() / 1024 ** 3;
  const modelGb = modelSizeBytes / 1024 ** 3;
  // Reserve ~4 GB for OS + app overhead
  const usableGb = Math.max(2, totalRamGb - 4);
  // KV cache per slot scales with context and model size.
  const kvPerSlotGb = Math.max(0.3, modelGb * 0.1 * (numCtx / 6144));
  // How many slots fit in remaining RAM after the model weights
  const ramSlots = Math.floor((usableGb - modelGb) / kvPerSlotGb);
  // Don't outrun CPU cores (leave 2 for OS)
  const cpuCount = os.cpus().length;
  const cpuSlots = Math.max(1, cpuCount - 2);
  // Cap at 3 — on a single GPU (Apple Silicon unified memory), decode is
  // bandwidth-bound so more slots just add KV cache pressure. 2–3 slots
  // still help because prefill can be batched efficiently.
  const hardwareCap = Math.max(1, Math.min(3, ramSlots, cpuSlots));
  // If the caller knows how many concurrent jobs are queued, don't allocate
  // KV cache for slots that won't be used. Always allow at least 1.
  const slots = desiredSlots
    ? Math.max(1, Math.min(hardwareCap, desiredSlots))
    : hardwareCap;
  return slots;
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
  desiredSlots?: number,
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
    loadPromise = loadPromise.then(() => doLoad(file, targetCtx, desiredSlots));
  } else {
    loadPromise = doLoad(file, targetCtx, desiredSlots);
  }
  return loadPromise;
}

async function doLoad(
  file: string,
  numCtx: number,
  desiredSlots?: number,
): Promise<void> {
  // Kill existing server if running
  await killChild();

  const modelPath = path.join(MODELS_DIR, file);
  if (!fs.existsSync(modelPath)) {
    appendLog({
      level: "error",
      source: "engine",
      message: `Model file not found: ${file}`,
      hintKey: "log_hint_model_missing",
      model: file,
    });
    throw new Error(`Model file not found: ${modelPath}`);
  }

  const modelSize = fs.statSync(modelPath).size;
  const ngl = detectNGL(modelSize);
  const threads = detectThreads();
  const parallelSlots = detectParallelSlots(modelSize, numCtx, desiredSlots);
  const cfg = readModelConfig(MODELS_DIR, file);

  // llama-server divides -c evenly across parallel slots, so we multiply
  // to ensure each slot gets the full requested context window.
  const totalCtx = numCtx * parallelSlots;

  const args = [
    "-m",
    modelPath,
    "--host",
    LLAMA_HOST,
    "--port",
    String(LLAMA_PORT),
    "-c",
    String(totalCtx),
    "-ngl",
    String(ngl),
    "-t",
    String(threads),
    // Parallel inference slots — allows concurrent request processing.
    "--parallel",
    String(parallelSlots),
    // Flash attention: faster prefill + decode, no output change.
    // Newer llama-server requires an explicit value ('on'|'off'|'auto').
    "-fa",
    "on",
    // Larger prefill batches improve throughput on Metal/CUDA.
    "-b",
    "2048",
    "-ub",
    "512",
    // Disable reasoning/thinking parsing. Qwen3 models would otherwise
    // emit `<think>…</think>` blocks routed to `delta.reasoning_content`,
    // leaving `delta.content` empty and the streaming consumer with zero
    // tokens — which previously caused the editor to silently produce no
    // corrections. With reasoning off, the full response lands in
    // `content` as expected.
    "--reasoning",
    "off",
  ];

  if (cfg.no_mmap) {
    args.push("--no-mmap");
  }

  console.log(
    `[llama-server] Starting: ${LLAMA_BIN} ${args.join(" ")} (parallel=${parallelSlots})`,
  );
  const hintSuffix = desiredSlots
    ? ` for ${desiredSlots} queued task${desiredSlots === 1 ? "" : "s"}`
    : "";
  appendLog({
    level: "info",
    source: "engine",
    message: `Launching model: ${modelDisplayName(file)} (${parallelSlots} parallel slot${parallelSlots === 1 ? "" : "s"}${hintSuffix})`,
    model: file,
  });

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

  // Rolling tail of llama-server output, used to diagnose crashes.
  let recentOutput = "";

  // Handle spawn errors (e.g. binary not found)
  const spawnError = new Promise<never>((_, reject) => {
    childProcess!.on("error", (err) => {
      console.error(`[llama-server] Spawn error: ${err.message}`);
      appendLog({
        level: "error",
        source: "engine",
        message: `Failed to start model engine: ${err.message}`,
        hintKey: "log_hint_binary_missing",
        model: file,
      });
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

  childProcess.stdout?.on("data", (d: Buffer) => {
    const s = d.toString().trimEnd();
    console.log("[llama-server]", s);
    recentOutput = (recentOutput + "\n" + s).slice(-8000);
  });
  childProcess.stderr?.on("data", (d: Buffer) => {
    const s = d.toString().trimEnd();
    console.log("[llama-server]", s);
    recentOutput = (recentOutput + "\n" + s).slice(-8000);
  });

  childProcess.on("exit", (code, signal) => {
    console.log(`[llama-server] exited with code ${code} signal ${signal}`);
    // Abnormal exit while a model was supposed to be running → user-facing log.
    const wasRunning = currentModel === file;
    if (wasRunning && (code !== 0 || signal)) {
      const diag = diagnoseEngineExit(recentOutput, code, signal);
      const tail = recentOutput.split("\n").slice(-6).join("\n").trim();
      appendLog({
        level: diag.level,
        source: "engine",
        message:
          `Model engine crashed while running ${file}` +
          (signal ? ` (signal ${signal})` : "") +
          (code !== null ? ` (exit ${code})` : "") +
          (tail ? `\n${tail}` : ""),
        hintKey: diag.hintKey,
        model: file,
      });
    }
    if (currentModel === file) {
      currentModel = null;
      currentCtx = null;
    }
  });

  // Wait for health endpoint (or spawn error)
  try {
    await Promise.race([pollHealth(), spawnError]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Don't double-log spawn errors (already logged in the 'error' handler).
    if (!msg.startsWith("Failed to start llama-server")) {
      const diag = diagnoseEngineExit(recentOutput, null, null);
      const tail = recentOutput.split("\n").slice(-6).join("\n").trim();
      appendLog({
        level: "error",
        source: "engine",
        message:
          `Model engine did not become ready for ${file}: ${msg}` +
          (tail ? `\n${tail}` : ""),
        hintKey: diag.hintKey,
        model: file,
      });
    }
    throw err;
  }
  currentModel = file;
  currentCtx = numCtx;
  loadPromise = null;
  console.log(
    `[llama-server] Model loaded: ${file} (ctx=${numCtx}, parallel=${parallelSlots})`,
  );
  appendLog({
    level: "info",
    source: "engine",
    message: `Model ready: ${modelDisplayName(file)}`,
    model: file,
  });
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
