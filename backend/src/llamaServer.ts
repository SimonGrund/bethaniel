// ── llama-server supervisor ──
// Manages a single llama-server child process. Supports loading / swapping
// GGUF models, health-polling, and graceful shutdown.

import { ChildProcess, spawn, execFileSync, execSync } from "child_process";
import * as path from "path";
import * as http from "http";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { readModelConfig, getCustomGgufPath } from "./modelConfig.js";
import { appendLog, diagnoseEngineExit, emitEvent } from "./logBus.js";
import { getModelByFileName } from "./modelCatalog.js";
import { resolveEnginePort } from "./enginePort.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Friendly display name for a model file, falling back to the bare name. */
function modelDisplayName(file: string): string {
  return getModelByFileName(file)?.name ?? file;
}

/** Whether an NVIDIA GPU is present (used to pick a GPU-enabled binary). */
function hasNvidiaGpu(): boolean {
  try {
    const candidates = process.platform === "win32"
      ? ["nvidia-smi.exe"]
      : ["/usr/bin/nvidia-smi", "nvidia-smi"];
    for (const nvidiaSmi of candidates) {
      try {
        execFileSync(nvidiaSmi, ["--query-gpu=name", "--format=csv,noheader"], {
          timeout: 3000,
          stdio: "pipe",
        });
        return true;
      } catch {
        continue
      }
    }
  } catch {
    // ignore
  }
  return false;
}

/** Try to locate the bundled llama-server binary when LLAMA_BIN isn't set. */
function resolveLlamaBin(): string {
  if (process.env.LLAMA_BIN) return process.env.LLAMA_BIN;

  const platformArch = `${process.platform}-${process.arch}`;
  const binaryName =
    process.platform === "win32" ? "llama-server.exe" : "llama-server";

  // On Linux with an NVIDIA GPU, prefer the Vulkan build (vendor-neutral, needs
  // no CUDA toolkit) over the CPU build so models offload to VRAM by default.
  // On Windows the default bundled build has no GPU backend at all, so an
  // NVIDIA GPU means preferring the CUDA build instead.
  const archDirs =
    process.platform === "linux" && process.arch === "x64" && hasNvidiaGpu()
      ? ["linux-x64-vulkan", platformArch]
      : process.platform === "win32" && hasNvidiaGpu()
        ? ["win32-x64-cuda", platformArch]
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
  return binaryName;
}

/** Platform-specific guidance when no bundled/PATH binary could be started. */
function missingBinaryHint(): string {
  switch (process.platform) {
    case "win32":
      return (
        "The bundled llama-server.exe was not found. Reinstall Bethaniel, " +
        "check Windows Security → Protection history in case antivirus " +
        "quarantined it, or set LLAMA_BIN to a llama-server.exe you already have."
      );
    case "darwin":
      return "Install llama.cpp (brew install llama.cpp) or check the bundled binary.";
    default:
      return (
        "Install llama.cpp (see https://github.com/ggml-org/llama.cpp) " +
        "or check the bundled binary."
      );
  }
}

const LLAMA_BIN = resolveLlamaBin();
/**
 * The port llama-server listens on.
 *
 * Electron passes a freshly-chosen free port in packaged builds. Dev has no
 * such env, so it falls back to a fixed 8012 — which is the only configuration
 * where a leftover engine from a previous session can collide. `activeLlamaPort`
 * holds the port actually in use, so dev can move to a free one when 8012 is
 * stuck rather than launching into a bind failure.
 */
const LLAMA_PORT = parseInt(process.env.LLAMA_PORT ?? "8012", 10);
const LLAMA_PORT_IS_FIXED = process.env.LLAMA_PORT == null;
let activeLlamaPort = LLAMA_PORT;
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
/**
 * Announce an orphaned process we are about to reclaim, with its resident size
 * where the platform will tell us. Best-effort: never let reporting stop the
 * reclaim itself.
 */
function reportReclaim(pid: string, port: number): void {
  let detail = `pid ${pid}`;
  try {
    const ps = execSync(`ps -o rss=,comm= -p ${pid}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const m = ps.match(/^(\d+)\s+(.*)$/);
    if (m) {
      const gb = Number(m[1]) / 1024 / 1024;
      const name = m[2].split("/").pop() ?? m[2];
      detail =
        gb >= 0.1
          ? `${name} (pid ${pid}) holding ${gb.toFixed(1)} GB`
          : `${name} (pid ${pid})`;
    }
  } catch {
    // ps is unavailable or the process just went away — the pid alone will do.
  }
  appendLog({
    level: "info",
    source: "engine",
    message: `Reclaiming an orphaned engine on port ${port}: ${detail}.`,
    hintKey: "log_hint_reclaimed_orphan",
  });
}

function freePort(port: number): void {
  try {
    if (process.platform === "win32") {
      // Windows: parse netstat output for PIDs *listening* on the port.
      //
      // `findstr :${port}` used to grep the whole line, which also matches
      // the Foreign Address column — e.g. this very backend process shows up
      // there for every open HTTP connection it holds to llama-server on
      // this same port. That previously let freePort() taskkill the backend
      // itself (self-inflicted, silent — a forceful taskkill bypasses every
      // Node exit/signal handler, so nothing gets a chance to log it) right
      // as concurrent requests were streaming to a freshly-loaded model.
      // Parsing columns and requiring LISTENING on the *local* port avoids
      // matching a mere client connection.
      const out = execSync(`netstat -ano -p tcp`, {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      const self = String(process.pid);
      const pids = new Set<string>();
      for (const line of out.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        // Proto  Local Address  Foreign Address  State  PID
        if (cols.length < 5 || cols[0] !== "TCP" || cols[3] !== "LISTENING") {
          continue;
        }
        const localPort = cols[1].split(":").pop();
        if (localPort === String(port)) pids.add(cols[4]);
      }
      for (const pid of pids) {
        if (pid === self) continue;
        reportReclaim(pid, port);
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
        // Say what is being reclaimed and from whom. An orphaned engine holds
        // the whole model resident — 6 GB for the 9B, 14 GB for the 24B — so
        // this is often the real answer to "where did my memory go". It also
        // matters that we name the process: freePort kills whatever holds the
        // port, identified only by port number.
        reportReclaim(pid, port);
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
  return process.env.LLAMA_BASE_URL || `http://${LLAMA_HOST}:${activeLlamaPort}`;
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

/**
 * True between spawning an engine and its health check settling. During that
 * window `childProcess` is set but `currentModel` is not, so anything that
 * guards on `childProcess` alone — the idle-unloader did — will SIGTERM a
 * model that is still loading and surface it as "llama-server exited before
 * startup finished".
 */
let loadInFlight = false;

/**
 * Requests currently streaming from the engine. The idle-unloader used to read
 * only the queue's task counters, which go quiet in the gap between one task
 * finishing and the next flipping to "editing" — long enough to kill an engine
 * that agents were still talking to, which reached them as "fetch failed".
 */
let activeRequests = 0;

/**
 * True while a stop we initiated is in flight (idle unload, model swap, app
 * shutdown). killChild sends SIGTERM then SIGKILL, and a bare SIGKILL is
 * otherwise indistinguishable from the OS OOM killer — which is why every
 * deliberate unload used to surface as an out-of-memory warning.
 * Reset when a new engine is spawned.
 */
let deliberateStop = false;
let stopReason: StopReason = "reload";

/**
 * Whether the running engine is actually using a GPU, parsed from its own
 * startup `device_info:` block (e.g. "- CUDA0 : NVIDIA GeForce RTX 5090 ...")
 * rather than assumed from hardware presence — a GPU can be present while
 * the bundled/downloaded build still has no matching backend (see the
 * Windows CPU-only-by-default build and its on-demand CUDA download in
 * electron/gpuEngine.ts). Reset to "unknown" on every fresh spawn.
 */
let detectedDevice: "gpu" | "cpu" | "unknown" = "unknown";
// llama.cpp labels devices by backend in its `device_info:` block. The names
// are abbreviated in some builds and spelled out in others — Apple Silicon
// reports "MTL0" rather than "Metal" (b9279), so matching only the long forms
// left every Mac reading as CPU. BLAS/Accelerate is deliberately absent: it is
// listed alongside the real devices but offloads nothing.
const GPU_DEVICE_LINE_RE =
  /-\s+(CUDA|MTL|Metal|Vulkan|VLK|ROCm|HIP|SYCL|OpenCL|CANN|MUSA)\d*\s*:/i;
const CPU_DEVICE_LINE_RE = /-\s+CPU\d*\s*:/i;

/** Which device, if any, a single line of engine output names. */
export function parseEngineDevice(line: string): "gpu" | "cpu" | null {
  if (GPU_DEVICE_LINE_RE.test(line)) return "gpu";
  if (CPU_DEVICE_LINE_RE.test(line)) return "cpu";
  return null;
}

/**
 * Does the running engine already meet what a caller needs, or must it be
 * restarted?
 *
 * Context is a ceiling, not an exact figure: an engine loaded at 8192 serves a
 * request that needs 4096 perfectly well. Requiring equality here meant that
 * every LLM request — each one passing the context its own chunk happened to
 * need — restarted the engine underneath the agents already streaming from it.
 */
export function engineSatisfies(
  state: {
    model: string | null;
    ctx: number | null;
    slots: number | null;
    alive: boolean;
  },
  want: { model: string; ctx: number; slots: number },
): boolean {
  if (!state.alive || state.model === null) return false;
  if (state.model !== want.model) return false;
  return (state.ctx ?? 0) >= want.ctx && (state.slots ?? 0) >= want.slots;
}

/**
 * Why we are stopping the engine. Threaded through killChild so the exit
 * handler can say which kind of stop it was: every deliberate stop used to log
 * "Model unloaded to free memory", so a storm of reloads read as a storm of
 * idle unloads and pointed diagnosis at the wrong component.
 */
export type StopReason = "reload" | "idle-unload" | "shutdown";

/** How a deliberate stop should be described in the user-facing log. */
export function describeStop(reason: StopReason): string {
  switch (reason) {
    case "reload":
      return "Model stopped to restart it with new settings";
    case "idle-unload":
      return "Model unloaded to free memory";
    case "shutdown":
      return "Model stopped — shutting down";
  }
}

/** Snapshot of the running engine, in the shape engineSatisfies() reads. */
function engineState() {
  return {
    model: currentModel,
    ctx: currentCtx,
    slots: currentParallelSlots,
    alive: !!childProcess && !childProcess.killed,
  };
}

/**
 * May we stop the engine right now?
 *
 * Shutdown always may — the app is going away and a wedged request must not
 * hold it open. An idle unload is an optimisation, so it yields to any work in
 * progress: a load that has not finished, or a request still streaming.
 */
export function mayStopEngine(
  reason: "idle-unload" | "shutdown",
  state: { loadInFlight: boolean; activeRequests: number },
): boolean {
  if (reason === "shutdown") return true;
  return !state.loadInFlight && state.activeRequests === 0;
}

function noteEngineDevice(next: "gpu" | "cpu"): void {
  if (detectedDevice === next) return;
  // A GPU line always wins — CPU is always listed alongside a GPU in the same
  // block, so seeing it after a GPU line must not downgrade the result.
  if (detectedDevice === "gpu" && next === "cpu") return;
  detectedDevice = next;
  emitEvent("engine:device", getEngineDevice());
}

/** GPU/CPU status of the currently running engine, for the UI. `running` is
 *  false (and `device` "unknown") once nothing is loaded — the last engine's
 *  device is not a fact about the next one. */
export function getEngineDevice(): {
  device: "gpu" | "cpu" | "unknown";
  running: boolean;
  model: string | null;
} {
  return { device: detectedDevice, running: currentModel !== null, model: currentModel };
}

/** Return the currently loaded model file name (or null). */
/** Slots the running engine was launched with; 0 when nothing is loaded. */
export function getCurrentParallelSlots(): number {
  return currentParallelSlots ?? 0;
}

export function getCurrentModel(): string | null {
  return currentModel;
}

// ── GPU layer detection ──

let _cachedFreeVramMib: number | null | undefined;

/** Free VRAM in MiB, or null if no NVIDIA GPU / nvidia-smi unavailable. */
function getFreeVramMib(): number | null {
  if (_cachedFreeVramMib !== undefined) return _cachedFreeVramMib;
  const candidates = process.platform === "win32"
    ? ["nvidia-smi.exe"]
    : ["/usr/bin/nvidia-smi", "nvidia-smi"];
  for (const bin of candidates) {
    try {
      const out = execFileSync(
        bin,
        ["--query-gpu=memory.free", "--format=csv,noheader,nounits"],
        { timeout: 3000, stdio: "pipe" },
      ).toString();
      const mib = parseInt(out.split(/\r?\n/)[0].trim(), 10);
      _cachedFreeVramMib = Number.isFinite(mib) && mib > 0 ? mib : null;
    } catch {
      continue;
    }
  }
  if (_cachedFreeVramMib === undefined) _cachedFreeVramMib = null;
  return _cachedFreeVramMib;
}

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
  // Vulkan driver, prompt cache, staging buffers, and command queues
  // consume overhead beyond the model + KV cache. Reserve 20% of free
  // VRAM as a safety margin to avoid OOM crashes at load time.
  return modelMib + headroomMib < freeVramMib * 0.8;
}

/**
 * Decide how many layers to offload to GPU.
 * On Apple Silicon, we have unified memory — offloading everything is fine as
 * long as the model fits comfortably in (total RAM − working-set headroom).
 * For oversized models we partially offload to avoid GPU memory pressure.
 */
function detectNGL(modelSizeBytes = 0, numCtx = 0, slots = 1): number {
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
  // NVIDIA: full offload only if the model + KV cache fits in free VRAM,
  // otherwise stay on CPU to avoid an out-of-memory crash at load time.
  const freeMib = getFreeVramMib();
  if (freeMib !== null) {
    return fitsInVram(modelSizeBytes, numCtx, slots, freeMib) ? 999 : 0;
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
 * Ceiling on concurrent slots for this machine.
 *
 * On unified memory (Apple Silicon) decode is bandwidth-bound, so a third slot
 * subtracts from every other stream instead of adding capacity — measured at
 * ~17.4 tok/s aggregate across 3 slots against 20.9 single-stream on an M1 Pro.
 * The second slot still pays for itself by overlapping prefill.
 *
 * Uses the same platform test as detectNGL above, so the two cannot disagree
 * about what machine they are on.
 */
export function slotCapFor(platform: string, arch: string): number {
  return platform === "darwin" && arch === "arm64" ? 2 : 3;
}

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
  // How many KV caches fit in GPU VRAM after the model weights.
  // Match the 80% safety margin used in fitsInVram().
  const freeVramMib = getFreeVramMib();
  const vramSlots =
    freeVramMib !== null
      ? Math.max(
          1,
          Math.floor(
            Math.max(0, freeVramMib * 0.8 - modelSizeBytes / 1024 ** 2 - 2048) /
              (kvPerSlotGb * 1024),
          ),
        )
      : Infinity;
  // Cap at 3 — on a single GPU (Apple Silicon unified memory), decode is
  // bandwidth-bound so more slots just add KV cache pressure. 2–3 slots
  // still help because prefill can be batched efficiently.
  const hardwareCap = Math.max(
    1,
    Math.min(
      slotCapFor(process.platform, process.arch),
      ramSlots,
      cpuSlots,
      vramSlots,
    ),
  );
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

// Set whenever doLoad() fails (crash-on-launch, health-check timeout, etc).
// A crashed engine leaves every caller waiting on it (dual-editor agents,
// retries) to independently re-trigger a fresh restart the instant the
// failure propagates — observed in practice as 5+ launch attempts within
// under a minute, each crashing the same way. A brief cooldown before the
// next attempt gives a wedged GPU driver/context a moment to settle instead
// of hammering it, without changing behavior on the (common) success path.
let lastLoadFailureAt = 0;
const LOAD_FAILURE_COOLDOWN_MS = 3000;

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
  idleTimeoutMs = 90_000,
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
        `http://${LLAMA_HOST}:${activeLlamaPort}/health`,
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
  const device = parseEngineDevice(text);
  if (device) noteEngineDevice(device);
}

// ── Kill helper ──

function killChild(reason: StopReason = "reload"): Promise<void> {
  stopReason = reason;
  return new Promise((resolve) => {
    if (!childProcess || childProcess.killed) {
      childProcess = null;
      currentModel = null;
      currentParallelSlots = null;
      return resolve();
    }
    // Tell the exit handler this stop was ours. Without it, the SIGKILL below
    // is indistinguishable from the OS OOM killer, and every idle unload was
    // reported to the user as "Out of memory — pick a smaller model".
    deliberateStop = true;
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
  // API models — nothing to load locally
  if (modelFile.startsWith("custom:") && !modelFile.startsWith("custom:gguf"))
    return Promise.resolve();

  if (!modelFile || modelFile.trim().length === 0) {
    return Promise.reject(
      new Error("No model specified — please select a model in Settings."),
    );
  }

  // Custom GGUF — resolve the actual file path from config
  const isCustomGguf = modelFile.startsWith("custom:gguf");
  const file = isCustomGguf
    ? modelFile // use the full prefix as the key for tracking
    : modelFile.endsWith(".gguf")
      ? modelFile
      : modelFile + ".gguf";

  // Determine the context size this call wants.
  const targetCtx = numCtxOverride ?? readModelConfig(MODELS_DIR, file).num_ctx;

  const requestedSlots = Math.max(1, desiredSlots ?? 1);
  const want = { model: file, ctx: targetCtx, slots: requestedSlots };
  if (engineSatisfies(engineState(), want)) {
    return Promise.resolve();
  }

  if (loadPromise) {
    // Already loading — wait for the in-flight load and only re-load if
    // the result still doesn't satisfy our request. This prevents a thundering
    // herd of concurrent ensureModelLoaded() calls from kicking off back-to-
    // back restarts of the engine.
    const prev = loadPromise;
    loadPromise = prev.then(() => {
      if (engineSatisfies(engineState(), want)) return;
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
  if (lastLoadFailureAt) {
    const elapsed = Date.now() - lastLoadFailureAt;
    if (elapsed < LOAD_FAILURE_COOLDOWN_MS) {
      await new Promise((r) =>
        setTimeout(r, LOAD_FAILURE_COOLDOWN_MS - elapsed),
      );
    }
  }

  // Kill existing server if running
  await killChild();

  // Resolve model path: custom GGUF uses user-specified path, others use MODELS_DIR
  const isCustomGguf = file.startsWith("custom:gguf");
  const resolvedPath = isCustomGguf
    ? getCustomGgufPath()
    : path.join(MODELS_DIR, file);
  if (!resolvedPath) {
    appendLog({
      level: "error",
      source: "engine",
      message: `Custom GGUF path not configured. Go to Settings to select a GGUF file.`,
      hintKey: "log_hint_model_missing",
      model: file,
    });
    throw new Error(
      "Custom Betty GGUF path not configured. Go to Settings to select a GGUF file.",
    );
  }
  if (!fs.existsSync(resolvedPath)) {
    appendLog({
      level: "error",
      source: "engine",
      message: `Model file not found: ${isCustomGguf ? resolvedPath : file}`,
      hintKey: "log_hint_model_missing",
      model: file,
    });
    throw new Error(`Model file not found: ${resolvedPath}`);
  }

  const modelSize = fs.statSync(resolvedPath).size;
  // Always get a fresh VRAM reading — the cache may be stale from a
  // prior load or crash, and VRAM must be probed at scheduling time.
  _cachedFreeVramMib = undefined;
  const parallelSlots = detectParallelSlots(modelSize, numCtx, desiredSlots);
  const ngl = detectNGL(modelSize, numCtx, parallelSlots);
  // With full GPU offload the CPU only tokenizes, samples, and evaluates
  // grammars — 2–4 threads is plenty. More threads cause contention in
  // GGML's thread barrier (it syncs on the slowest active core). CPU-only
  // systems need every core for the compute-heavy math.
  const rawThreads = detectThreads();
  const threads = ngl > 0 ? Math.min(4, rawThreads) : rawThreads;
  const cfg = readModelConfig(MODELS_DIR, file);

  // llama-server divides -c evenly across parallel slots, so we multiply
  // to ensure each slot gets the full requested context window.
  const totalCtx = numCtx * parallelSlots;

  // Reclaim the port from any stale llama-server (orphaned by a previous
  // backend crash or hard-kill) so the new spawn doesn't fail with
  // "couldn't bind HTTP server socket".
  freePort(LLAMA_PORT);
  const choice = await resolveEnginePort({
    host: LLAMA_HOST,
    preferred: LLAMA_PORT,
    // Only dev's fixed fallback may step aside; see enginePort.ts.
    movable: LLAMA_PORT_IS_FIXED,
    // The OS can hold the socket in TIME_WAIT briefly after the prior process
    // exits, so give a real bind a few seconds to start succeeding.
    waitMs: 8000,
  });
  if (choice.moved) {
    appendLog({
      level: "info",
      source: "engine",
      message: `Port ${LLAMA_PORT} is held by another process — using ${choice.port} instead.`,
      model: file,
    });
  }
  activeLlamaPort = choice.port;

  const args = [
    "-m",
    resolvedPath,
    "--host",
    LLAMA_HOST,
    "--port",
    String(activeLlamaPort),
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
    // llama-server's automatic GPU-memory-fitting step ("-fit", on by
    // default in newer builds) exists to auto-tune arguments we leave
    // unset — but every arg it would touch (-ngl, -c, -b, -ub) is already
    // explicitly set above, so it has nothing useful to do. Observed
    // hanging past pollHealth()'s 90s idle timeout while loading a 24B
    // model that fits VRAM comfortably (RTX 5090, 32GB) — the load then
    // gets SIGTERM'd as "failed" and silently retried with -ngl 0
    // (CPU-only), a ~15-20x slowdown that looks like "the model is just
    // slow" rather than a load bug. llama-server's own log for this step
    // suggests the same workaround: "for bugs during this step try to
    // reproduce them with -fit off".
    "-fit",
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

  // llama.cpp binaries use $ORIGIN as RUNPATH — they look for libraries in
  // the same directory. The build pipeline copies base .so files but may
  // miss the soname symlinks (e.g. libllama-common.so.0 → libllama-common.so).
  // Create them on the fly so the dynamic linker can resolve NEEDED entries.
  try {
    for (const entry of fs.readdirSync(llamaDir)) {
      if (!entry.endsWith(".so")) continue;
      const soname = entry + ".0";
      const sonamePath = path.join(llamaDir, soname);
      if (fs.existsSync(sonamePath)) continue;
      const baseEntry = path.join(llamaDir, entry);
      try {
        fs.symlinkSync(entry, sonamePath);
      } catch {
        // best-effort — may fail on permission-restricted filesystems
      }
    }
  } catch {
    // best-effort
  }

  // Fresh engine, fresh slate — a stale flag would mask a real crash, and a
  // carried-over device reading would misreport this engine before its own
  // device_info line has even been seen.
  deliberateStop = false;
  detectedDevice = "unknown";
  loadInFlight = true;
  childProcess = spawn(LLAMA_BIN, args, {
    stdio: "pipe",
    env: {
      ...process.env,
      GGML_METAL_PATH_RESOURCES: llamaDir,
    },
  });

  // Rolling tail of llama-server output, used to diagnose crashes.
  let recentOutput = "";

  // Captured by the 'exit' handler below so the load-wait's catch block can
  // pass the real code/signal to diagnoseEngineExit() instead of guessing.
  let lastExitCode: number | null = null;
  let lastExitSignal: NodeJS.Signals | null = null;

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
            (LLAMA_BIN === path.basename(LLAMA_BIN)
              ? missingBinaryHint()
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
    lastExitCode = code;
    lastExitSignal = signal;
    const stoppedByUs = deliberateStop;
    deliberateStop = false;

    // A stop we asked for is not a crash. Say so plainly instead of dressing an
    // idle unload up as an engine failure with memory advice attached.
    if (stoppedByUs) {
      appendLog({
        level: "info",
        source: "engine",
        message: `${describeStop(stopReason)} (${file}).`,
        hintKey: "log_hint_model_unloaded",
        model: file,
      });
      if (currentModel === file) {
        currentModel = null;
        currentCtx = null;
        currentParallelSlots = null;
      }
      return;
    }

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

  // An exit during the load-wait itself is always a failure — no legitimate
  // path exits before the health check ever succeeds. Race it in so a
  // near-instant death (e.g. Windows silently killing an unsigned binary)
  // fails in milliseconds instead of sitting through the full 90s idle-output
  // timeout on every single attempt.
  const exitDuringLoad = new Promise<never>((_, reject) => {
    childProcess!.once("exit", (code, signal) => {
      reject(
        new Error(
          `llama-server exited before startup finished (code ${code ?? "n/a"}, signal ${signal ?? "n/a"})`,
        ),
      );
    });
  });

  // Wait for health endpoint (or spawn error)
  try {
    await Promise.race([pollHealth(), spawnError, exitDuringLoad]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Don't double-log spawn errors (already logged in the 'error' handler).
    if (!msg.startsWith("Failed to start llama-server")) {
      const diag = diagnoseEngineExit(recentOutput, lastExitCode, lastExitSignal);
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
    loadInFlight = false;
    currentModel = null;
    currentCtx = null;
    currentParallelSlots = null;
    lastLoadFailureAt = Date.now();
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
  loadInFlight = false;
  lastLoadFailureAt = 0;
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

/**
 * Unload the current model to reclaim RAM between jobs.
 *
 * Yields to work in progress. `childProcess` alone is not evidence that the
 * engine is idle: it is assigned at spawn, while `currentModel` is only
 * assigned once the health check passes, so guarding on it killed engines that
 * were still loading. Requests in flight matter for the same reason — the gap
 * between one task finishing and the next starting is not idleness.
 */
export function unloadCurrentModel(): boolean {
  if (!childProcess) return false;
  if (!mayStopEngine("idle-unload", { loadInFlight, activeRequests })) {
    console.log(
      `[llama-server] Idle unload skipped — ` +
        `${loadInFlight ? "a load is in flight" : `${activeRequests} request(s) in flight`}.`,
    );
    return false;
  }
  killChild("idle-unload").catch(() => {});
  return true;
}

/**
 * Bracket a request to the engine so the idle-unloader does not stop the model
 * mid-answer. Callers must pair these; llm.ts does it in a try/finally.
 */
export function beginEngineRequest(): void {
  activeRequests++;
}

export function endEngineRequest(): void {
  activeRequests = Math.max(0, activeRequests - 1);
}

/** Graceful shutdown — called on process exit. */
export async function shutdownLlamaServer(): Promise<void> {
  await killChild("shutdown");
}

// Cleanup on process exit
process.on("SIGTERM", () => void shutdownLlamaServer());
process.on("SIGINT", () => void shutdownLlamaServer());
