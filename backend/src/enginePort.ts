// ── Choosing the port llama-server listens on ──
//
// Electron picks a free port and passes it in LLAMA_PORT for packaged builds.
// Dev has no such env and falls back to a fixed 8012, which is the one
// configuration where an engine orphaned by a previous session can still be
// holding the socket.
//
// The old behaviour was to log a warning and launch anyway. llama-server then
// died with "couldn't bind HTTP server socket", which surfaced to the user as
// "Model engine crashed while running <model> (exit 1)" — sending them to look
// for a fault in the model, the one place the problem definitely was not.

import * as net from "net";
import { execSync } from "child_process";

export interface EnginePortRequest {
  host: string;
  preferred: number;
  /** Whether we may pick a different port. True only for dev's fixed fallback. */
  movable: boolean;
  /** How long to wait for the preferred port to come free. */
  waitMs: number;
}

export interface EnginePortChoice {
  port: number;
  moved: boolean;
}

/** Whether a real bind succeeds — the only honest test of availability. */
export function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** Wait for a port to become bindable, polling until the deadline. */
export async function waitForBindable(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await canBind(host, port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A free ephemeral port, or null if one cannot be obtained. */
export function findFreePort(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(null));
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Who holds a port, for the error message. Best-effort and never throws —
 * naming the process is the difference between "engine crashed" and "quit your
 * other copy of Bethaniel".
 */
export function describePortHolder(port: number): string | null {
  if (process.platform === "win32") return null;
  try {
    const pid = execSync(`lsof -ti tcp:${port}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
      .split(/\s+/)[0];
    if (!pid) return null;
    const name = execSync(`ps -o comm= -p ${pid}`, {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim()
      .split("/")
      .pop();
    return name ? `${name} (pid ${pid})` : `pid ${pid}`;
  } catch {
    return null;
  }
}

/**
 * The port to launch on, or a thrown error saying plainly that it is taken.
 *
 * A movable request (dev) steps aside onto a free port. A fixed one (packaged,
 * where Electron already chose a free port) refuses instead — if that port is
 * occupied something is genuinely wrong, and moving would hide it.
 */
export async function resolveEnginePort(
  req: EnginePortRequest,
): Promise<EnginePortChoice> {
  if (await waitForBindable(req.host, req.preferred, req.waitMs)) {
    return { port: req.preferred, moved: false };
  }

  if (req.movable) {
    const alternative = await findFreePort(req.host);
    if (alternative) return { port: alternative, moved: true };
  }

  const holder = describePortHolder(req.preferred);
  throw new Error(
    `Port ${req.preferred} is already in use${holder ? ` by ${holder}` : ""}. ` +
      `Another copy of the engine is probably still running — quit it and try again.`,
  );
}
