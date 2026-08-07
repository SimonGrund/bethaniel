// ── Electron main process ──
// Spawns the compiled Express backend on a free port, launches llama-server
// via the backend's supervisor, and opens a BrowserWindow pointed at the
// backend's built-in frontend.

import { app, BrowserWindow, shell, dialog, ipcMain, Menu } from "electron";
import { ChildProcess, fork, execFileSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import { autoUpdater } from "electron-updater";

// ── Paths ──

const IS_DEV = process.env.NODE_ENV === "development";

// ── Auto-updater ──
// Only runs in packaged builds; skipped silently in dev mode.
if (!IS_DEV) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] checking for update...");
  });

  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update available:", info.version);
  });

  autoUpdater.on("update-not-available", (info) => {
    console.log("[updater] up to date:", info.version);
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[updater] download: ${progress.percent.toFixed(1)}%`);
  });

  autoUpdater.on("update-downloaded", () => {
    console.log("[updater] update downloaded, prompting user");
    dialog
      .showMessageBox({
        type: "info",
        title: "Update ready",
        message:
          "A new version of Bethaniel has been downloaded. It will be installed the next time you restart the app.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err?.message ?? err);
  });
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
  const archDirs =
    process.platform === "linux" && process.arch === "x64" && hasNvidiaGpu()
      ? ["linux-x64-vulkan", platformArch]
      : [platformArch];

  for (const arch of archDirs) {
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

// ── IPC: Native file picker for GGUF models ──
ipcMain.handle("dialog:openGguf", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select a GGUF model file",
    filters: [{ name: "GGUF Models", extensions: ["gguf"] }],
    properties: ["openFile"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ── App lifecycle ──

app.whenReady().then(async () => {
  ensureUserDirs();
  buildAppMenu();

  // Stable across launches so the renderer's localStorage origin stays put.
  backendPort = IS_DEV ? 4000 : await resolveBackendPort();

  const llamaBin = findLlamaBin();
  const llamaPort = await getFreePort();

  // Environment for the backend child process
  const backendEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(backendPort),
    HOST: "127.0.0.1",
    DATA_DIR: userDataPath("data"),
    MODELS_DIR: userDataPath("models"),
    LLAMA_BIN: llamaBin,
    LLAMA_PORT: String(llamaPort),
    LLAMA_BASE_URL: `http://127.0.0.1:${llamaPort}`,
    NODE_ENV: IS_DEV ? "development" : "production",
  };

  // LanguageTool (optional grammar server). Point the backend at the bundled
  // jar + JRE if present; otherwise the backend degrades to no grammar checks.
  const ltDir = findLanguageToolDir();
  backendEnv.LANGUAGETOOL_PORT = String(await getFreePort());
  if (ltDir) {
    const jar = path.join(ltDir, "languagetool-server.jar");
    if (fs.existsSync(jar)) backendEnv.LANGUAGETOOL_JAR = jar;
    const javaName = process.platform === "win32" ? "java.exe" : "java";
    const bundledJava = path.join(ltDir, "jre", "bin", javaName);
    if (fs.existsSync(bundledJava)) backendEnv.JAVA_BIN = bundledJava;
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

  // Check for updates a few seconds after launch so the window is settled
  if (!IS_DEV) {
    setTimeout(() => autoUpdater.checkForUpdates(), 5000);
  }

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
