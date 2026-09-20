# Instant Update Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell the author a new version exists the moment the check returns, give them a button to ask, and stop the restart prompt from being able to kill a running job.

**Architecture:** Four slices. (1) A pure `frontend/src/updateStatus.ts` holding every decision — what the banner says, whether Restart may be offered, whether an error is shown — tested from `backend/test/`. (2) `electron/main.ts` keeps one `UpdateStatus` and broadcasts it, checks on `did-finish-load` instead of a timer, and loses its dialog. (3) `electron/preload.ts` exposes check / restart / subscribe. (4) `UpdateStrip.tsx` and a settings row render it.

**Tech Stack:** Electron (`electron-updater`), React + Zustand, `node:test` via the `tsx` loader.

**Spec:** `docs/superpowers/specs/2026-09-20-instant-update-notice-design.md`

## Global Constraints

- **The frontend has no test runner.** Pure logic lives in `frontend/src/*.ts` and is tested from `backend/test/*.test.ts` importing `../../frontend/src/<file>.ts`. This is an established convention — see `backend/test/codeBalanceNote.test.ts`, which says so in its header. Do not add a frontend test runner.
- **i18n is four languages: `en`, `da`, `de`, `es`.** `Lang` in `frontend/src/types.ts:513` does not include `fr`; adding it is a TypeScript error. French is a *manuscript* language, not an interface one.
- **The Restart button must never be offered while any task is running.** `quitAndInstall()` kills the job, which may be a paid cloud run.
- **An automatic check that fails is silent. A manual one always answers.**
- Verify with `cd backend && npm test`, `cd backend && npm run build`, `cd frontend && npm run build`, `cd electron && npx tsc -p tsconfig.json --noEmit`.
- Do **not** push to `main` — a push there cuts a release. Work on `feat/instant-update-notice`.
- Comments explain *why*. Do not restate the code.

---

### Task 1: The decision logic, pure and tested

Everything worth getting wrong, in one file with no Electron and no React.

**Files:**
- Create: `frontend/src/updateStatus.ts`
- Test: `backend/test/updateStatus.test.ts`

**Interfaces:**
- Consumes: `TaskStatus` from `frontend/src/types.ts` (values: `"queued" | "editing" | "done" | "error" | "cancelled"`).
- Produces, all from `frontend/src/updateStatus.ts`:
  - `interface UpdateStatus { phase: UpdatePhase; version?: string; percent?: number; message?: string; manual: boolean }`
  - `type UpdatePhase = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error"`
  - `function isQueueBusy(statuses: readonly string[]): boolean`
  - `function bannerFor(s: UpdateStatus, busy: boolean): BannerView | null`
  - `function settingsRowFor(s: UpdateStatus, busy: boolean): SettingsRowView`
  - `interface BannerView { key: string; version?: string; percent?: number; showRestart: boolean }`
  - `interface SettingsRowView { key: string; version?: string; showRestart: boolean; busy: boolean }`

`key` is an i18n key, not a sentence — the components translate it. Keeping the
strings out of here is what lets this be tested without a `t()`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/updateStatus.test.ts`:

```ts
// ── What the update banner says, and when Restart may be pressed ──
//
// Pure, and tested from here because the frontend has no test runner — the
// same reach-across codeBalanceNote.test.ts uses.
//
// The rule worth pinning hardest: while any task is running, Restart is NOT
// offered. quitAndInstall() kills the job, and that job may be a cloud run the
// author has already paid for. The update installs on the next ordinary quit
// regardless (autoInstallOnAppQuit), so withholding the shortcut costs nothing
// and removes the only way to lose paid work by a mistimed click.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bannerFor,
  isQueueBusy,
  settingsRowFor,
  type UpdateStatus,
} from "../../frontend/src/updateStatus.ts";

const st = (p: Partial<UpdateStatus>): UpdateStatus =>
  ({ phase: "idle", manual: false, ...p }) as UpdateStatus;

test("isQueueBusy: queued or editing is busy", () => {
  assert.equal(isQueueBusy(["queued"]), true);
  assert.equal(isQueueBusy(["editing"]), true);
  assert.equal(isQueueBusy(["done", "editing"]), true);
});

test("isQueueBusy: only terminal states are idle", () => {
  assert.equal(isQueueBusy([]), false);
  assert.equal(isQueueBusy(["done", "error", "cancelled"]), false);
});

test("banner: nothing to say while idle, checking or up to date", () => {
  assert.equal(bannerFor(st({ phase: "idle" }), false), null);
  assert.equal(bannerFor(st({ phase: "checking" }), false), null);
  assert.equal(bannerFor(st({ phase: "up-to-date", version: "2.23.0" }), false), null);
});

test("banner: downloading shows the version and the percentage", () => {
  const v = bannerFor(st({ phase: "downloading", version: "2.23.0", percent: 42 }), false);
  assert.equal(v?.key, "update_downloading");
  assert.equal(v?.version, "2.23.0");
  assert.equal(v?.percent, 42);
  assert.equal(v?.showRestart, false);
});

test("banner: downloaded and idle offers Restart", () => {
  const v = bannerFor(st({ phase: "downloaded", version: "2.23.0" }), false);
  assert.equal(v?.key, "update_ready");
  assert.equal(v?.showRestart, true);
});

test("banner: downloaded while BUSY does not offer Restart", () => {
  const v = bannerFor(st({ phase: "downloaded", version: "2.23.0" }), true);
  assert.equal(v?.key, "update_ready_later");
  assert.equal(v?.showRestart, false);
});

test("banner: an automatic failure is silent", () => {
  assert.equal(bannerFor(st({ phase: "error", message: "getaddrinfo ENOTFOUND", manual: false }), false), null);
});

test("banner: a manual failure is silent too — the settings row answers it", () => {
  // The person is looking at the row they just pressed. Saying it twice, in
  // two places, reads as two problems.
  assert.equal(bannerFor(st({ phase: "error", message: "nope", manual: true }), false), null);
});

test("settings row: resting state invites a check", () => {
  assert.equal(settingsRowFor(st({ phase: "idle" }), false).key, "update_check");
});

test("settings row: reports up to date with the running version", () => {
  const v = settingsRowFor(st({ phase: "up-to-date", version: "2.23.0" }), false);
  assert.equal(v.key, "update_up_to_date");
  assert.equal(v.version, "2.23.0");
});

test("settings row: an error is shown only when a person asked", () => {
  assert.equal(settingsRowFor(st({ phase: "error", manual: true }), false).key, "update_error");
  assert.equal(settingsRowFor(st({ phase: "error", manual: false }), false).key, "update_check");
});

test("settings row: offers Restart when ready and idle, and not when busy", () => {
  assert.equal(settingsRowFor(st({ phase: "downloaded", version: "2.23.0" }), false).showRestart, true);
  assert.equal(settingsRowFor(st({ phase: "downloaded", version: "2.23.0" }), true).showRestart, false);
});

test("every key the views can return exists in all four languages", async () => {
  const { default: TRANSLATIONS } = await import("../../frontend/src/i18n.ts");
  const phases: UpdateStatus["phase"][] = [
    "idle", "checking", "up-to-date", "available", "downloading", "downloaded", "error",
  ];
  const keys = new Set<string>();
  for (const phase of phases)
    for (const busy of [true, false])
      for (const manual of [true, false]) {
        const s = st({ phase, manual, version: "2.23.0", percent: 1 });
        const b = bannerFor(s, busy);
        if (b) keys.add(b.key);
        keys.add(settingsRowFor(s, busy).key);
      }
  for (const k of keys) {
    const entry = (TRANSLATIONS as Record<string, Record<string, string>>)[k];
    assert.ok(entry, `missing i18n key: ${k}`);
    for (const lang of ["en", "da", "de", "es"])
      assert.ok(entry[lang], `key ${k} missing ${lang}`);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/updateStatus.test.ts`
Expected: FAIL — `../../frontend/src/updateStatus.ts` does not exist.

- [ ] **Step 3: Write the module**

Create `frontend/src/updateStatus.ts`:

```ts
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
 * store's shape, and so the test can state the case in one line.
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
    return { key: "update_downloading", version: s.version, percent: s.percent, showRestart: false };
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
export function settingsRowFor(s: UpdateStatus, busy: boolean): SettingsRowView {
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
      // button that was never pressed never reports a problem.
      return s.manual ? { ...base, key: "update_error" } : { ...base, key: "update_check" };
    default:
      return { ...base, key: "update_check" };
  }
}
```

- [ ] **Step 4: Add the i18n keys**

In `frontend/src/i18n.ts`, beside a neighbouring entry (the file keys each
string to an object with one field per language — see `export_translation`),
add all seven keys in four languages. `{v}` is replaced with the version and
`{p}` with the percentage by the components.

```ts
  update_check: {
    en: "Check for updates",
    da: "Søg efter opdateringer",
    de: "Nach Updates suchen",
    es: "Buscar actualizaciones",
  },
  update_checking: {
    en: "Checking…",
    da: "Søger…",
    de: "Suche…",
    es: "Buscando…",
  },
  update_up_to_date: {
    en: "Up to date (v{v})",
    da: "Opdateret (v{v})",
    de: "Aktuell (v{v})",
    es: "Actualizado (v{v})",
  },
  update_found: {
    en: "Update found — downloading",
    da: "Opdatering fundet — henter",
    de: "Update gefunden — wird geladen",
    es: "Actualización encontrada: descargando",
  },
  update_downloading: {
    en: "Bethaniel {v} is downloading · {p}%",
    da: "Bethaniel {v} hentes · {p}%",
    de: "Bethaniel {v} wird geladen · {p}%",
    es: "Bethaniel {v} se está descargando · {p}%",
  },
  update_ready: {
    en: "Bethaniel {v} is ready.",
    da: "Bethaniel {v} er klar.",
    de: "Bethaniel {v} ist bereit.",
    es: "Bethaniel {v} está lista.",
  },
  update_ready_later: {
    en: "Bethaniel {v} is ready — it will install next time you restart.",
    da: "Bethaniel {v} er klar — den installeres, næste gang du genstarter.",
    de: "Bethaniel {v} ist bereit — es wird beim nächsten Neustart installiert.",
    es: "Bethaniel {v} está lista: se instalará la próxima vez que reinicies.",
  },
  update_restart: {
    en: "Restart now",
    da: "Genstart nu",
    de: "Jetzt neu starten",
    es: "Reiniciar ahora",
  },
  update_error: {
    en: "Could not check for updates",
    da: "Kunne ikke søge efter opdateringer",
    de: "Suche nach Updates fehlgeschlagen",
    es: "No se pudo buscar actualizaciones",
  },
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx tsx --test test/updateStatus.test.ts`
Expected: PASS, all thirteen — including the last, which walks every phase ×
busy × manual combination and asserts each returned key exists in all four
languages.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: silent. A `fr` field anywhere in the new i18n entries fails here.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/updateStatus.ts frontend/src/i18n.ts backend/test/updateStatus.test.ts
git commit -m "feat(updates): the decisions about what to say, pure and tested"
```

---

### Task 2: Main process — one state, broadcast, and no dialog

**Files:**
- Modify: `electron/main.ts` (updater block at 49–90; `did-finish-load` at ~922; launch timer at ~930)

**Interfaces:**
- Consumes: `UpdatePhase` shape from Task 1 (duplicated as a literal union here — `electron/` does not import from `frontend/src`).
- Produces: IPC channels `updates:check` (invoke), `updates:restart` (invoke), `updates:status` (main→renderer event).

- [ ] **Step 1: Replace the updater block**

In `electron/main.ts`, replace the whole `if (!IS_DEV) { … }` updater block at
lines 49–90 with:

```ts
// ── Auto-updater ──
// Only runs in packaged builds; skipped silently in dev mode.

/** Mirrors UpdateStatus in frontend/src/updateStatus.ts, which owns the
 *  decisions this only reports. Kept as a literal rather than imported:
 *  electron/ does not build against frontend/src. */
type UpdatePhase =
  | "idle" | "checking" | "up-to-date" | "available"
  | "downloading" | "downloaded" | "error";

interface UpdateStatus {
  phase: UpdatePhase;
  version?: string;
  percent?: number;
  message?: string;
  manual: boolean;
}

let updateStatus: UpdateStatus = { phase: "idle", manual: false };

/** True while a check the USER asked for is in flight. Latched at the request
 *  and read by the events that follow, because electron-updater's events carry
 *  no idea of who asked. */
let updateAskedByUser = false;

function setUpdateStatus(next: Omit<UpdateStatus, "manual">): void {
  updateStatus = { ...next, manual: updateAskedByUser };
  mainWindow?.webContents.send("updates:status", updateStatus);
}

if (!IS_DEV) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("[updater] checking for update...");
    setUpdateStatus({ phase: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    console.log("[updater] update available:", info.version);
    // The point of the whole change: say so HERE, when the check returns,
    // rather than when the download finishes. The wait people reported was
    // the download — a hundred-odd megabytes — not the check.
    setUpdateStatus({ phase: "available", version: info.version });
  });

  autoUpdater.on("update-not-available", (info) => {
    console.log("[updater] up to date:", info.version);
    setUpdateStatus({ phase: "up-to-date", version: app.getVersion() });
    updateAskedByUser = false;
  });

  autoUpdater.on("download-progress", (progress) => {
    console.log(`[updater] download: ${progress.percent.toFixed(1)}%`);
    setUpdateStatus({
      phase: "downloading",
      version: updateStatus.version,
      percent: Math.round(progress.percent),
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.log("[updater] update downloaded");
    // No dialog. It used to fire here and offer "Restart now", which calls
    // quitAndInstall() and kills whatever job is running — possibly a cloud
    // run the author has paid for. The renderer's banner says the same thing
    // without interrupting, and withholds the button while tasks are running.
    setUpdateStatus({ phase: "downloaded", version: info.version });
    updateAskedByUser = false;
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err?.message ?? err);
    setUpdateStatus({ phase: "error", message: err?.message ?? String(err) });
    updateAskedByUser = false;
  });
}
```

Note `setUpdateStatus` and the two variables sit OUTSIDE the `if (!IS_DEV)`,
so the IPC handlers below compile and answer sensibly in dev.

- [ ] **Step 2: Add the IPC handlers**

Beside the existing handlers (after `ipcMain.handle("report:exportPdf", …)`):

```ts
ipcMain.handle("updates:check", () => {
  // Dev has no updater. Answer honestly rather than leaving the button
  // spinning forever on a promise nothing will settle.
  if (IS_DEV) {
    updateAskedByUser = true;
    setUpdateStatus({ phase: "up-to-date", version: app.getVersion() });
    updateAskedByUser = false;
    return;
  }
  updateAskedByUser = true;
  void autoUpdater.checkForUpdates();
});

ipcMain.handle("updates:restart", () => {
  if (IS_DEV) return;
  // Only reachable from a button the renderer draws when no task is running.
  autoUpdater.quitAndInstall();
});

ipcMain.handle("updates:current", () => updateStatus);
```

`updates:current` exists so a renderer that loads (or reloads) after a status
change can ask for it, instead of waiting for the next event that may never
come.

- [ ] **Step 3: Check on load, not on a timer**

Find, at ~line 930:

```ts
  // Check for updates a few seconds after launch so the window is settled
  if (!IS_DEV) {
    setTimeout(() => autoUpdater.checkForUpdates(), 5000);
  }
```

Replace with nothing — delete it — and instead extend the existing
`did-finish-load` handler at ~line 922 so it reads:

```ts
  mainWindow.webContents.once("did-finish-load", () => {
    if (pendingDeepLink) {
      const url = pendingDeepLink;
      pendingDeepLink = null;
      void claimCloudCredential(url);
    }
    // The moment the renderer can receive an answer. The five-second timer
    // this replaces bought nothing: it delayed asking a question whose answer
    // had nowhere to go, and the delay people actually noticed was the
    // download that follows.
    if (!IS_DEV) void autoUpdater.checkForUpdates();
  });
```

- [ ] **Step 4: Typecheck**

Run: `cd electron && npx tsc -p tsconfig.json --noEmit`
Expected: silent.

If it complains that `app` is not in scope in the updater block, note that the
block sits above the imports' usage — move `setUpdateStatus` and the
`autoUpdater.on("update-not-available", …)` body's `app.getVersion()` call to
read `app` from the existing top-level `import { app } from "electron"`. It is
already imported; confirm with `grep -n "^import.*electron" electron/main.ts`.

- [ ] **Step 5: Commit**

```bash
git add electron/main.ts
git commit -m "feat(updates): say it when the check returns, and stop the dialog killing runs"
```

---

### Task 3: Preload bridge

**Files:**
- Modify: `electron/preload.ts`

**Interfaces:**
- Consumes: the IPC channels from Task 2.
- Produces, on `window.bethaniel`: `appVersion(): Promise<string>`, `checkForUpdates()`, `restartToUpdate()`, `currentUpdateStatus()`, `onUpdateStatus(listener)`. Note `appVersion` is a **function**, not a static string — see Step 2.

- [ ] **Step 1: Add to the bridge**

In `electron/preload.ts`, inside the `contextBridge.exposeInMainWorld("bethaniel", { … })` object, after `exportPdf`:

```ts
  // ── Updates ──
  // appVersion is the RUNNING version, which the updater never reports — it
  // only names the one available. "Up to date (v2.23.0)" needs this.
  appVersion: process.env.npm_package_version ?? "",
  checkForUpdates: () => ipcRenderer.invoke("updates:check") as Promise<void>,
  restartToUpdate: () => ipcRenderer.invoke("updates:restart") as Promise<void>,
  currentUpdateStatus: () =>
    ipcRenderer.invoke("updates:current") as Promise<unknown>,
  onUpdateStatus: (listener: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => listener(status);
    ipcRenderer.on("updates:status", handler);
    return () => ipcRenderer.removeListener("updates:status", handler);
  },
```

- [ ] **Step 2: Fix `appVersion` — the env var is not reliable in a packaged app**

`process.env.npm_package_version` is set by npm scripts, not by a packaged
Electron binary. Replace that line with a value the main process supplies:

In `electron/main.ts`, beside the other handlers:

```ts
ipcMain.handle("app:version", () => app.getVersion());
```

and in `electron/preload.ts` use:

```ts
  appVersion: () => ipcRenderer.invoke("app:version") as Promise<string>,
```

Written out as two steps deliberately: the env-var form looks right, is what a
first draft reaches for, and is empty in the built app — which would make the
settings row read "Up to date (v)".

- [ ] **Step 3: Typecheck**

Run: `cd electron && npx tsc -p tsconfig.json --noEmit`
Expected: silent.

- [ ] **Step 4: Commit**

```bash
git add electron/preload.ts electron/main.ts
git commit -m "feat(updates): expose the updater to the renderer"
```

---

### Task 3a: The renderer's side of the bridge

**Files:**
- Create: `frontend/src/updateBridge.ts`

**Interfaces:**
- Consumes: the preload surface from Task 3; `UpdateStatus` from Task 1.
- Produces: `getUpdateBridge(): UpdateBridge | null` from `frontend/src/updateBridge.ts`.

**Why this exists.** There is **no** global `Window` declaration in this
codebase — `cloudPurchase.ts:33` and `reportExport.ts:55` each cast
`window as unknown as { bethaniel?: … }` locally. So `window.bethaniel.foo()`
does not typecheck anywhere, and one accessor is better than a third copy of
the cast. It is a separate file from `updateStatus.ts` on purpose: that module
is imported by a node test, where `window` does not exist, and it must stay
free of anything that assumes a browser.

- [ ] **Step 1: Write it**

Create `frontend/src/updateBridge.ts`:

```ts
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
  restartToUpdate: () => Promise<void>;
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
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: silent.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/updateBridge.ts
git commit -m "feat(updates): one accessor for the updater bridge"
```

---

### Task 4: Store slice and the banner

**Files:**
- Modify: `frontend/src/store.ts`
- Create: `frontend/src/components/UpdateStrip.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/styles/global.css`

**Interfaces:**
- Consumes: `bannerFor`, `isQueueBusy`, `UpdateStatus` (Task 1); `window.bethaniel` (Task 3).
- Produces: `updateStatus` + `setUpdateStatus` on the store; `<UpdateStrip />`.

- [ ] **Step 1: Add the store slice**

In `frontend/src/store.ts`, beside the `downloads` field (line ~332), add to
the state interface:

```ts
  // Update status — transient, pushed from the Electron main process.
  updateStatus: UpdateStatus;
  setUpdateStatus: (s: UpdateStatus) => void;
```

and to the store body, beside `downloads: {}` (line ~771):

```ts
      updateStatus: { phase: "idle", manual: false },
      setUpdateStatus: (s) => set({ updateStatus: s }),
```

Import the type at the top:

```ts
import type { UpdateStatus } from "./updateStatus";
```

**Do not persist it.** `downloads` is transient for the same reason: a status
restored from last session describes a download that is no longer happening.
Check the `persist` config's `partialize` (if present) excludes it.

- [ ] **Step 2: Create the banner**

Create `frontend/src/components/UpdateStrip.tsx`:

```tsx
// ── UpdateStrip — "a new Bethaniel is on its way" ──
//
// Replaces the native dialog that used to fire on update-downloaded. That
// dialog interrupted, and its "Restart now" called quitAndInstall() — which
// kills a running job, possibly a paid cloud one. This says the same things
// without interrupting, and withholds the button while tasks are running.
//
// Modelled on ModelDownloadStrip, which solves the same problem for models.

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { bannerFor, isQueueBusy } from "../updateStatus";
import { getUpdateBridge } from "../updateBridge";

export default function UpdateStrip() {
  const lang = useStore((s) => s.lang);
  const status = useStore((s) => s.updateStatus);
  const tasks = useStore((s) => s.tasks);
  const t = useTranslation(lang);

  const busy = isQueueBusy(Object.values(tasks).map((x) => x.status));
  const view = bannerFor(status, busy);
  if (!view) return null;

  const text = t(view.key)
    .replace("{v}", view.version ?? "")
    .replace("{p}", String(view.percent ?? 0));

  return (
    <div className="update-strip">
      <span className="update-strip-label">{text}</span>
      {view.percent != null && (
        <span className="update-strip-bar">
          <span
            className="update-strip-fill"
            style={{ width: `${view.percent}%` }}
          />
        </span>
      )}
      {view.showRestart && (
        <button
          type="button"
          className="btn-small update-strip-restart"
          onClick={() => void getUpdateBridge()?.restartToUpdate()}
        >
          {t("update_restart")}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Subscribe, and mount it**

In `frontend/src/App.tsx`, add the import beside the other component imports
(near line 16):

```tsx
import UpdateStrip from "./components/UpdateStrip";
```

Add a subscription effect inside the `App` component, beside its other
`useEffect` calls:

```tsx
  // Update status is pushed from the Electron main process. Ask once on mount
  // too: a reload lands after any event already sent, and without this the
  // banner would stay blank until the next one — which may never come.
  useEffect(() => {
    const bridge = getUpdateBridge();
    if (!bridge) return;
    void bridge.currentUpdateStatus().then((s) => {
      if (s) useStore.getState().setUpdateStatus(s);
    });
    return bridge.onUpdateStatus((s) => useStore.getState().setUpdateStatus(s));
  }, []);
```

with `import { getUpdateBridge } from "./updateBridge";` at the top.

Mount the strip at the top of the main layout so it is visible whatever step
the author is on — directly inside `<div className="app-layout">` (line ~319),
before `<Sidebar />`:

```tsx
      <UpdateStrip />
```

- [ ] **Step 4: Style it**

In `frontend/src/styles/global.css`, beside the `.model-download-strip` rules
(find them with `grep -n "model-download-strip" frontend/src/styles/global.css`),
add:

```css
/* The update bar. Quieter than a dialog on purpose: this is news, not a
   question, and it must never cover what the author is reading. */
.update-strip {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 0.9rem;
  background: #f4ead8;
  border-bottom: 1px solid #e0d2ba;
  font-size: 0.88rem;
  color: #4a3728;
}

.update-strip-label { flex: 0 1 auto; }

.update-strip-bar {
  flex: 0 0 120px;
  height: 5px;
  border-radius: 3px;
  background: #e0d2ba;
  overflow: hidden;
}

.update-strip-fill {
  display: block;
  height: 100%;
  background: #8a6d4b;
  transition: width 0.3s ease;
}

.update-strip-restart { margin-left: auto; }
```

Match the surrounding palette: if the neighbouring rules use different hex
values, use theirs rather than these.

- [ ] **Step 5: (moved to Task 3a — the bridge accessor)**

Nothing to do here. There is no global `Window` declaration in this codebase;
the accessor added in Task 3a is how the renderer reaches the bridge.

- [ ] **Step 6: Build**

Run: `cd frontend && npm run build`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/store.ts frontend/src/components/UpdateStrip.tsx frontend/src/App.tsx frontend/src/styles/global.css
git commit -m "feat(updates): a banner that says it now and never steals a run"
```

---

### Task 5: The settings row

**Files:**
- Modify: `frontend/src/components/HeaderSettingsMenu.tsx`
- Modify: `frontend/src/styles/global.css`

**Interfaces:**
- Consumes: `settingsRowFor`, `isQueueBusy` (Task 1); the bridge (Task 3).

- [ ] **Step 1: Add the row**

In `frontend/src/components/HeaderSettingsMenu.tsx`, add the imports:

```tsx
import { settingsRowFor, isQueueBusy } from "../updateStatus";
import { getUpdateBridge } from "../updateBridge";
```

and inside the component, before `return (`:

```tsx
  const updateStatus = useStore((s) => s.updateStatus);
  const tasks = useStore((s) => s.tasks);
  const busy = isQueueBusy(Object.values(tasks).map((x) => x.status));
  const updateRow = settingsRowFor(updateStatus, busy);
  // No updater outside the desktop app, so no button that cannot work.
  const bridge = getUpdateBridge();
```

Then, in the menu, directly after the "Storage & data" button and before the
language group:

```tsx
          {bridge && (
            <div className="header-settings-update">
              <button
                type="button"
                role="menuitem"
                className="header-settings-item"
                disabled={updateStatus.phase === "checking"}
                onClick={() => void bridge.checkForUpdates()}
              >
                {t(updateRow.key).replace("{v}", updateRow.version ?? "")}
              </button>
              {updateRow.showRestart && (
                <button
                  type="button"
                  role="menuitem"
                  className="header-settings-item header-settings-item-strong"
                  onClick={() => void bridge.restartToUpdate()}
                >
                  {t("update_restart")}
                </button>
              )}
            </div>
          )}
```

The row does not close the menu on click: its whole purpose is to report back
in place, and a menu that vanishes takes the answer with it.

- [ ] **Step 2: Style the strong row**

In `frontend/src/styles/global.css`, beside the `.header-settings-item` rules:

```css
/* The Restart row, when an update is waiting. Weightier than its neighbours
   because it is the one row here that does something irreversible. */
.header-settings-item-strong {
  font-weight: 600;
  color: #6b4f2a;
}
```

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build`
Expected: no TypeScript errors.

- [ ] **Step 4: Verify the row renders outside Electron**

Run: `cd frontend && npm run dev`, open the app in a browser, open the settings
menu.
Expected: **no** update row at all — `window.bethaniel` is undefined in a
browser, so `canCheck` is false. Everything else in the menu is unchanged.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/HeaderSettingsMenu.tsx frontend/src/styles/global.css
git commit -m "feat(updates): a way to ask, answering in place"
```

---

### Task 6: Document, and verify what can be verified

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Record the behaviour**

In `CLAUDE.md`, in the "Electron packaging" section, add:

```markdown
**Updates.** `electron/main.ts` keeps one `UpdateStatus` and broadcasts it on
`updates:status`; the check fires on `did-finish-load` rather than a timer,
because the delay users reported was the *download* (`autoDownload` pulls the
whole installer) and not the check. There is no update dialog: it used to fire
on `update-downloaded` and its "Restart now" called `quitAndInstall()`, which
kills a running job — possibly a paid cloud one. `UpdateStrip.tsx` says the
same things without interrupting and withholds the Restart button while any
task is not terminal; the update installs on the next ordinary quit regardless
(`autoInstallOnAppQuit`). Every decision about what to say lives in
`frontend/src/updateStatus.ts`, which is pure and tested from
`backend/test/updateStatus.test.ts` — the updater itself cannot run in dev, so
that module is the only part testable before a release.
```

- [ ] **Step 2: Full verification**

Run:
```bash
cd backend && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
cd ../backend && npm run build
cd ../frontend && npm run build
cd ../electron && npx tsc -p tsconfig.json --noEmit
```
Expected: backend `fail 0`; all three builds silent.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(updates): how the update notice works, and why there is no dialog"
```

- [ ] **Step 4: Hand back — state plainly what is NOT verified**

Do not push. Report:

- what the tests cover: the phase→copy mapping, the busy/idle rule that
  withholds Restart, manual-vs-automatic error visibility, and that every key
  returned exists in all four languages;
- what they cannot cover: that the IPC actually arrives, that a real download
  from GitHub releases drives the bar, and that `quitAndInstall()` restarts
  into the new version. The updater is skipped in dev and needs a signed,
  published build.

The honest claim on merge is "logic tested, wiring reasoned about". Confirming
the rest takes one release: install the previous version, publish this one,
and watch the banner appear.

---

## Verification checklist

- [ ] `cd backend && npm test` — `fail 0`, including the four-language key sweep
- [ ] `cd backend && npm run build` — silent
- [ ] `cd frontend && npm run build` — silent
- [ ] `cd electron && npx tsc -p tsconfig.json --noEmit` — silent
- [ ] Settings menu in a browser shows **no** update row
- [ ] No `fr` field in any new i18n entry
- [ ] `setTimeout(… 5000)` for the update check is gone
- [ ] No `dialog.showMessageBox` remains in the updater path
- [ ] Restart is offered in both the banner and the settings row, and in neither while a task is running
