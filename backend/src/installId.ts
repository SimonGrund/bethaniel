// ── This install of the app, for discount codes limited per install ──
//
// A random UUID kept in DATA_DIR and sent with every cloud quote and code
// look-up, so the Worker can refuse a code an install has already used
// (`max_uses_per_install` on the promo row). It identifies nothing about the
// author: it is made on first use, never derived from the machine, and
// deleting the data folder (or the "settings" purge) makes a new one — which
// is the known way round the limit. It stops casual reuse, not a determined
// author.

import { randomUUID } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let cached: string | null = null;

/** Read the install id, making it on first use. Never throws: an install
 *  that cannot write its id still gets one for this session, and the Worker
 *  simply counts each session as a new install. */
export function installId(dataDir = process.env.DATA_DIR ?? "./data"): string {
  if (cached) return cached;
  const file = join(dataDir, "install-id");
  try {
    const existing = readFileSync(file, "utf8").trim().toLowerCase();
    if (UUID.test(existing)) return (cached = existing);
  } catch {
    // Not made yet.
  }
  const fresh = randomUUID();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, fresh + "\n", "utf8");
  } catch {
    // Read-only data folder: keep it for this session.
  }
  return (cached = fresh);
}

/** For tests only. */
export function resetInstallIdCache(): void {
  cached = null;
}
