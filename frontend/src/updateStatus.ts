// ── What the app says about an update, and when ──
//
// Every decision lives here, free of Electron and React, because the updater
// cannot run in dev and a packaged build is a release away: this is the part
// that can actually be tested before shipping. The components below it only
// translate a key and draw a bar.

/** Where the updater has got to. Mirrored in electron/main.ts. */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  /** The available version, except for up-to-date, where it is the running one. */
  version?: string;
  /** 0-100, downloading only. */
  percent?: number;
  message?: string;
  /** Whether a person pressed the button, or the app checked by itself. */
  manual: boolean;
}

export interface BannerView {
  key: string;
  version?: string;
  percent?: number;
  showRestart: boolean;
}

export interface SettingsRowView {
  key: string;
  version?: string;
  showRestart: boolean;
  busy: boolean;
}

/** Terminal task states — everything else means work is in flight. */
const TERMINAL = new Set(["done", "error", "cancelled"]);

/**
 * Is a run in progress?
 *
 * Takes plain strings rather than TaskState so this module stays free of the
 * store's shape, and so a test can state the case in one line.
 */
export function isQueueBusy(statuses: readonly string[]): boolean {
  return statuses.some((s) => !TERMINAL.has(s));
}

/**
 * The banner, or nothing.
 *
 * Silent unless there is something the author can act on or is waiting for. In
 * particular BOTH kinds of failure are silent here: an automatic one because
 * being offline at launch is a laptop on a train and not news, and a manual one
 * because the settings row the person just pressed is already answering them —
 * saying it twice in two places reads as two problems.
 */
export function bannerFor(s: UpdateStatus, busy: boolean): BannerView | null {
  if (s.phase === "downloading")
    return {
      key: "update_downloading",
      version: s.version,
      percent: s.percent,
      showRestart: false,
    };
  if (s.phase === "downloaded") {
    // The whole of the mid-run protection is this absence. quitAndInstall()
    // would kill the job, possibly a paid cloud one; the update installs on
    // the next ordinary quit anyway (autoInstallOnAppQuit), so withholding the
    // shortcut costs nothing and removes the only way to lose paid work to a
    // mistimed click.
    return busy
      ? { key: "update_ready_later", version: s.version, showRestart: false }
      : { key: "update_ready", version: s.version, showRestart: true };
  }
  return null;
}

/** The settings row, which always has something to say. */
export function settingsRowFor(
  s: UpdateStatus,
  busy: boolean,
): SettingsRowView {
  const base = { version: s.version, showRestart: false, busy };
  switch (s.phase) {
    case "checking":
      return { ...base, key: "update_checking" };
    case "up-to-date":
      return { ...base, key: "update_up_to_date" };
    case "available":
    case "downloading":
      return { ...base, key: "update_found" };
    case "downloaded":
      return { ...base, key: "update_ready", showRestart: !busy };
    case "error":
      // Only when asked. An automatic failure leaves the row resting, so a
      // button nobody pressed never reports a problem.
      return s.manual
        ? { ...base, key: "update_error" }
        : { ...base, key: "update_check" };
    default:
      return { ...base, key: "update_check" };
  }
}
