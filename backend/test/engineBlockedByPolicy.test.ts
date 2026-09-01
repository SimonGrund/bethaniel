// A user's llama-server.exe died instantly on every launch — any model, any
// args, even `--help` — with a nonzero exit code and not one byte of stdout
// or stderr. Direct investigation traced it to Windows Smart App Control
// silently blocking the unsigned binary: not a crash (llama-server never got
// to run any of its own code), which is why no OOM/corrupt-model/bind-error
// text was ever there to match against. Detected instead by the absence of
// any output at all, which a genuine crash never produces.

import { test } from "node:test";
import assert from "node:assert/strict";

import { diagnoseEngineExit } from "../src/logBus.ts";

test("zero output + nonzero exit on Windows reads as a policy block", () => {
  const d = diagnoseEngineExit("", 3236495362, null, { platform: "win32" });
  assert.equal(d.hintKey, "log_hint_engine_blocked_by_policy");
  assert.equal(d.level, "error");
});

test("whitespace-only output still counts as zero output", () => {
  const d = diagnoseEngineExit("   \n  \n", 1, null, { platform: "win32" });
  assert.equal(d.hintKey, "log_hint_engine_blocked_by_policy");
});

test("the same symptom on macOS/Linux is not diagnosed as a Windows policy block", () => {
  // Signals are how a killed process is normally reported on POSIX; this
  // should fall through to a generic crash rather than a Windows-specific hint.
  assert.notEqual(
    diagnoseEngineExit("", 1, null, { platform: "darwin" }).hintKey,
    "log_hint_engine_blocked_by_policy",
  );
  assert.notEqual(
    diagnoseEngineExit("", 1, null, { platform: "linux" }).hintKey,
    "log_hint_engine_blocked_by_policy",
  );
});

test("a real crash with actual output is not misdiagnosed as a policy block", () => {
  assert.equal(
    diagnoseEngineExit("segmentation fault", 1, null, { platform: "win32" })
      .hintKey,
    "log_hint_engine_crash_generic",
  );
});

test("a clean exit (code 0) is never a policy block even with no output", () => {
  assert.notEqual(
    diagnoseEngineExit("", 0, null, { platform: "win32" }).hintKey,
    "log_hint_engine_blocked_by_policy",
  );
});

test("a deliberate stop still wins even with zero output on Windows", () => {
  assert.equal(
    diagnoseEngineExit("", null, "SIGKILL", {
      deliberate: true,
      platform: "win32",
    }).hintKey,
    "log_hint_model_unloaded",
  );
});
