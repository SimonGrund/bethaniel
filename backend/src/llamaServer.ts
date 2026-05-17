// ── llama-server supervisor ──
// Manages a single llama-server child process. Supports loading / swapping
// GGUF models, health-polling, and graceful shutdown.

import { ChildProcess, spawn, execFileSync } from "child_process";
import * as path from "path";
import * as http from "http";
import * as os from "os";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { readModelConfig } from "./modelConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LLAMA_BIN = process.env.LLAMA_BIN ?? "llama-server";
const LLAMA_PORT = parseInt(process.env.LLAMA_PORT ?? "8012", 10);
const LLAMA_HOST = "127.0.0.1";
const MODELS_DIR = process.env.MODELS_DIR ?? path.resolve(__dirname, "../models");

/** Base URL for the llama-server HTTP API. */
export function getLlamaBaseUrl(): string {
  return process.env.LLAMA_BASE_URL || `http://${LLAMA_HOST}:${LLAMA_PORT}`;
}

/** Check if the llama-server binary is available. */
export function isLlamaServerAvailable(): boolean {
  try {
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
let loadPromise: Promise<void> | null = null;

/** Return the currently loaded model file name (or null). */
export function getCurrentModel(): string | null {
  return currentModel;
}

// ── GPU layer detection ──

function detectNGL(): number {
  // Apple Silicon: offload everything to Metal
  if (process.platform === "darwin" && process.arch === "arm64") {
    return 999;
  }
  // NVIDIA: offload everything
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
 * Ensure the given model file is loaded in llama-server.
 * If a different model is currently loaded, the server is restarted.
 * Serialized — concurrent calls wait on the same promise.
 */
export function ensureModelLoaded(modelFile: string): Promise<void> {
  // Normalize to bare filename
  const file = modelFile.endsWith(".gguf") ? modelFile : modelFile + ".gguf";

  if (currentModel === file && childProcess && !childProcess.killed) {
    return Promise.resolve();
  }

  if (loadPromise) {
    // Already loading — chain
    loadPromise = loadPromise.then(() => doLoad(file));
  } else {
    loadPromise = doLoad(file);
  }
  return loadPromise;
}

async function doLoad(file: string): Promise<void> {
  // Kill existing server if running
  await killChild();

  const modelPath = path.join(MODELS_DIR, file);
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Model file not found: ${modelPath}`);
  }

  const ngl = detectNGL();
  const threads = Math.max(1, os.cpus().length - 2);
  const config = readModelConfig(MODELS_DIR, file);

  const args = [
    "-m",
    modelPath,
    "--host",
    LLAMA_HOST,
    "--port",
    String(LLAMA_PORT),
    "-c",
    String(config.num_ctx),
    "-ngl",
    String(ngl),
    "-t",
    String(threads),
    "--no-mmap",
  ];

  console.log(`[llama-server] Starting: ${LLAMA_BIN} ${args.join(" ")}`);

  childProcess = spawn(LLAMA_BIN, args, {
    stdio: "pipe",
    env: { ...process.env },
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
              ? "Install llama.cpp (brew install llama.cpp) or use an Ollama model instead."
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
    }
  });

  // Wait for health endpoint (or spawn error)
  await Promise.race([pollHealth(), spawnError]);
  currentModel = file;
  loadPromise = null;
  console.log(`[llama-server] Model loaded: ${file}`);
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
