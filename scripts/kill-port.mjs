#!/usr/bin/env node
// ── scripts/kill-port.mjs ──
// Frees a TCP port before `npm run dev` starts the backend, in case a
// previous dev session's Express server is still holding it. Cross-platform
// replacement for `lsof -ti:PORT | xargs kill -9` (POSIX-only, and not even
// present on Windows) — this uses `netstat`/`taskkill` on Windows and
// `lsof`/`kill` elsewhere. Best-effort: a port already free, or a lookup
// tool that isn't available, are both silently fine — this must never block
// `npm run dev` from starting.

import { execSync } from "child_process";

const port = process.argv[2];
if (!port) process.exit(0);

try {
  if (process.platform === "win32") {
    const output = execSync(`netstat -ano -p tcp`, { encoding: "utf-8" });
    const pids = new Set();
    for (const line of output.split("\n")) {
      const match = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (match && match[1] === String(port)) pids.add(match[2]);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      } catch {
        // Already gone, or not ours to kill — ignore.
      }
    }
  } else {
    const output = execSync(`lsof -ti:${port}`, { encoding: "utf-8" }).trim();
    if (output) {
      for (const pid of output.split("\n").filter(Boolean)) {
        try {
          execSync(`kill -9 ${pid}`, { stdio: "ignore" });
        } catch {
          // Already gone — ignore.
        }
      }
    }
  }
} catch {
  // Nothing listening on the port, or the lookup tool isn't installed —
  // either way, there is nothing to clean up.
}
