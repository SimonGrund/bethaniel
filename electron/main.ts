// ── Electron main process ──
// Spawns the compiled Express backend on a free port, launches llama-server
// via the backend's supervisor, and opens a BrowserWindow pointed at the
// backend's built-in frontend.

import { app, BrowserWindow, shell, dialog } from "electron";
import { ChildProcess, fork } from "child_process";
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

  autoUpdater.on("update-downloaded", () => {
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
  for (const sub of ["data", "results", "models"]) {
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

// ── Resolve the llama-server binary path ──

function findLlamaBin(): string {
  const platformArch = `${process.platform}-${process.arch}`;
  const binaryName =
    process.platform === "win32" ? "llama-server.exe" : "llama-server";

  // In packaged builds: resources/llama/<platform-arch>/llama-server
  const packaged = path.join(
    process.resourcesPath,
    "llama",
    platformArch,
    binaryName,
  );
  if (fs.existsSync(packaged)) return packaged;

  // In dev: electron/resources/llama/<platform-arch>/llama-server
  const dev = path.resolve(
    __dirname,
    "..",
    "electron",
    "resources",
    "llama",
    platformArch,
    binaryName,
  );
  if (fs.existsSync(dev)) return dev;

  // Fallback: system PATH
  return binaryName;
}

// ── Globals ──

let backendProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let backendPort = 4000;
let isQuitting = false;

// ── App lifecycle ──

app.whenReady().then(async () => {
  ensureUserDirs();

  backendPort = IS_DEV ? 4000 : await getFreePort();

  const llamaBin = findLlamaBin();
  const llamaPort = await getFreePort();

  // Environment for the backend child process
  const backendEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(backendPort),
    HOST: "127.0.0.1",
    DATA_DIR: userDataPath("data"),
    RESULTS_DIR: userDataPath("results"),
    MODELS_DIR: userDataPath("models"),
    LLAMA_BIN: llamaBin,
    LLAMA_PORT: String(llamaPort),
    LLAMA_BASE_URL: `http://127.0.0.1:${llamaPort}`,
    NODE_ENV: IS_DEV ? "development" : "production",
  };

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

  mainWindow.loadURL(`http://127.0.0.1:${backendPort}`);

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
