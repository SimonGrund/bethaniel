// ── What the update banner says, and when Restart may be pressed ──
//
// Pure, and tested from here because the frontend has no test runner — the
// same reach-across codeBalanceNote.test.ts uses.
//
// The rule worth pinning hardest: while any task is running, Restart is NOT
// offered. quitAndInstall() kills the job, and that job may be a cloud run the
// author has already paid for. The update installs on the next ordinary quit
// regardless (autoInstallOnAppQuit), so withholding the shortcut costs nothing
// and removes the only way to lose paid work to a mistimed click.

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
  assert.equal(
    bannerFor(st({ phase: "up-to-date", version: "2.23.0" }), false),
    null,
  );
});

test("banner: downloading shows the version and the percentage", () => {
  const v = bannerFor(
    st({ phase: "downloading", version: "2.23.0", percent: 42 }),
    false,
  );
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
  assert.equal(
    bannerFor(
      st({ phase: "error", message: "getaddrinfo ENOTFOUND", manual: false }),
      false,
    ),
    null,
  );
});

test("banner: a manual failure is silent too — the settings row answers it", () => {
  // The person is looking at the row they just pressed. Saying it twice, in
  // two places, reads as two problems.
  assert.equal(
    bannerFor(st({ phase: "error", message: "nope", manual: true }), false),
    null,
  );
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
  assert.equal(
    settingsRowFor(st({ phase: "error", manual: true }), false).key,
    "update_error",
  );
  assert.equal(
    settingsRowFor(st({ phase: "error", manual: false }), false).key,
    "update_check",
  );
});

test("settings row: offers Restart when ready and idle, and not when busy", () => {
  assert.equal(
    settingsRowFor(st({ phase: "downloaded", version: "2.23.0" }), false)
      .showRestart,
    true,
  );
  assert.equal(
    settingsRowFor(st({ phase: "downloaded", version: "2.23.0" }), true)
      .showRestart,
    false,
  );
});

test("every key the views can return exists in all four languages", async () => {
  const { default: TRANSLATIONS } = await import("../../frontend/src/i18n.ts");
  const phases: UpdateStatus["phase"][] = [
    "idle",
    "checking",
    "up-to-date",
    "available",
    "downloading",
    "downloaded",
    "error",
  ];
  const keys = new Set<string>(["update_restart"]);
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
