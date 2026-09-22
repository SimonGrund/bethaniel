// ── Knowing that an update is still installing ──
//
// The install runs AFTER the app exits and takes minutes: a 440 MB bundle has
// to be unpacked and swapped. Reopening inside that window launches the old
// binary, which then truthfully — and uselessly — reports that an update is
// available, and clicking the button again just quits into the same wait.
//
// So the app writes down what it is installing before it goes. On the next
// launch this module says what that note means. Pure, because the only way to
// exercise it otherwise is to ship a release and wait three minutes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { installVerdict, compareVersions } from "../../electron/updateInstallMarker.ts";

const NOW = 1_700_000_000_000;
const marker = (version: string, ageMs = 0) => ({
  version,
  startedAt: NOW - ageMs,
});

test("no note means nothing to say", () => {
  assert.equal(installVerdict(null, "2.26.1", NOW), "none");
});

test("a note for a version we are now running means the install landed", () => {
  assert.equal(installVerdict(marker("2.27.0"), "2.27.0", NOW), "finished");
});

test("a note older than the running version is left over from before", () => {
  assert.equal(installVerdict(marker("2.26.1"), "2.27.0", NOW), "finished");
});

test("a fresh note for a newer version means it is still installing", () => {
  assert.equal(
    installVerdict(marker("2.27.0", 30_000), "2.26.1", NOW),
    "installing",
  );
});

test("an hour-old note is given up on rather than nagging forever", () => {
  // The install may have failed, or the machine may have been shut down. Either
  // way the ordinary update path is a better answer than a banner that can
  // never clear itself.
  assert.equal(
    installVerdict(marker("2.27.0", 60 * 60 * 1000), "2.26.1", NOW),
    "finished",
  );
});

test("a malformed note is ignored rather than trusted", () => {
  for (const bad of [{}, { version: "2.27.0" }, { startedAt: NOW }, { version: 7, startedAt: NOW }])
    assert.equal(installVerdict(bad as never, "2.26.1", NOW), "none", JSON.stringify(bad));
});

test("a note from the future is not treated as stale", () => {
  // A clock change should not make a running install look abandoned.
  assert.equal(
    installVerdict(marker("2.27.0", -60_000), "2.26.1", NOW),
    "installing",
  );
});

test("versions compare by number, not by string", () => {
  // "2.9.0" > "2.10.0" as text, which would declare a finished install still
  // running — and the banner would never clear.
  assert.ok(compareVersions("2.10.0", "2.9.0") > 0);
  assert.ok(compareVersions("2.27.0", "2.27.0") === 0);
  assert.ok(compareVersions("2.26.1", "2.27.0") < 0);
  assert.ok(compareVersions("3.0.0", "2.99.99") > 0);
});

test("a beta suffix does not break the comparison", () => {
  assert.ok(compareVersions("2.27.0-beta.1", "2.27.0") <= 0);
  assert.ok(compareVersions("2.28.0-beta.1", "2.27.0") > 0);
});
