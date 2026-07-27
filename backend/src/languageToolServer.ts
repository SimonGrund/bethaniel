// ── LanguageTool server supervisor ──
// Manages a single local LanguageTool HTTP server child process (Java). Mirrors
// llamaServer.ts: resolves a bundled distribution, spawns the server on demand,
// health-polls until ready, and shuts down gracefully. Everything degrades to a
// no-op when the LanguageTool distribution or a Java runtime isn't present —
// grammar checking is best-effort and must never break the edit pipeline.
//
// Drop-in layout (see electron/resources/languagetool/):
//   languagetool-server.jar         ← from a LanguageTool desktop/server zip
//   jre/bin/java[.exe]              ← optional bundled JRE (else system `java`)

import { ChildProcess, spawn, execFileSync } from "child_process";
import * as path from "path";
import * as http from "http";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { appendLog } from "./logBus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LT_HOST = "127.0.0.1";
const LT_PORT = parseInt(process.env.LANGUAGETOOL_PORT ?? "8081", 10);

/** Resource roots where the bundled LanguageTool distribution may live. */
function resourceRoots(): string[] {
  return [
    // backend/dist/languageToolServer.js → ../../electron/resources/languagetool
    path.resolve(__dirname, "..", "..", "electron", "resources", "languagetool"),
    // backend/src/languageToolServer.ts (tsx dev) → ../../../electron/resources/languagetool
    path.resolve(__dirname, "..", "..", "..", "electron", "resources", "languagetool"),
  ];
}

/** Absolute path to the LanguageTool server jar, or null if not bundled. */
function resolveJar(): string | null {
  if (process.env.LANGUAGETOOL_JAR && fs.existsSync(process.env.LANGUAGETOOL_JAR)) {
    return process.env.LANGUAGETOOL_JAR;
  }
  for (const root of resourceRoots()) {
    const p = path.join(root, "languagetool-server.jar");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Path to the Java binary: an explicit override, a bundled JRE, or system java. */
function resolveJava(): string {
  if (process.env.JAVA_BIN) return process.env.JAVA_BIN;
  const javaName = process.platform === "win32" ? "java.exe" : "java";
  for (const root of resourceRoots()) {
    const p = path.join(root, "jre", "bin", javaName);
    if (fs.existsSync(p)) return p;
  }
  return "java";
}

/** Base URL for the LanguageTool HTTP API. */
export function getLanguageToolBaseUrl(): string {
  return (
    process.env.LANGUAGETOOL_BASE_URL || `http://${LT_HOST}:${LT_PORT}`
  );
}

/**
 * Whether grammar checking can run: the server jar must be bundled AND a Java
 * runtime resolvable. Returns false (degrade silently) otherwise.
 */
export function isLanguageToolAvailable(): boolean {
  if (process.env.LANGUAGETOOL_DISABLED === "1") return false; // global off-switch
  if (process.env.LANGUAGETOOL_BASE_URL) return true; // external server provided
  if (!resolveJar()) return false;
  const java = resolveJava();
  try {
    execFileSync(java, ["-version"], { timeout: 4000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

let childProcess: ChildProcess | null = null;
let running = false;
let startPromise: Promise<void> | null = null;

/** Poll GET /v2/languages until it returns 200 (server ready) or times out. */
function pollReady(timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  const url = `${getLanguageToolBaseUrl()}/v2/languages`;
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1500, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("LanguageTool server did not become ready in time"));
      }
      setTimeout(check, 500);
    };
    check();
  });
}

/**
 * Ensure the LanguageTool server is running. Serialized — concurrent callers
 * await the same start. No-op when LanguageTool is unavailable, when an
 * external server URL is configured, or when it's already running.
 */
export function ensureLanguageToolRunning(): Promise<void> {
  if (process.env.LANGUAGETOOL_BASE_URL) return Promise.resolve();
  if (running && childProcess && !childProcess.killed) return Promise.resolve();
  if (startPromise) return startPromise;
  if (!isLanguageToolAvailable()) return Promise.resolve();

  startPromise = doStart().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function doStart(): Promise<void> {
  const jar = resolveJar();
  if (!jar) return; // unavailable — degrade
  const java = resolveJava();

  const args = [
    "-cp",
    jar,
    "org.languagetool.server.HTTPServer",
    "--port",
    String(LT_PORT),
    "--allow-origin",
    "*",
  ];

  appendLog({
    level: "info",
    source: "engine",
    message: `Starting LanguageTool grammar server on port ${LT_PORT}…`,
  });

  childProcess = spawn(java, args, { stdio: "pipe" });

  let recentOutput = "";
  const onOut = (d: Buffer) => {
    recentOutput = (recentOutput + d.toString()).slice(-4000);
  };
  childProcess.stdout?.on("data", onOut);
  childProcess.stderr?.on("data", onOut);

  const spawnError = new Promise<never>((_, reject) => {
    childProcess!.on("error", (err) => {
      childProcess = null;
      running = false;
      reject(new Error(`Failed to start LanguageTool: ${err.message}`));
    });
  });
  childProcess.on("exit", (code, signal) => {
    if (running && (code !== 0 || signal)) {
      appendLog({
        level: "warn",
        source: "engine",
        message:
          `LanguageTool server exited unexpectedly` +
          (code !== null ? ` (exit ${code})` : "") +
          (signal ? ` (signal ${signal})` : ""),
      });
    }
    running = false;
    childProcess = null;
  });

  try {
    await Promise.race([pollReady(), spawnError]);
    running = true;
    appendLog({ level: "info", source: "engine", message: "LanguageTool server ready." });
  } catch (err) {
    appendLog({
      level: "warn",
      source: "engine",
      message: `LanguageTool unavailable: ${err instanceof Error ? err.message : String(err)}. Grammar checks skipped.${
        recentOutput ? `\n${recentOutput.split("\n").slice(-4).join("\n")}` : ""
      }`,
    });
    try {
      childProcess?.kill("SIGKILL");
    } catch {}
    childProcess = null;
    running = false;
    // Swallow: grammar checking is best-effort, so a failed start must not
    // reject into the edit pipeline.
  }
}

/** Graceful shutdown — called on process exit. */
export function shutdownLanguageTool(): Promise<void> {
  return new Promise((resolve) => {
    if (!childProcess || childProcess.killed) {
      childProcess = null;
      running = false;
      return resolve();
    }
    const timeout = setTimeout(() => childProcess?.kill("SIGKILL"), 3000);
    childProcess.once("exit", () => {
      clearTimeout(timeout);
      childProcess = null;
      running = false;
      resolve();
    });
    childProcess.kill("SIGTERM");
  });
}

process.on("SIGTERM", () => void shutdownLanguageTool());
process.on("SIGINT", () => void shutdownLanguageTool());
