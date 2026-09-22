// ── The note the app leaves behind while an update installs ──
//
// On macOS the install happens AFTER the app exits: Squirrel unpacks a 440 MB
// zip and swaps the bundle, which takes minutes. Measured on 2.27.0 — the
// click at ~10:30, the binary replaced at 10:33:02, the bundle finished at
// 10:34:27. Reopen inside that window and you get the old app, which sees the
// new version on the feed and offers the very update that is at that moment
// being installed. Clicking it again just quits into the same wait.
//
// So the app writes down what it is installing before it quits, and reads the
// note on the way back up. No Electron imports: this is the part that can be
// tested without cutting a release and waiting three minutes.

export interface InstallMarker {
  /** The version being installed. */
  version: string;
  /** When the app quit to install it. */
  startedAt: number;
}

export type InstallVerdict =
  /** No note, or one that cannot be read. Behave normally. */
  | "none"
  /** The install landed, or was abandoned. Delete the note. */
  | "finished"
  /** Still going. Say so, and do not offer the same update again. */
  | "installing";

/**
 * How long a note is believed.
 *
 * An install that has not landed within this either failed or was interrupted
 * by a shutdown. Both are better served by the ordinary update path than by a
 * banner that can never clear itself.
 */
const STALE_MS = 30 * 60 * 1000;

/** Leading integers of a dotted version; a `-beta.1` tail is dropped. */
function parts(v: string): number[] {
  return v
    .split("-")[0]
    .split(".")
    .map((p) => Number.parseInt(p, 10))
    .map((n) => (Number.isFinite(n) ? n : 0));
}

/**
 * Compare two versions numerically.
 *
 * As strings "2.9.0" sorts above "2.10.0", which would report a finished
 * install as still running and leave the banner up for good.
 */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  // Equal numbers, but a prerelease is behind its own release.
  const pre = (v: string) => (v.includes("-") ? 0 : 1);
  return pre(a) - pre(b);
}

/**
 * What the note means for the version now running.
 *
 * A malformed note is "none" rather than trusted: the file is ours, but a
 * half-written one after a crash must not strand the app on a banner.
 */
export function installVerdict(
  marker: InstallMarker | null,
  runningVersion: string,
  now: number,
): InstallVerdict {
  if (
    !marker ||
    typeof marker.version !== "string" ||
    typeof marker.startedAt !== "number"
  )
    return "none";

  // The running app IS the update, or is newer than what the note describes.
  if (compareVersions(runningVersion, marker.version) >= 0) return "finished";

  // Ahead of `now` means the clock moved, not that time has passed.
  if (now - marker.startedAt >= STALE_MS) return "finished";

  return "installing";
}
