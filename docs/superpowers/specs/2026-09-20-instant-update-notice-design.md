# Instant update notice, and a way to ask

**Date:** 2026-09-20
**Status:** approved, not yet implemented

## Why

> "Updates to Betty don't pop up until the program has been open some time. I'd
> like it to be instant, and also to have a 'look for updates' button in
> settings if possible."

The second half is a plain gap: there is no way to ask. The first half is not
what it looks like.

### The delay is the download, not the check

Today's flow, from `electron/main.ts`:

1. `setTimeout(() => autoUpdater.checkForUpdates(), 5000)` after the window opens
2. `autoDownload = true`, so a new version downloads **silently** in the background
3. The only user-visible event is `update-downloaded`, which raises a native dialog

So the wait is step 2 — the whole installer, ~100–200 MB, over a home
connection. Deleting the five-second timer would save five seconds of a
multi-minute wait and change nothing anyone could perceive.

**Instant therefore means: say something when the CHECK returns**, not when the
download finishes.

### A second problem, found on the way

`update-downloaded` can fire at any moment, including mid-run, and its dialog
offers "Restart now" → `quitAndInstall()`. That kills the job in progress —
including a paid cloud job the author has already been charged for. Nothing
about the dialog says so.

## Decisions

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Instant notice | In-app banner the moment the check returns | Two dialogs — interrupts twice for one update. Ask-before-download — adds a step to every update for a problem nobody reported. |
| Native "Update ready" dialog | **Removed**, replaced by the banner | Keeping both means the same news twice. |
| Mid-run safety | The Restart button is not offered while tasks run | Warn-and-offer-anyway — puts a destructive button in front of someone mid-task. Leave as-is — a stray click bins a paid job. |
| Button | A row in the header settings menu, status shown inline | A dialog saying "you are up to date" is a click to dismiss for the commonest outcome. |
| Restart action | Offered in **both** the banner and the settings row | Banner-only strands anyone who scrolled past it. |

## Architecture

### 1. One state object, broadcast

`electron/main.ts` keeps a single value and pushes it to the renderer on every
change (`mainWindow.webContents.send("updates:status", state)`).

```ts
export interface UpdateStatus {
  phase: "idle" | "checking" | "up-to-date" | "available"
       | "downloading" | "downloaded" | "error";
  /** The available version for available/downloading/downloaded; the running
   *  one for up-to-date. */
  version?: string;
  /** 0-100, downloading only. */
  percent?: number;
  /** error only. Never shown unless the user asked — see below. */
  message?: string;
  /** Whether a person pressed the button, or the app checked by itself. */
  manual: boolean;
}
```

The five `autoUpdater.on(...)` handlers already exist and do nothing but
`console.log`. Each gains a line that sets and broadcasts. No new event
plumbing on the updater side.

### 2. The launch check moves

From `setTimeout(…, 5000)` to the existing `did-finish-load` handler, which is
the first moment the renderer can receive an answer. Waiting five seconds to
ask a question nobody can hear the answer to was the only thing the timer
bought.

### 3. Silent when automatic, honest when asked

**An automatic check that fails says nothing.** Being offline at launch is the
normal state of a laptop on a train; a banner about it is noise, and noise is
how a banner earns being ignored.

**A manual check always answers** — including "could not reach GitHub". The
user pressed a button and is owed a reply.

This is the whole reason `manual` rides on the state.

### 4. The banner — `UpdateStrip.tsx`

Modelled on `ModelDownloadStrip.tsx`, which solves the same problem for model
downloads: read the store, return `null` when there is nothing to say.

| State | Shows |
|---|---|
| `downloading` | `Bethaniel 2.23.0 is downloading · 42%` |
| `downloaded`, queue **idle** | `Bethaniel 2.23.0 is ready.` **[Restart now]** |
| `downloaded`, queue **busy** | `Bethaniel 2.23.0 is ready — it will install next time you restart.` (no button) |
| anything else | nothing |

**Busy** means any task whose status is not terminal — `queued` or `editing`
(`TaskStatus` in `frontend/src/types.ts:469`). The store already holds this.

The absent button is the whole of the mid-run protection. The update is
already downloaded and `autoInstallOnAppQuit` is true, so it installs on the
next ordinary quit regardless: nothing is lost by not offering the shortcut,
and a paid run cannot be destroyed by a mistimed click.

### 5. The settings row

Beside "Storage & data" in `HeaderSettingsMenu.tsx`, reporting in place:

- `Check for updates` (resting)
- `Checking…`
- `Up to date (v2.23.0)`
- `Update found — downloading`
- `Ready to install` + **[Restart now]**
- `Could not check for updates` (manual only)

Hidden entirely when `window.bethaniel` is absent — a browser preview has no
updater to ask, and a button that cannot work should not be drawn.

### 6. Preload additions

Three, following the shape `onCloudCredentialClaimed` already uses:

```ts
checkForUpdates(): Promise<void>
restartToUpdate(): Promise<void>
onUpdateStatus(listener: (s: UpdateStatus) => void): () => void
```

Plus `appVersion: string` as a static field beside `platform` and `arch`
(`app.getVersion()`), because "Up to date (v2.23.0)" needs the **running**
version and the updater only reports the available one.

## Testing

The updater cannot run in dev (`IS_DEV` skips the whole block) and needs a
signed, published build to exercise for real. So the split is deliberate, and
stated rather than glossed:

| Covered by tests | Verified by hand |
|---|---|
| Updater event → `UpdateStatus` mapping, as a pure function | The IPC actually reaching the renderer |
| Banner copy per phase | A real download from GitHub releases |
| Busy-vs-idle deciding whether Restart is offered | `quitAndInstall` restarting into the new version |
| Manual errors shown, automatic errors swallowed | |

The pure parts carry the logic worth getting wrong; the hand-verified parts are
wiring that either connects or does not. A packaged build is needed to confirm
the second column, and that is a release away — so the honest claim on merge is
"logic tested, wiring reasoned about", not "works".

## Out of scope

- Release notes in the banner. `info.releaseNotes` is available, but a
  changelog needs somewhere to live and a decision about what goes in it.
- Update channels (beta/stable). `channel: latest` stays as it is.
- Checking on a schedule while the app stays open for days. Launch plus a
  button covers what was asked; a timer is a separate decision about how often
  to talk to GitHub.
