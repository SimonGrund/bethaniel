// ── The renderer's handle on the updater ──
//
// Mirrors getElectronBridge in cloudPurchase.ts: this codebase has no global
// Window declaration, so reaching the preload surface means a local cast, and
// one accessor beats a copy of that cast per call site.
//
// Deliberately NOT in updateStatus.ts — that module is imported by a node
// test, where `window` does not exist.

import type { UpdateStatus } from "./updateStatus";

export interface UpdateBridge {
  checkForUpdates: () => Promise<void>;
  /** `copy` is the goodbye panel's text, translated here: the main process
   *  has no i18n of its own and should not grow a second copy of it. */
  restartToUpdate: (copy?: { title: string; body: string }) => Promise<void>;
  currentUpdateStatus: () => Promise<UpdateStatus | null>;
  onUpdateStatus: (listener: (status: UpdateStatus) => void) => () => void;
  appVersion: () => Promise<string>;
}

/** The bridge, or null outside the desktop app (a browser preview, or dev). */
export function getUpdateBridge(): UpdateBridge | null {
  const win = window as unknown as { bethaniel?: Partial<UpdateBridge> };
  const b = win.bethaniel;
  // Every method or none: a half-present bridge means a preload from a
  // different version, and calling into that is worse than showing nothing.
  if (
    !b?.checkForUpdates ||
    !b.restartToUpdate ||
    !b.currentUpdateStatus ||
    !b.onUpdateStatus ||
    !b.appVersion
  )
    return null;
  return b as UpdateBridge;
}
