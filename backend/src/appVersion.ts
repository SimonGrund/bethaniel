// ── Which Betty produced this run ──
//
// Stamped on every task, because "which build was that?" turned out to be
// unanswerable at the moment it mattered. A defect was reported from a run,
// and telling a dev run from the installed app took the task database,
// the app bundle's Info.plist and a git log — and still got it wrong the
// first time, because `npm run dev`'s Electron writes to the SAME data
// directory as the installed app. The footer could not settle it either: it
// shows the version in package.json, and CI tags releases without committing
// a bump back, so the repo permanently lags the build.
//
// The version is where the run is, now, and does not have to be inferred.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

/** Set by electron/main.ts when it forks the backend — the only source that
 *  knows the SHIPPED version, since the packaged app has no repo to read. */
const FROM_ENV = process.env.BETHANIEL_VERSION?.trim();

/**
 * The app's version, as a user would read it in the footer.
 *
 * Resolution, in order: what Electron told us; the root package.json (which
 * is what a dev run is actually running); then "unknown", never a guess. An
 * unknown version recorded honestly is worth more than a plausible wrong one
 * — the whole point of this module is to stop a build being inferred.
 */
export function appVersion(): string {
  if (FROM_ENV) return FROM_ENV;
  try {
    // backend/src/appVersion.ts → ../../package.json in dev,
    // backend/dist/appVersion.js → ../../package.json when compiled.
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "..", "package.json"), "utf-8");
    const v = JSON.parse(raw)?.version;
    return typeof v === "string" && v.trim() ? v.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Whether this backend is a development run.
 *
 * Kept beside the version because the two are read together: a dev build and
 * the installed app can report the same version — they did, which is what
 * made the report hard to place.
 */
export function isDevRun(): boolean {
  return process.env.NODE_ENV === "development";
}

/** The pair, as one string for a task record: "2.27.0" or "2.27.0-dev". */
export function runVersionLabel(): string {
  const v = appVersion();
  return isDevRun() ? `${v}-dev` : v;
}
