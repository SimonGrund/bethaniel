// ── Getting Betty onto the GPU (Windows) ──
//
// Many Windows machines that could run Betty on their graphics card ran her
// on the processor: the installer's engine is CPU-only, the CUDA build was
// fetched only at launch, silently, for NVIDIA cards whose driver happened to
// be installed, and only took effect after a restart nobody was told about.
//
// Now, alongside the model download (and at startup for an install that
// already has a model):
//
//   1. decide what this machine's GPU can use (gpuDetect.ts);
//   2. download that engine, with progress, into userData (gpuEngine.ts);
//   3. TEST it — `llama-server --list-devices` must name the GPU — before
//      anything depends on it;
//   4. switch to it without a restart (llamaServer.setEngineBinary).
//
// A test that fails leaves the CPU engine in place and is remembered for this
// engine version, so a machine whose card cannot run it is not asked to
// download it again on every launch. A download that fails (a dropped
// connection) is not remembered: the next launch tries again.

import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { fileURLToPath } from "url";

import { detectGpus, hasNvidiaDriver, parseListDevices, planGpuEngine, type GpuEngine, type GpuEnginePlan } from "./gpuDetect.js";
import { hasEngineInstalled, installEngine, type LlamaManifestAsset } from "./gpuEngine.js";
import { getEngineBinary, setEngineBinary } from "./llamaServer.js";
import { emitEvent } from "./logBus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface GpuEngineStatus {
  state:
    | "checking"
    /** Nothing to do: Mac, Linux, no usable GPU. */
    | "not-needed"
    /** An NVIDIA card without NVIDIA's driver. */
    | "needs-driver"
    | "downloading"
    | "testing"
    | "ready"
    | "failed";
  engine?: GpuEngine;
  gpu?: string;
  bytes?: number;
  total?: number;
  error?: string;
}

/** What to do about the GPU engine, given what is on disk. Pure. */
export function gpuEngineAction(input: {
  plan: GpuEnginePlan;
  /** The engine's files are there. */
  installed: boolean;
  /** Tested at this engine version. */
  verifiedVersion: string | null;
  /** A test that failed, at this version — not tried again. */
  failedVersion: string | null;
  version: string;
}): "skip" | "use" | "test" | "install" {
  if (input.plan.engine === "none") return "skip";
  if (input.failedVersion === input.version) return "skip";
  if (input.installed && input.verifiedVersion === input.version) return "use";
  // Installed by an older app (which never tested it), or tested at an older
  // version: test it again rather than trust it.
  if (input.installed && input.verifiedVersion === null) return "test";
  return "install";
}

let status: GpuEngineStatus = { state: "checking" };
let running: Promise<void> | null = null;
let cachedPlan: GpuEnginePlan | null = null;

export function getGpuEngineStatus(): GpuEngineStatus {
  return status;
}

function setStatus(next: GpuEngineStatus): void {
  status = next;
  emitEvent("engine:gpu", status);
}

const engineRoot = () =>
  process.env.BETHANIEL_ENGINE_DIR ?? path.resolve(process.env.DATA_DIR ?? "./data", "..", "engine");

function manifest(): { version: string; assets: Record<string, LlamaManifestAsset> } | null {
  const file = process.env.LLAMA_MANIFEST ?? path.resolve(__dirname, "..", "..", "scripts", "llama-manifest.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Detection runs PowerShell and nvidia-smi: once per session is enough. */
function plan(): GpuEnginePlan {
  cachedPlan ??= planGpuEngine({
    platform: process.platform,
    arch: process.arch,
    gpus: detectGpus(),
    nvidiaDriver: process.platform === "win32" ? hasNvidiaDriver() : false,
  });
  return cachedPlan;
}

/** `llama-server --list-devices`, from the engine's own folder. */
function listDevices(bin: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, ["--list-devices"], { cwd: path.dirname(bin), timeout: 60_000 }, (_err, stdout, stderr) =>
      resolve(`${stdout ?? ""}\n${stderr ?? ""}`),
    );
  });
}

async function run(): Promise<void> {
  const p = plan();
  if (p.engine === "none") {
    setStatus(
      p.reason === "nvidia-needs-driver" ? { state: "needs-driver", gpu: p.gpu } : { state: "not-needed" },
    );
    return;
  }
  const m = manifest();
  const key = `win32-x64-${p.engine}`;
  const asset = m?.assets?.[key];
  if (!m || !asset) {
    setStatus({ state: "failed", engine: p.engine, gpu: p.gpu, error: `no ${key} engine in the manifest` });
    return;
  }
  const dir = path.join(engineRoot(), key);
  const bin = path.join(dir, "llama-server.exe");
  const verifiedFile = path.join(dir, "verified.json");
  const failedFile = path.join(engineRoot(), `${key}.failed.json`);
  const verified = readJson(verifiedFile);
  const failed = readJson(failedFile);
  const action = gpuEngineAction({
    plan: p,
    installed: hasEngineInstalled(dir),
    verifiedVersion: typeof verified?.version === "string" ? verified.version : null,
    failedVersion: typeof failed?.version === "string" ? failed.version : null,
    version: m.version,
  });
  const base = { engine: p.engine, gpu: p.gpu };
  if (action === "skip") {
    setStatus({ state: "failed", ...base, error: typeof failed?.error === "string" ? failed.error : undefined });
    return;
  }
  if (action === "use") {
    setEngineBinary(bin);
    setStatus({ state: "ready", ...base });
    return;
  }
  if (action === "install") {
    setStatus({ state: "downloading", ...base, bytes: 0, total: 0 });
    let last = 0;
    try {
      await installEngine({
        asset,
        finalDir: dir,
        tmpDir: path.join(engineRoot(), ".download-tmp"),
        log: (msg) => console.log(`[gpu-engine] ${msg}`),
        onProgress: (bytes, total) => {
          // A socket event per percent, not per chunk.
          if (total > 0 && Math.floor((bytes / total) * 100) === last) return;
          last = total > 0 ? Math.floor((bytes / total) * 100) : last;
          setStatus({ state: "downloading", ...base, bytes, total });
        },
      });
    } catch (err) {
      // Most likely the connection: not remembered, tried again next launch.
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[gpu-engine] download failed, staying on the CPU engine: ${error}`);
      setStatus({ state: "failed", ...base, error });
      return;
    }
  }

  setStatus({ state: "testing", ...base });
  const devices = parseListDevices(await listDevices(bin)).filter((d) => d.backend === p.engine);
  if (devices.length === 0) {
    const error = `the ${p.engine === "cuda" ? "CUDA" : "Vulkan"} engine does not see the GPU`;
    console.error(`[gpu-engine] ${error}; staying on the CPU engine.`);
    fs.mkdirSync(engineRoot(), { recursive: true });
    fs.writeFileSync(failedFile, JSON.stringify({ version: m.version, error, at: Date.now() }));
    setStatus({ state: "failed", ...base, error });
    return;
  }
  fs.writeFileSync(verifiedFile, JSON.stringify({ version: m.version, engine: p.engine, devices, at: Date.now() }));
  console.log(`[gpu-engine] ${p.engine} engine works on ${devices.map((d) => d.name).join(", ")}; switching to it.`);
  setEngineBinary(bin);
  setStatus({ state: "ready", ...base, gpu: devices[0].name });
}

/** Get the GPU engine ready, if this machine has one to use. Runs once at a
 *  time; never throws. */
export function ensureGpuEngine(): Promise<void> {
  if (status.state === "ready" && getEngineBinary().includes("win32-x64-")) return Promise.resolve();
  running ??= run()
    .catch((err) => {
      setStatus({ state: "failed", error: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      running = null;
    });
  return running;
}
