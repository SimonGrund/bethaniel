// ── llama-server supervisor ──
// Manages a single llama-server child process. Supports loading / swapping
// GGUF models, health-polling, and graceful shutdown.

import { ChildProcess, spawn, execFileSync, execSync } from "child_process";
import * as path from "path";
import * as http from "http";
import * as net from "net";
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

/** Whether an NVIDIA GPU is present (used to pick a GPU-enabled binary). */
function hasNvidiaGpu(): boolean {
  try {
    const nvidiaSmi =
      process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
    execFileSync(nvidiaSmi, ["--query-gpu=name", "--format=csv,noheader"], {
      timeout: 3000,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

/** Try to locate the bundled llama-server binary when LLAMA_BIN isn't set. */
function resolveLlamaBin(): string {
  if (process.env.LLAMA_BIN) return process.env.LLAMA_BIN;

  const platformArch = `${process.platform}-${process.arch}`;
  const binaryName =
    process.platform === "win32" ? "llama-server.exe" : "llama-server";

  // On Linux with an NVIDIA GPU, prefer the Vulkan build (vendor-neutral, needs
  // no CUDA toolkit) over the CPU build so models offload to VRAM by default.
  const archDirs =
    process.platform === "linux" && process.arch === "x64" && hasNvidiaGpu()
      ? ["linux-x64-vulkan", platformArch]
      : [platformArch];

  // Resource roots (dev + packaged)
  const roots = [
    // backend/dist/llamaServer.js → ../../electron/resources/llama/...
    path.resolve(__dirname, "..", "..", "electron", "resources", "llama"),
    // backend/src/llamaServer.ts (tsx dev) → ../../../electron/resources/llama/...
    path.resolve(__dirname, "..", "..", "..", "electron", "resources", "llama"),
  ];

  const candidates: string[] = [];
  for (const arch of archDirs) {
    for (const root of roots) {
      candidates.push(path.join(root, arch, binaryName));
    }
  }

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

/**
 * Free the llama-server port by killing any process currently listening on
 * it. This recovers from cases where a previous llama-server child wasn't
 * cleaned up (parent backend killed with SIGKILL, debugger detach, crash,
 * etc.) and the port is still bound when we try to spawn a new one.
 */
function freePort(port: number): void {
  try {
    if (process.platform === "win32") {
      // Windows: parse netstat output for PIDs holding the port.
      const out = execSync(`netstat -ano -p tcp | findstr :${port}`, {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      const pids = new Set<string>();
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/\s(\d+)$/);
        if (m) pids.add(m[1]);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
        } catch {}
      }
    } else {
      // macOS / Linux: lsof returns PIDs holding the TCP port.
      const out = execSync(`lsof -ti tcp:${port}`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (!out) return;
      const pids = out.split(/\s+/).filter(Boolean);
      // Skip our own pid just in case.
      const self = String(process.pid);
      for (const pid of pids) {
        if (pid === self) continue;
        try {
          process.kill(Number(pid), "SIGTERM");
        } catch {}
      }
      // Give them a moment, then SIGKILL stragglers.
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        let stillThere = "";
        try {
          stillThere = execSync(`lsof -ti tcp:${port}`, {
            stdio: ["ignore", "pipe", "ignore"],
          })
            .toString()
            .trim();
        } catch {
          stillThere = "";
        }
        if (!stillThere) return;
        // busy-wait briefly
        const wait = Date.now() + 100;
        while (Date.now() < wait) {
          /* spin */
        }
      }
      try {
        const remaining = execSync(`lsof -ti tcp:${port}`, {
          stdio: ["ignore", "pipe", "ignore"],
        })
          .toString()
          .trim();
        for (const pid of remaining.split(/\s+/).filter(Boolean)) {
          if (pid === self) continue;
          try {
            process.kill(Number(pid), "SIGKILL");
          } catch {}
        }
      } catch {}
    }
  } catch {
    // lsof/netstat returns non-zero when nothing matches — that's fine.
  }
}
const MODELS_DIR =
  process.env.MODELS_DIR ?? path.resolve(__dirname, "../models");

/** Base URL for the llama-server HTTP API. */
export function getLlamaBaseUrl(): string {
  return process.env.LLAMA_BASE_URL || `http://${LLAMA_HOST}:${LLAMA_PORT}`;
}

/**
 * Wait until the kernel will let *us* bind the port. `lsof` returning empty
 * is not enough on its own: after a process exits, the OS keeps the socket
 * in TIME_WAIT (or finalizes a graceful close) for a short period, during
 * which a fresh bind() still fails with EADDRINUSE. Probe by actually
 * binding a throwaway `net.Server` to the same host/port and only proceed
 * once the bind succeeds.
 */
async function waitForPortFree(
  host: string,
  port: number,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => {
        probe.close();
        resolve(false);
      });
      probe.once("listening", () => {
        probe.close(() => resolve(true));
      });
      try {
        probe.listen(port, host);
      } catch {
        resolve(false);
      }
    });
    if (free) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
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
// Parallel slot count the running server was launched with. Tracked so we
// can detect when a new request needs more concurrency than the current
// server can provide (e.g. warm-up loaded with 1 slot, then a real run
// arrives with several queued tasks) and trigger a reload.
let currentParallelSlots: number | null = null;
let loadPromise: Promise<void> | null = null;

/** Return the currently loaded model file name (or null). */
export function getCurrentModel(): string | null {
  return currentModel;
}

// ── GPU layer detection ──

/**
 * Whether a model's weights plus its estimated KV cache fit in the given free
 * VRAM (MiB), with headroom for CUDA buffers. Shared by the offload decision
 * and the catalog's GPU-fit hint so the UI and the loader never disagree.
 */
export function fitsInVram(
  modelSizeBytes: number,
  numCtx: number,
  slots: number,
  freeVramMib: number,
): boolean {
  const modelMib = modelSizeBytes / 1024 ** 2;
  const modelGb = modelSizeBytes / 1024 ** 3;
  const kvPerSlotGb = Math.max(0.3, modelGb * 0.1 * (numCtx / 6144));
  const kvMib = kvPerSlotGb * Math.max(1, slots) * 1024;
  const headroomMib = Math.max(2048, kvMib + 1024);
  return modelMib + headroomMib < freeVramMib;
}

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

// Updated by stdout/stderr handlers in start(); used by pollHealth() to
// extend the deadline while the engine is still making visible progress
// (e.g. mmap'ing a 14 GB GGUF, warming the KV cache).
let lastEngineActivityAt = 0;

// Set by stdout/stderr handlers as soon as llama-server prints its
// "server is listening" marker. This is the authoritative signal that the
// model finished loading and the HTTP server bound the port. Some llama.cpp
// builds return non-200 from /health for several seconds after that line
// (e.g. while finalizing slots), which previously caused us to time out
// even though the server was healthy. Treat the marker as readiness and
// only fall back to /health when it never appears.
let serverListeningSeen = false;

const SERVER_READY_RE =
  /server is listening|HTTP server listening|all slots are idle/i;

function pollHealth(
  idleTimeoutMs = 45_000,
  absoluteTimeoutMs = 900_000,
): Promise<void> {
  const start = Date.now();
  lastEngineActivityAt = start;
  serverListeningSeen = false;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve();
    };
    const check = () => {
      if (settled) return;
      const req = http.get(
        `http://${LLAMA_HOST}:${LLAMA_PORT}/health`,
        (res) => {
          if (res.statusCode === 200) return finish();
          // Drain so the socket can be reused.
          res.resume();
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
      if (settled) return;
      // Authoritative ready signal — llama-server told us it's listening.
      // Give /health one more shot (still healthy responses preferred) but
      // resolve unconditionally after a short grace period if it doesn't.
      if (serverListeningSeen) {
        const sinceMarker = Date.now() - lastEngineActivityAt;
        if (sinceMarker > 5_000) return finish();
      }
      const now = Date.now();
      const idleFor = now - lastEngineActivityAt;
      const totalFor = now - start;
      if (totalFor > absoluteTimeoutMs) {
        return finish(
          new Error(
            `llama-server health check exceeded absolute timeout of ${absoluteTimeoutMs}ms`,
          ),
        );
      }
      if (idleFor > idleTimeoutMs && !serverListeningSeen) {
        return finish(
          new Error(
            `llama-server health check timed out after ${idleTimeoutMs}ms of no engine output ` +
              `(total wait ${totalFor}ms)`,
          ),
        );
      }
      setTimeout(check, 500);
    };
    check();
  });
}

/**
 * Called from the stdout/stderr handlers in doLoad() on every chunk of
 * llama-server output. Extends the idle deadline and flips the
 * "server listening" flag the moment we see the canonical ready marker.
 */
function onEngineOutput(text: string): void {
  lastEngineActivityAt = Date.now();
  if (!serverListeningSeen && SERVER_READY_RE.test(text)) {
    serverListeningSeen = true;
  }
}

// ── Kill helper ──

function killChild(): Promise<void> {
  return new Promise((resolve) => {
    if (!childProcess || childProcess.killed) {
      childProcess = null;
      currentModel = null;
      currentParallelSlots = null;
      return resolve();
    }
    const timeout = setTimeout(() => {
      childProcess?.kill("SIGKILL");
    }, 3000);
    childProcess.once("exit", () => {
      clearTimeout(timeout);
      childProcess = null;
      currentModel = null;
      currentParallelSlots = null;
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

  const requestedSlots = Math.max(1, desiredSlots ?? 1);
  if (
    currentModel === file &&
    currentCtx === targetCtx &&
    (currentParallelSlots ?? 0) >= requestedSlots &&
    childProcess &&
    !childProcess.killed
  ) {
    return Promise.resolve();
  }

  if (loadPromise) {
    // Already loading — wait for the in-flight load and only re-load if
    // the result still doesn't satisfy our request. This prevents a thundering
    // herd of concurrent ensureModelLoaded() calls from kicking off back-to-
    // back restarts of the engine.
    const prev = loadPromise;
    loadPromise = prev.then(() => {
      if (
        currentModel === file &&
        currentCtx === targetCtx &&
        (currentParallelSlots ?? 0) >= requestedSlots &&
        childProcess &&
        !childProcess.killed
      ) {
        return;
      }
      return doLoad(file, targetCtx, desiredSlots);
    });
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

  // Reclaim the port from any stale llama-server (orphaned by a previous
  // backend crash or hard-kill) so the new spawn doesn't fail with
  // "couldn't bind HTTP server socket".
  freePort(LLAMA_PORT);
  // Even after the prior process exits, the OS may keep the socket in
  // TIME_WAIT for a few seconds — wait for a real bind to succeed before
  // handing the port to llama-server.
  const portFree = await waitForPortFree(LLAMA_HOST, LLAMA_PORT, 8000);
  if (!portFree) {
    appendLog({
      level: "warn",
      source: "engine",
      message: `Port ${LLAMA_PORT} still busy after cleanup; launching anyway — llama-server may fail to bind.`,
      model: file,
    });
  }

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
      currentParallelSlots = null;
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
    onEngineOutput(s);
  });
  childProcess.stderr?.on("data", (d: Buffer) => {
    const s = d.toString().trimEnd();
    console.log("[llama-server]", s);
    recentOutput = (recentOutput + "\n" + s).slice(-8000);
    onEngineOutput(s);
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
      currentParallelSlots = null;
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
    // Clear shared state so the next ensureModelLoaded() call doesn't chain
    // on a rejected promise or believe a broken engine is still running.
    loadPromise = null;
    currentModel = null;
    currentCtx = null;
    currentParallelSlots = null;
    try {
      childProcess?.kill("SIGKILL");
    } catch {}
    childProcess = null;
    throw err;
  }
  currentModel = file;
  currentCtx = numCtx;
  currentParallelSlots = parallelSlots;
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
