// ── No button that cannot work ──
//
// The settings row and the banner's Restart both hang off getUpdateBridge().
// Outside the desktop app there is no preload, so it must answer null and the
// row must not be drawn at all — a "Check for updates" button in a browser
// preview would spin forever on an IPC nothing answers.
//
// The plan called for checking this by opening a browser and looking. A look
// does not survive a refactor; this does.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getUpdateBridge } from "../../frontend/src/updateBridge.ts";

/** Stand in for the renderer's global for the duration of one assertion. */
function withWindow<T>(win: unknown, fn: () => T): T {
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const previous = g.window;
  g.window = win;
  try {
    return fn();
  } finally {
    if (had) g.window = previous;
    else delete g.window;
  }
}

const FULL = {
  checkForUpdates: async () => {},
  restartToUpdate: async () => {},
  currentUpdateStatus: async () => null,
  onUpdateStatus: () => () => {},
  appVersion: async () => "2.23.0",
};

test("a browser preview gets no bridge", () => {
  assert.equal(withWindow({}, getUpdateBridge), null);
});

test("a complete preload gets one", () => {
  assert.notEqual(withWindow({ bethaniel: FULL }, getUpdateBridge), null);
});

test("an older preload without the update methods gets none", () => {
  // The app and its preload are packaged together, so this should not happen
  // — but half a bridge means calling into a contract that may not exist, and
  // showing nothing is the better failure.
  const older = { bethaniel: { selectGgufFile: async () => null } };
  assert.equal(withWindow(older, getUpdateBridge), null);
});

test("a bridge missing any single method is refused", () => {
  for (const missing of Object.keys(FULL)) {
    const partial: Record<string, unknown> = { ...FULL };
    delete partial[missing];
    assert.equal(
      withWindow({ bethaniel: partial }, getUpdateBridge),
      null,
      `bridge accepted while missing ${missing}`,
    );
  }
});
