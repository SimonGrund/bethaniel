// ── Backend entry point — Express + Socket.IO ──
// Serves API at /api, Socket.IO at /socket.io, and the built React
// frontend as static files at /. One process, one port.

import express from "express";
import { createServer } from "http";
import { Server as SocketServer } from "socket.io";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import routes from "./routes.js";
import {
  initQueue,
  closeQueue,
  getClientSnapshot,
  failActiveTasks,
} from "./queue.js";
import { closeDb } from "./db.js";
import { shutdownLlamaServer } from "./llamaServer.js";
import { shutdownLanguageTool } from "./languageToolServer.js";
import { setLogIo, getLogSnapshot, appendLog } from "./logBus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? "4000", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

// In production: dist/index.js → ../public → bundled frontend
// In dev (tsx): src/index.ts → ../public (we still build the frontend)
const FRONTEND_DIR =
  process.env.FRONTEND_DIR ?? path.resolve(__dirname, "../public");

const app = express();
const httpServer = createServer(app);

app.use(express.json({ limit: "100mb" }));

const io = new SocketServer(httpServer, {
  // Same-origin in production; permissive in dev to allow Vite (5173)
  cors:
    process.env.NODE_ENV === "development"
      ? { origin: ["http://localhost:5173"], methods: ["GET", "POST"] }
      : undefined,
});

io.on("connection", (socket) => {
  socket.emit("queue:update", getClientSnapshot());
  socket.emit("log:snapshot", getLogSnapshot());
});

// API
(routes as any)._io = io;
setLogIo(io);
app.use("/api", routes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: Date.now() });
});

// Static frontend (production / packaged mode)
async function setupStaticFrontend() {
  try {
    await fs.access(FRONTEND_DIR);
    app.use(express.static(FRONTEND_DIR));
    // SPA fallback — serve index.html for non-API routes
    app.get(/^\/(?!api|socket\.io|health).*/, (_req, res) => {
      res.sendFile(path.join(FRONTEND_DIR, "index.html"));
    });
    console.log(`[Bethaniel] Serving frontend from ${FRONTEND_DIR}`);
  } catch {
    console.log(
      `[Bethaniel] No frontend at ${FRONTEND_DIR} — API-only mode (use Vite dev server on :5173)`,
    );
  }
}

async function ensureDirs() {
  const dataDir = process.env.DATA_DIR ?? "./data";
  await fs.mkdir(dataDir, { recursive: true });
}

async function start() {
  await ensureDirs();
  await setupStaticFrontend();
  initQueue(io, 1);

  httpServer.listen(PORT, HOST, () => {
    const url = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
    console.log(`[Bethaniel] Ready at ${url}`);
  });
}

async function shutdown() {
  console.log("\n[Bethaniel] Shutting down...");
  // Force-exit after 3s if anything hangs (Socket.IO clients, in-flight streams, etc.)
  const forceExit = setTimeout(() => {
    console.log("[Bethaniel] Force exit (timeout).");
    process.exit(0);
  }, 3000);
  forceExit.unref();

  try {
    await closeQueue();
  } catch {}
  try {
    await shutdownLlamaServer();
  } catch {}
  try {
    await shutdownLanguageTool();
  } catch {}
  try {
    closeDb();
  } catch {}
  io.disconnectSockets(true);
  io.close();
  httpServer.close(() => process.exit(0));
  // Eagerly close existing connections so .close() actually resolves
  httpServer.closeAllConnections?.();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── Global error handlers ──
// Without these, an unhandled async error tears down the whole process and
// Electron quits with no indication of what failed. Surface them to the log bus
// (so the UI shows them) instead of dying silently.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  console.error("[Bethaniel] Unhandled promise rejection:", msg);
  appendLog({
    level: "error",
    source: "engine",
    message: `Unhandled error: ${reason instanceof Error ? reason.message : String(reason)}`,
  });
});

process.on("uncaughtException", (err) => {
  // A truly uncaught exception leaves the process in an undefined state — log,
  // fail any in-flight tasks so the UI doesn't show a hung run, then shut down.
  console.error("[Bethaniel] Uncaught exception:", err.stack ?? err.message);
  appendLog({
    level: "error",
    source: "engine",
    message: `Fatal error: ${err.message}`,
  });
  try {
    const failed = failActiveTasks(`Engine stopped unexpectedly: ${err.message}`);
    if (failed > 0) console.error(`[Bethaniel] Marked ${failed} active task(s) as errored.`);
  } catch {}
  void shutdown();
});

start().catch((err) => {
  console.error("[Bethaniel] Failed to start:", err);
  process.exit(1);
});
