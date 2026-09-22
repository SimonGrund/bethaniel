// ── Electron main process ──
// Spawns the compiled Express backend on a free port, launches llama-server
// via the backend's supervisor, and opens a BrowserWindow pointed at the
// backend's built-in frontend.

import {
  app,
  BrowserWindow,
  shell,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerSaveBlocker,
} from "electron";
import { ChildProcess, fork, execFileSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import { autoUpdater } from "electron-updater";
import { downloadCudaEngine, hasCudaEngineInstalled } from "./gpuEngine";
import { installVerdict, type InstallMarker } from "./updateInstallMarker";

// ── Betty in the Cloud: bethaniel:// protocol handoff ──
//
// After a successful cloud-job payment, the Worker's hosted success page
// navigates the system browser to bethaniel://claim?token=...&model=..., the
// OS hands that to this app, and we save the credential the same way
// External Betty's own key is saved — no card details or Stripe session ever
// touch the renderer.
const PROTOCOL = "bethaniel";
if (!app.isDefaultProtocolClient(PROTOCOL)) {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Only one instance may hold the backend's port/data dir at a time. A second
// launch (e.g. the OS opening a bethaniel:// link while the app is already
// running) hands its argv to the first instance via "second-instance" and
// then exits, rather than starting a competing backend.
const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

// ── Paths ──

const IS_DEV = process.env.NODE_ENV === "development";

// ── Auto-updater ──
// Only runs in packaged builds; skipped silently in dev mode.

/** Mirrors UpdateStatus in frontend/src/updateStatus.ts, which owns the
 *  decisions this only reports. Kept as a literal rather than imported:
 *  electron/ does not build against frontend/src. */
type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  /** Quit to install; the swap is still running and this is the old app. */
  | "installing"
  | "error";

interface UpdateStatus {
  phase: UpdatePhase;
  version?: string;
  percent?: number;
  message?: string;
  manual: boolean;
}

let updateStatus: UpdateStatus = { phase: "idle", manual: false };

// ── The note left behind while an update installs ──
//
// On macOS the install runs AFTER the app exits: Squirrel unpacks a 440 MB zip
// and swaps the bundle, which takes minutes. Measured on 2.27.0 — the click at
// ~10:30, the binary replaced at 10:33, the bundle finished at 10:34. Reopen
// inside that window and you get the OLD app, which sees the new version on
// the feed and offers the very update being installed; pressing the button
// again just quits into the same wait.
//
// So the version being installed is written down before quitting and read on
// the way back up. The reading is in updateInstallMarker.ts, pure, because the
// only other way to test it is to cut a release and wait three minutes.

const INSTALL_MARKER = "installing-update.json";

function installMarkerPath(): string {
  return path.join(app.getPath("userData"), INSTALL_MARKER);
}

function readInstallMarker(): InstallMarker | null {
  try {
    return JSON.parse(fs.readFileSync(installMarkerPath(), "utf-8"));
  } catch {
    // Absent is the ordinary case, and unreadable is handled the same way: a
    // half-written file must not strand the app on a banner.
    return null;
  }
}

function writeInstallMarker(version: string | undefined, at: number): void {
  if (!version) return;
  try {
    const marker: InstallMarker = { version, startedAt: at };
    fs.writeFileSync(installMarkerPath(), JSON.stringify(marker));
  } catch (err) {
    // Best effort: losing the note costs a confusing banner, not the update.
    console.error("[updater] could not record the install:", err);
  }
}

function clearInstallMarker(): void {
  try {
    fs.unlinkSync(installMarkerPath());
  } catch {
    /* already gone */
  }
}

/**
 * Is an install from the previous run still finishing?
 *
 * True means the caller must NOT check for updates: the answer is already
 * known, and acting on it would offer the update being installed right now.
 */
function resumeInstallNotice(): boolean {
  const marker = readInstallMarker();
  const verdict = installVerdict(marker, app.getVersion(), Date.now());
  if (verdict === "finished") clearInstallMarker();
  if (verdict !== "installing") return false;
  console.log("[updater] an install of", marker?.version, "is still finishing");
  setUpdateStatus({ phase: "installing", version: marker?.version });
  return true;
}


/** True while a check the USER asked for is in flight. Latched at the request
 *  and read by the events that follow, because electron-updater's events carry
 *  no idea of who asked. */
let updateAskedByUser = false;

function setUpdateStatus(next: Omit<UpdateStatus, "manual">): void {
  updateStatus = { ...next, manual: updateAskedByUser };
  mainWindow?.webContents.send("updates:status", updateStatus);
}

if (!IS_DEV) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] checking for update...");
    setUpdateStatus({ phase: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update available:", info.version);
    // The point of the whole change: say so HERE, when the check returns,
    // rather than when the download finishes. The wait people reported was
    // the download — a hundred-odd megabytes — not the check.
    setUpdateStatus({ phase: "available", version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    console.log("[updater] up to date:", app.getVersion());
    setUpdateStatus({ phase: "up-to-date", version: app.getVersion() });
    updateAskedByUser = false;
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[updater] download: ${progress.percent.toFixed(1)}%`);
    setUpdateStatus({
      phase: "downloading",
      version: updateStatus.version,
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] update downloaded");
    // No dialog. It used to fire here and offer "Restart now", which calls
    // quitAndInstall() and kills whatever job is running — possibly a cloud
    // run the author has paid for. The renderer's banner says the same thing
    // without interrupting, and withholds the button while tasks are running.
    setUpdateStatus({ phase: "downloaded", version: info.version });
    updateAskedByUser = false;
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err?.message ?? err);
    setUpdateStatus({ phase: "error", message: err?.message ?? String(err) });
    updateAskedByUser = false;
  });

  // The install step used to be entirely silent: if quitAndInstall failed, the
  // app simply reopened on the old version with nothing written anywhere. Route
  // electron-updater's own log through ours so the next failure leaves a trace.
  autoUpdater.logger = {
    info: (m: unknown) => console.log("[updater]", m),
    warn: (m: unknown) => console.warn("[updater]", m),
    error: (m: unknown) => console.error("[updater]", m),
    debug: (m: unknown) => console.log("[updater:debug]", m),
  };


}

function resourcePath(...segments: string[]): string {
  const base = IS_DEV ? path.resolve(__dirname, "..") : process.resourcesPath;
  return path.join(base, ...segments);
}

function userDataPath(...segments: string[]): string {
  return path.join(app.getPath("userData"), ...segments);
}

// Ensure user-data sub-dirs exist
function ensureUserDirs(): void {
  for (const sub of ["data", "models"]) {
    const dir = userDataPath(sub);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Find a free TCP port ──

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Could not determine free port")));
      }
    });
    srv.on("error", reject);
  });
}

// ── Stable window origin ──
//
// localStorage is partitioned by ORIGIN, and the origin includes the port. The
// app used to take a fresh random port on every launch, so the renderer got an
// empty store each time: the first-run tour replayed forever and not one
// setting — model, language, edit options, wizard progress — ever survived a
// restart. (One real profile had accumulated 31 dead origins.) Dev never showed
// it because :4000 is fixed.
//
// So: remember the port we settled on and reuse it, keeping the origin stable.

const PORT_FILE = "backend-port.json";

/** True if we can bind this exact port on the loopback interface right now. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function readRememberedPort(): number | null {
  try {
    const raw = fs.readFileSync(userDataPath(PORT_FILE), "utf-8");
    const port = (JSON.parse(raw) as { port?: unknown }).port;
    // Anything privileged or out of range is not something we chose.
    return typeof port === "number" && port > 1024 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function rememberPort(port: number): void {
  try {
    fs.writeFileSync(
      userDataPath(PORT_FILE),
      JSON.stringify({ port }, null, 2) + "\n",
    );
  } catch (err) {
    // Not fatal — the app still runs, it just forgets settings again next time.
    console.error("[port] could not persist the backend port:", err);
  }
}

/** The remembered port when it is still available, otherwise a fresh one. */
async function resolveBackendPort(): Promise<number> {
  const remembered = readRememberedPort();
  if (remembered != null && (await isPortFree(remembered))) return remembered;

  const port = await getFreePort();
  rememberPort(port);
  return port;
}

// One-time cleanup of the origins the old random-port behaviour left behind.
// Runs at module load, before Chromium touches its storage directories, and is
// guarded by a marker file — without the guard this would wipe settings on
// every launch, which is precisely the bug being fixed.
function purgeLegacyOriginStorage(): void {
  if (IS_DEV) return;
  const marker = userDataPath(".origin-reset-done");
  if (fs.existsSync(marker)) return;

  // Claim the marker BEFORE deleting anything. If it cannot be written we skip
  // the purge entirely: repeating it every launch would wipe settings each
  // time, which is the very failure this cleanup exists to end.
  try {
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
  } catch (err) {
    console.error("[storage] skipping stale-origin cleanup:", err);
    return;
  }

  try {
    fs.rmSync(userDataPath("Local Storage"), { recursive: true, force: true });
  } catch (err) {
    console.error("[storage] could not clear stale origins:", err);
  }
}

purgeLegacyOriginStorage();

// ── Wait for backend /health ──

function waitForHealth(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("Backend did not start in time"));
      }
      setTimeout(check, 300);
    };
    check();
  });
}

// ── GPU detection ──

function hasNvidiaGpu(): boolean {
  try {
    const candidates = process.platform === "win32"
      ? ["nvidia-smi.exe"]
      : ["/usr/bin/nvidia-smi", "nvidia-smi"];
    for (const bin of candidates) {
      try {
        execFileSync(bin, ["--query-gpu=name", "--format=csv,noheader"], {
          timeout: 3000,
          stdio: "pipe",
        });
        return true;
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return false;
}

// ── Resolve the llama-server binary path ──

function findLlamaBin(): string {
  const platformArch = `${process.platform}-${process.arch}`;
  const binaryName =
    process.platform === "win32" ? "llama-server.exe" : "llama-server";

  // On Linux with an NVIDIA GPU, prefer the Vulkan build so models offload
  // to VRAM by default. Falls back gracefully to the CPU build otherwise.
  // On Windows the default bundled build has no GPU backend at all, so an
  // NVIDIA GPU means preferring the CUDA build instead.
  const archDirs =
    process.platform === "linux" && process.arch === "x64" && hasNvidiaGpu()
      ? ["linux-x64-vulkan", platformArch]
      : process.platform === "win32" && hasNvidiaGpu()
        ? ["win32-x64-cuda", platformArch]
        : [platformArch];

  for (const arch of archDirs) {
    // Downloaded on demand (Windows CUDA build — see maybeDownloadCudaEngine):
    // userData/engine/<arch>/llama-server.exe
    const downloaded = path.join(userDataPath("engine", arch), binaryName);
    if (fs.existsSync(downloaded)) return downloaded;

    // In packaged builds: resources/llama/<arch>/llama-server
    const packaged = path.join(
      process.resourcesPath,
      "llama",
      arch,
      binaryName,
    );
    if (fs.existsSync(packaged)) return packaged;

    // In dev: electron/resources/llama/<arch>/llama-server
    const dev = path.resolve(
      __dirname,
      "..",
      "electron",
      "resources",
      "llama",
      arch,
      binaryName,
    );
    if (fs.existsSync(dev)) return dev;
  }

  // Fallback: system PATH
  return binaryName;
}

// ── On-demand CUDA engine download (Windows) ──
//
// The bundled Windows build has no GPU backend at all — shipping the CUDA
// build (well over 1 GB once its cuBLAS/cuDART runtime is included) in every
// installer would bloat non-NVIDIA installs for no benefit. Instead: when an
// NVIDIA GPU is detected and no CUDA build is present yet, download one into
// userData in the background (survives app updates, needs no elevated
// permissions) — see gpuEngine.ts. It's picked up the next time the app
// starts — this never blocks or interrupts the current session, and any
// failure just leaves the existing CPU build in place.

function llamaManifestPath(): string {
  return IS_DEV
    ? path.resolve(__dirname, "..", "..", "scripts", "llama-manifest.json")
    : path.join(process.resourcesPath, "llama-manifest.json");
}

function cudaEngineFinalDir(): string {
  return userDataPath("engine", "win32-x64-cuda");
}

/** Never throws — logs and leaves the existing (CPU) build in place on any failure. */
async function maybeDownloadCudaEngine(): Promise<void> {
  try {
    if (process.platform !== "win32") return;
    const finalDir = cudaEngineFinalDir();
    if (hasCudaEngineInstalled(finalDir)) return;
    if (!hasNvidiaGpu()) return;
    // Already resolvable via a bundled/dev copy (e.g. manually dropped in)?
    if (findLlamaBin().includes("win32-x64-cuda")) return;

    console.log(
      "[gpu-engine] NVIDIA GPU detected — downloading the CUDA-accelerated engine in the background (one-time, applies after next restart)...",
    );
    const installed = await downloadCudaEngine({
      manifestPath: llamaManifestPath(),
      finalDir,
      tmpDir: userDataPath("engine", ".download-tmp"),
      log: (m) => console.log(`[gpu-engine] ${m}`),
    });
    if (!installed) return;

    console.log(
      "[gpu-engine] CUDA-accelerated engine installed. It will be used starting next launch.",
    );
    if (Notification.isSupported()) {
      new Notification({
        title: "Bethaniel",
        body: "GPU acceleration is ready — restart Bethaniel to use it.",
      }).show();
    }
  } catch (err) {
    console.error(
      "[gpu-engine] CUDA engine download failed (will keep using the CPU build):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Locate the bundled LanguageTool distribution directory (packaged first, then
 * dev). Returns null when none is present — grammar checking then degrades to a
 * no-op in the backend.
 */
function findLanguageToolDir(): string | null {
  const packaged = path.join(process.resourcesPath, "languagetool");
  if (fs.existsSync(packaged)) return packaged;
  const dev = path.resolve(
    __dirname,
    "..",
    "electron",
    "resources",
    "languagetool",
  );
  if (fs.existsSync(dev)) return dev;
  return null;
}

// ── Globals ──

let backendProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let backendPort = 4000;

// ── Keeping the machine awake while Betty works ──
//
// A job is orchestrated HERE, on this machine, chunk by chunk — even a cloud
// job, where only the inference is remote. So if the machine sleeps, the run
// stops: in-flight requests die, and on the next launch queue.ts marks any
// task still `queued` or `editing` as cancelled, because there is no
// mid-chunk resume. Completed chapters survive; the one in progress does not.
//
// For a cloud job that also costs money. The Worker commits token usage even
// when the client vanishes mid-stream, so the author pays for output they
// never receive — and a part-spent credential is above the auto-refund
// threshold, so it needs a human to settle.
//
// A full-length manuscript is 20-40 minutes of work, which is comfortably
// longer than a default sleep timer. Closing the lid is the realistic way
// this happens, not a deliberate shutdown.
let sleepBlockerId: number | null = null;
let sleepGuardTimer: NodeJS.Timeout | null = null;

async function queueIsBusy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${backendPort}/api/queue/status`);
    if (!res.ok) return false;
    const tasks = (await res.json()) as Record<string, { status?: string }>;
    return Object.values(tasks).some(
      (t) => t?.status === "queued" || t?.status === "editing",
    );
  } catch {
    // Backend not up, or shutting down. Not a reason to hold the machine
    // awake — release rather than assume the worst.
    return false;
  }
}

/**
 * Poll rather than push, because the queue's own updates go over Socket.IO to
 * the renderer and the main process is not a client of it. A 15s poll against
 * localhost is cheap, and 15s of drift on a timer measured in minutes does
 * not matter.
 */
function startSleepGuard(): void {
  if (sleepGuardTimer) return;
  sleepGuardTimer = setInterval(async () => {
    const busy = await queueIsBusy();
    if (busy && sleepBlockerId === null) {
      // `prevent-app-suspension` stops the SYSTEM sleeping while still
      // allowing the display to switch off — the screen going dark during a
      // 40-minute edit is fine; the machine suspending is not.
      sleepBlockerId = powerSaveBlocker.start("prevent-app-suspension");
      console.log("[power] job running — holding the machine awake");
    } else if (!busy && sleepBlockerId !== null) {
      powerSaveBlocker.stop(sleepBlockerId);
      sleepBlockerId = null;
      console.log("[power] queue idle — released");
    }
  }, 15_000);
  // Never keep the process alive on this timer's account.
  sleepGuardTimer.unref?.();
}

function releaseSleepGuard(): void {
  if (sleepGuardTimer) {
    clearInterval(sleepGuardTimer);
    sleepGuardTimer = null;
  }
  if (sleepBlockerId !== null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}
let isQuitting = false;

// ── Uninstall ──
//
// Only Windows has a real uninstaller hook (build/installer.nsh prompts there).
// macOS has none at all — drag-to-Trash would silently strand >20 GB of models
// in ~/Library/Application Support — and apt's postrm runs as root and
// non-interactively, so it can't safely touch a user's home dir. This menu item
// is the cross-platform answer: it always offers to reclaim the data, and on
// macOS it also trashes the app bundle.

/** GET the backend's storage breakdown so the dialog can show a real number. */
function fetchStorageUsage(port: number): Promise<{ total: number } | null> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/api/storage/usage`,
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw) as { total: number });
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(4000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/**
 * Delete everything under userData — the backend is already torn down.
 *
 * This used to remove only `data` and `models`, which quietly broke the
 * promise on the checkbox: the renderer's Chromium profile stayed behind, so
 * `Local Storage` kept the language, model choice and the "seen the intro"
 * flag, and several hundred MB of `Cache` survived a "delete everything".
 * A reinstall then looked blank but wasn't — no first-run tour, old settings.
 *
 * Windows already did the right thing (`RMDir /r "$APPDATA\Bethaniel"` in
 * build/installer.nsh); this brings macOS and Linux in line.
 */
function removeUserData(): void {
  const root = app.getPath("userData");
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    console.error("[uninstall] could not remove user data:", err);
  }
}

async function runUninstall(): Promise<void> {
  const usage = await fetchStorageUsage(backendPort);
  const sizeLabel = usage ? ` (${formatBytes(usage.total)})` : "";

  const isMac = process.platform === "darwin";
  const detail = isMac
    ? "Bethaniel will be moved to the Trash."
    : "This will close Bethaniel and open the system uninstaller.";

  const { response, checkboxChecked } = await dialog.showMessageBox({
    type: "warning",
    title: "Uninstall Bethaniel",
    message: "Uninstall Bethaniel?",
    detail,
    checkboxLabel: `Also delete my downloaded models, manuscripts and settings${sizeLabel}`,
    checkboxChecked: false,
    buttons: ["Cancel", "Uninstall"],
    defaultId: 0,
    cancelId: 0,
  });
  if (response !== 1) return;

  if (checkboxChecked) {
    const confirm = await dialog.showMessageBox({
      type: "warning",
      title: "Delete all data?",
      message: `Permanently delete ${usage ? formatBytes(usage.total) : "all"} of local data?`,
      detail:
        "Your downloaded models, uploaded manuscripts, edit history and saved API key will be removed. This cannot be undone.",
      buttons: ["Cancel", "Delete everything"],
      defaultId: 0,
      cancelId: 0,
    });
    if (confirm.response !== 1) return;
  }

  // Stop the backend (and, through it, llama-server + LanguageTool) so no
  // process is holding a handle on the model files we are about to unlink.
  isQuitting = true;
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (checkboxChecked) removeUserData();

  if (isMac) {
    try {
      // .../Bethaniel.app/Contents/MacOS/Bethaniel → .../Bethaniel.app
      const appBundle = path.resolve(app.getPath("exe"), "..", "..", "..");
      if (appBundle.endsWith(".app")) await shell.trashItem(appBundle);
    } catch (err) {
      console.error("[uninstall] could not trash the app bundle:", err);
      dialog.showMessageBox({
        type: "info",
        title: "Almost done",
        message: "Your data has been removed.",
        detail:
          "Bethaniel could not move itself to the Trash — please drag it there from your Applications folder.",
      });
    }
  } else if (process.platform === "win32") {
    // electron-builder's oneClick NSIS installer puts the uninstaller beside
    // the app. Launching it hands over to build/installer.nsh.
    const uninstaller = path.resolve(
      app.getPath("exe"),
      "..",
      "Uninstall Bethaniel.exe",
    );
    if (fs.existsSync(uninstaller)) shell.openPath(uninstaller);
    else shell.openPath("appwiz.cpl");
  } else {
    dialog.showMessageBox({
      type: "info",
      title: "Finish in your package manager",
      message: checkboxChecked
        ? "Your data has been removed."
        : "Your data has been kept.",
      detail:
        "Remove the application itself with:  sudo apt remove bethaniel\n(or delete the AppImage file).",
    });
  }

  app.quit();
}

/** Application menu — the app ran on Electron's default menu before this. */
function buildAppMenu(): void {
  const isMac = process.platform === "darwin";
  const uninstallItem: Electron.MenuItemConstructorOptions = {
    label: "Uninstall Bethaniel…",
    click: () => void runUninstall(),
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: "Bethaniel",
            submenu: [
              { role: "about" },
              { type: "separator" },
              uninstallItem,
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: isMac
        ? [{ role: "close" }]
        : [uninstallItem, { type: "separator" }, { role: "quit" }],
    },
    { label: "Edit", role: "editMenu" },
    { label: "View", role: "viewMenu" },
    { label: "Window", role: "windowMenu" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A file dialog needs the app window as its parent. Without one it is not
// modal, and on Windows it can open BEHIND the window that asked for it, with
// no focus — which from the user's chair is a button that does nothing.
// (That is what "Export as PDF" looked like.)
function dialogParent(): BrowserWindow | undefined {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

// ── IPC: Native file picker for GGUF models ──
ipcMain.handle("dialog:openGguf", async () => {
  const parent = dialogParent();
  const options = {
    title: "Select a GGUF model file",
    filters: [{ name: "GGUF Models", extensions: ["gguf"] }],
    properties: ["openFile" as const],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── IPC: open a Stripe Checkout URL in the system browser ──
// Routed through the main process (rather than window.open) so the renderer
// can show a "waiting for payment" state instead of firing and forgetting.
ipcMain.handle("cloud:openCheckout", (_event, url: unknown) => {
  if (typeof url === "string" && url.startsWith("https://")) {
    shell.openExternal(url);
  }
});

// ── IPC: render an HTML report to PDF ──
// The renderer hands over a complete document — its own markup with the
// stylesheet inlined — and this draws it in a window nobody sees, prints it,
// and asks where to put the file. Done here rather than with window.print()
// because the print dialog cannot be told to print only the report, and
// "Save as PDF" is buried in it on every platform.
ipcMain.handle(
  "report:exportPdf",
  async (_event, html: unknown, suggestedName: unknown): Promise<string | null> => {
    if (typeof html !== "string" || html.length > 20_000_000) return null;
    const name =
      typeof suggestedName === "string" && suggestedName.trim()
        ? suggestedName.replace(/[\\/:*?"<>|]+/g, "-").trim()
        : "report";
    const parent = dialogParent();
    const options = {
      title: "Save report as PDF",
      defaultPath: path.join(app.getPath("documents"), `${name}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    };
    const { canceled, filePath } = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return null;

    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
      // Fonts and layout settle a moment after load; printing at once
      // occasionally caught the page half-styled.
      await new Promise((r) => setTimeout(r, 300));
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
        margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      });
      await fs.promises.writeFile(filePath, pdf);
      return filePath;
    } finally {
      win.destroy();
    }
  },
);

// ── Updates ──

ipcMain.handle("app:version", () => app.getVersion());

ipcMain.handle("updates:check", () => {
  // Dev has no updater. Answer honestly rather than leaving the button
  // spinning forever on a promise nothing will settle.
  if (IS_DEV) {
    updateAskedByUser = true;
    setUpdateStatus({ phase: "up-to-date", version: app.getVersion() });
    updateAskedByUser = false;
    return;
  }
  updateAskedByUser = true;
  void autoUpdater.checkForUpdates();
});

ipcMain.handle("updates:restart", (_event, copy?: GoodbyeCopy) => {
  if (IS_DEV) return;
  // An ORDINARY quit, not autoUpdater.quitAndInstall().
  //
  // quitAndInstall was tried twice and does not install in this app: the
  // update downloads and verifies, the app quits and reopens, and it reopens
  // on the old version. Measured on 2.26.0, which already carried a fix for
  // it — the staged zip sat intact in the updater cache, containing the right
  // version, while the app relaunched as the version it was replacing.
  //
  // Quitting normally DOES install it, because autoInstallOnAppQuit is true,
  // and that has now been confirmed on a real machine more than once. So this
  // does exactly what Cmd-Q does and nothing more. The cost is that the app
  // does not come back by itself, which is why the button says so and the
  // banner asks the author to open it again.
  //
  // Deliberately no special casing around the quit: the ordinary path is the
  // one that is known to work, and making it less ordinary is what got us
  // here.
  // Write down what is being installed. Reopening during the swap gets the OLD
  // app, which would otherwise offer this same update again; the note is how
  // the next launch knows better.
  writeInstallMarker(updateStatus.version, Date.now());

  // Somewhere to say goodbye. The main window is about to go and the install
  // then runs for minutes with nothing on screen, which is the whole reason
  // people reopen too early.
  //
  // Guarded: this panel is cosmetic, and failing to draw it must not be the
  // thing that stops an update from installing.
  try {
    showQuittingWindow(copy);
  } catch (err) {
    console.error("[updater] could not show the quitting window:", err);
  }

  setTimeout(() => {
    console.log("[updater] quitting to let the staged update install");
    app.quit();
  }, GOODBYE_MS);
});

/** Already translated by the renderer, where the four languages live. */
interface GoodbyeCopy {
  title?: string;
  body?: string;
}

/** Long enough to read two sentences, short enough not to feel stuck. */
const GOODBYE_MS = 4000;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Replace the main window with a small panel saying what is happening.
 *
 * The English fallbacks are for a renderer that calls without copy — an older
 * preload should still say something true rather than nothing.
 */
function showQuittingWindow(copy?: GoodbyeCopy): void {
  const version = updateStatus.version ?? "";
  const title = copy?.title ?? `Installing Bethaniel ${version}`.trim();
  const body =
    copy?.body ??
    "Bethaniel is closing so the update can install. Unpacking takes a few " +
      "minutes — wait a little before opening it again.";

  // Inlined into a data URL: no file to package, and no server to reach in the
  // seconds after the backend has been told to stop.
  const html = `<!doctype html><meta charset="utf-8"><style>
    :root { color-scheme: light }
    body { margin:0; height:100vh; display:flex; gap:18px; align-items:center;
      padding:0 28px; box-sizing:border-box;
      background:#f6efe2; color:#3b2f24;
      font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      -webkit-user-select:none; -webkit-app-region:drag }
    .spinner { width:26px; height:26px; flex:0 0 26px; border-radius:50%;
      border:3px solid rgba(59,47,36,.18); border-top-color:#8a6a3b;
      animation:spin 1s linear infinite }
    @keyframes spin { to { transform:rotate(360deg) } }
    h1 { margin:0 0 4px; font-size:15px; font-weight:600 }
    p { margin:0; opacity:.78 }
  </style>
  <div class="spinner"></div>
  <div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div>`;

  const win = new BrowserWindow({
    width: 470,
    height: 150,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: "Bethaniel",
    backgroundColor: "#f6efe2",
    show: false,
    webPreferences: { sandbox: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  win.once("ready-to-show", () => win.show());

  // Created BEFORE the main window closes: window-all-closed quits the app,
  // and quitting there would skip the goodbye entirely.
  mainWindow?.close();
}

/** The current status, for a renderer that loaded after the last event. */
ipcMain.handle("updates:current", () => updateStatus);

// ── Betty in the Cloud: bethaniel:// deep-link handoff ──

let pendingDeepLink: string | null = null;
let backendReady = false;

/** Claim a cloud credential by saving it into the same api-config store
 *  External Betty's own key lives in, keyed to the "bethaniel-cloud" entry. */
async function claimCloudCredential(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== `${PROTOCOL}:`) return;
  // Electron parses "bethaniel://claim?token=..." with the host as "claim"
  // (custom schemes have no real authority component).
  if (parsed.hostname !== "claim" && parsed.pathname !== "/claim") return;

  const token = parsed.searchParams.get("token");
  if (!token) return;
  // The Worker always sends its own PROVIDER_MODEL, so the fallback only
  // fires if that is missing. It must therefore name a model the Worker can
  // actually serve — a stale default here silently configures a paid
  // credential to request something the proxy will reject.
  const model = parsed.searchParams.get("model") || "Qwen3.5-9B";

  try {
    await fetch(`http://127.0.0.1:${backendPort}/api/models/custom/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entryId: "bethaniel-cloud", apiKey: token, model }),
    });
    mainWindow?.webContents.send("cloud:credentialClaimed", { ok: true });
  } catch (err) {
    console.error("[cloud] failed to save claimed credential:", err);
    mainWindow?.webContents.send("cloud:credentialClaimed", {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

/** Cold starts (Windows/Linux) and second-instance launches may arrive before
 *  the backend has a port to PUT the credential to — queue until ready. */
function handleDeepLinkOrQueue(url: string): void {
  if (!url.startsWith(`${PROTOCOL}://`)) return;
  if (backendReady) void claimCloudCredential(url);
  else pendingDeepLink = url;
}

// macOS delivers the URL via this event, even for a cold start.
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLinkOrQueue(url);
});

// Windows/Linux: a second launch (from the OS opening the link) hands its
// argv to the already-running instance instead of starting a new one.
app.on("second-instance", (_event, argv) => {
  const url = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
  if (url) handleDeepLinkOrQueue(url);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Windows/Linux cold start: the link is a plain argv entry on first launch.
const argvDeepLink = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`));
if (argvDeepLink) pendingDeepLink = argvDeepLink;

// ── App lifecycle ──

app.whenReady().then(async () => {
  ensureUserDirs();
  buildAppMenu();

  // Stable across launches so the renderer's localStorage origin stays put.
  backendPort = IS_DEV ? 4000 : await resolveBackendPort();

  const llamaBin = findLlamaBin();

  // Environment for the backend child process
  const backendEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(backendPort),
    HOST: "127.0.0.1",
    DATA_DIR: userDataPath("data"),
    MODELS_DIR: userDataPath("models"),
    LLAMA_BIN: llamaBin,
    // No LLAMA_PORT / LLAMA_BASE_URL: the engine's port is the backend's to
    // choose, at the moment it launches the engine. Picking one here — minutes
    // earlier, out of the range the OS reassigns at will — looked like a
    // reservation but was not one, and the engine died binding a port that had
    // since been handed to someone else. See backend/src/enginePort.ts.
    NODE_ENV: IS_DEV ? "development" : "production",
  };

  // LanguageTool (optional grammar server). Point the backend at the bundled
  // jar + JRE if present; otherwise the backend degrades to no grammar checks.
  const ltDir = findLanguageToolDir();
  if (ltDir) {
    const jar = path.join(ltDir, "languagetool-server.jar");
    if (fs.existsSync(jar)) backendEnv.LANGUAGETOOL_JAR = jar;
    const javaName = process.platform === "win32" ? "java.exe" : "java";
    // Packaged: electron-builder lands this arch's JRE at jre/. In dev the
    // build script leaves one per arch as jre-<os>-<arch>/ (see
    // scripts/fetch-languagetool.mjs), and a hand-placed jre/ still wins.
    const os =
      process.platform === "darwin"
        ? "mac"
        : process.platform === "win32"
          ? "win"
          : "linux";
    const bundledJava = [
      path.join(ltDir, "jre", "bin", javaName),
      path.join(ltDir, `jre-${os}-${process.arch}`, "bin", javaName),
    ].find((candidate) => fs.existsSync(candidate));
    if (bundledJava) backendEnv.JAVA_BIN = bundledJava;
  }

  if (!IS_DEV) {
    // Spawn the compiled backend as a child process
    const backendEntry = resourcePath("backend", "dist", "index.js");
    backendProcess = fork(backendEntry, [], {
      env: backendEnv,
      stdio: "pipe",
    });

    backendProcess.stdout?.on("data", (d: Buffer) =>
      console.log("[backend]", d.toString().trimEnd()),
    );
    backendProcess.stderr?.on("data", (d: Buffer) =>
      console.error("[backend]", d.toString().trimEnd()),
    );

    backendProcess.on("exit", (code) => {
      console.log(`[backend] exited with code ${code}`);
      if (!isQuitting) {
        // Unexpected crash — quit the app
        app.quit();
      }
    });

    try {
      await waitForHealth(backendPort);
    } catch (err) {
      console.error("Backend failed to start:", err);
      app.quit();
      return;
    }
  }

  backendReady = true;
  startSleepGuard();

  // Create the main window
  const iconPath = IS_DEV
    ? path.join(__dirname, "..", "build", "icon.png")
    : path.join(process.resourcesPath, "icon.png");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    title: "Bethaniel",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // In dev mode, load the Vite dev server (HMR) which proxies /api to the backend.
  // In production, load the backend which serves the built frontend.
  const loadURL = IS_DEV
    ? "http://localhost:5173"
    : `http://127.0.0.1:${backendPort}`;
  mainWindow.loadURL(loadURL);

  // Flush a deep link that arrived before the window existed to receive it
  // (a cold start via bethaniel://claim) once the renderer is actually up.
  mainWindow.webContents.once("did-finish-load", () => {
    if (pendingDeepLink) {
      const url = pendingDeepLink;
      pendingDeepLink = null;
      void claimCloudCredential(url);
    }
    // The moment the renderer can receive an answer. The five-second timer
    // this replaces bought nothing: it delayed asking a question whose answer
    // had nowhere to go, and the delay people actually noticed was the
    // download that follows.
    // An install still finishing answers the question already, and checking
    // would offer the very update that is at this moment being installed.
    if (!IS_DEV && !resumeInstallNotice()) void autoUpdater.checkForUpdates();
  });

  // Kick off the on-demand CUDA engine download (Windows + NVIDIA GPU only,
  // no-op otherwise) well after launch so it never competes with startup.
  setTimeout(() => void maybeDownloadCudaEngine(), 10_000);

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
});

// Mark quitting so the backend exit handler doesn't force-quit

app.on("before-quit", () => {
  isQuitting = true;
  releaseSleepGuard();

  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // macOS dock click — recreate window
    if (mainWindow === null) {
      const iconPath2 = IS_DEV
        ? path.join(__dirname, "..", "build", "icon.png")
        : path.join(process.resourcesPath, "icon.png");

      const win = new BrowserWindow({
        width: 1280,
        height: 900,
        title: "Bethaniel",
        icon: iconPath2,
        webPreferences: {
          preload: path.join(__dirname, "preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      win.loadURL(`http://127.0.0.1:${backendPort}`);
      mainWindow = win;
    }
  }
});
