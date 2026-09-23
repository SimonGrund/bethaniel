// Which Betty produced a run, recorded rather than inferred.
//
// The case that made this worth saving: a defect reported from a run, and
// telling a dev run from the installed app took the task database, the app
// bundle's Info.plist and a git log — and still landed wrong, because
// `npm run dev`'s Electron writes to the same data directory as the installed
// app and the footer shows package.json's version, which CI never bumps.

import { test } from "node:test";
import assert from "node:assert/strict";

const ENV = { ...process.env };

async function freshModule() {
  // The env is read at module load, so each case needs its own instance.
  return import(`../src/appVersion.ts?${Math.random()}`);
}

test.afterEach(() => {
  process.env = { ...ENV };
});

test("what Electron says wins — it is the only source that knows a shipped build", async () => {
  process.env.BETHANIEL_VERSION = "2.28.0";
  const m = await freshModule();
  assert.equal(m.appVersion(), "2.28.0");
});

test("without it, the repo's own version — which is what a dev run runs", async () => {
  delete process.env.BETHANIEL_VERSION;
  const m = await freshModule();
  // Whatever package.json currently says, it must be a real version string
  // rather than a guess or an empty value.
  assert.match(m.appVersion(), /^\d+\.\d+\.\d+/);
});

test("a blank env value does not win", async () => {
  process.env.BETHANIEL_VERSION = "   ";
  const m = await freshModule();
  assert.match(m.appVersion(), /^\d+\.\d+\.\d+/);
});

test("a dev run says so, because the version alone cannot tell them apart", async () => {
  process.env.BETHANIEL_VERSION = "2.27.0";
  process.env.NODE_ENV = "development";
  const m = await freshModule();
  assert.equal(m.isDevRun(), true);
  assert.equal(m.runVersionLabel(), "2.27.0-dev");
});

test("a packaged run carries the bare version", async () => {
  process.env.BETHANIEL_VERSION = "2.28.0";
  process.env.NODE_ENV = "production";
  const m = await freshModule();
  assert.equal(m.isDevRun(), false);
  assert.equal(m.runVersionLabel(), "2.28.0");
});
