// ── Choosing the port llama-server listens on ──
//
// The engine port has to be bindable at the moment the engine starts, which
// can be many minutes after the app launched. A port from the OS ephemeral
// range cannot carry that promise. The kernel allocates that range, in
// sequence, to every outbound connection and every listen(0) on the machine —
// the app's own loopback chatter (health polls, streamed completions, grammar
// checks, socket.io) walks the counter along, and a long job walks it right
// around the loop. "Reserving" one by binding a socket and closing it again
// reserves nothing: the port goes straight back in the pool, and any process
// on the machine — including this one — can be handed it.
//
// That is exactly how a launch died with
//   couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 59051
// which reached the user as "Model engine crashed (exit 1)" — sending them to
// look for a fault in the model, the one place the problem definitely was not.
//
// So the engine is launched on a port *below* every platform's ephemeral
// floor, where the kernel never allocates on its own. A pre-flight bind check
// still can't be authoritative — the socket must be released before the child
// can take it — so `isPortBindFailure` lets the caller recognise a lost race
// in llama-server's own output and retry on a different port.

import * as net from "net";
import { execSync } from "child_process";

/**
 * The lowest port any mainstream platform hands out on its own: Linux starts
 * its ephemeral range at 32768, macOS/BSD and Windows at 49152. Staying below
 * the lowest of them keeps the engine port out of every kernel's pool.
 */
export const EPHEMERAL_FLOOR = 32768;

/** Where the search for an engine port starts, and how far it runs. */
export const ENGINE_PORT_BASE = 8100;
export const ENGINE_PORT_SPAN = 400;

/** Whether a port is ours to keep rather than one the OS may reassign. */
export function isStablePort(port: number): boolean {
  return port >= 1024 && port < EPHEMERAL_FLOOR;
}

export interface EnginePortRequest {
  host: string;
  preferred: number;
  /** How long to wait for the preferred port to come free. */
  waitMs: number;
  /** Ports that already lost a bind race this session. */
  avoid?: number[];
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

/**
 * The first free port outside the OS ephemeral range, or null if the whole
 * band is somehow spoken for.
 */
export async function findStablePort(
  host: string,
  avoid: number[] = [],
): Promise<number | null> {
  const skip = new Set(avoid);
  const end = ENGINE_PORT_BASE + ENGINE_PORT_SPAN;
  for (let port = ENGINE_PORT_BASE; port < end; port++) {
    if (skip.has(port) || !isStablePort(port)) continue;
    if (await canBind(host, port)) return port;
  }
  return null;
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
 * Whether engine output shows the port was taken out from under us between our
 * bind check and the child's own bind. That race cannot be closed by checking
 * harder, so the caller retries elsewhere instead of failing the job.
 */
export function isPortBindFailure(output: string): boolean {
  return /couldn't bind HTTP server socket|exiting due to HTTP server error|bind: address already in use/i.test(
    output,
  );
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
 * The preferred port is honoured only when it is both free and outside the
 * ephemeral range. An ephemeral one is stepped away from even while it still
 * binds: it binds *now*, and the engine starts a few hundred milliseconds from
 * now, which is not the same promise.
 */
export async function resolveEnginePort(
  req: EnginePortRequest,
): Promise<EnginePortChoice> {
  const avoid = req.avoid ?? [];
  if (
    isStablePort(req.preferred) &&
    !avoid.includes(req.preferred) &&
    (await waitForBindable(req.host, req.preferred, req.waitMs))
  ) {
    return { port: req.preferred, moved: false };
  }

  const stable = await findStablePort(req.host, avoid);
  if (stable) return { port: stable, moved: true };

  // Nothing free in the stable band — an ephemeral port is still better than
  // not starting at all, and a lost race there is retried by the caller.
  const fallback = await findFreePort(req.host);
  if (fallback && !avoid.includes(fallback)) {
    return { port: fallback, moved: true };
  }

  const holder = describePortHolder(req.preferred);
  throw new Error(
    `Port ${req.preferred} is already in use${holder ? ` by ${holder}` : ""}, ` +
      `and no free port could be found for the engine. ` +
      `Another copy of the engine is probably still running — quit it and try again.`,
  );
}
