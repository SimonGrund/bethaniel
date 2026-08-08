// A SIGKILL is only evidence of memory trouble when we did not send it.
//
// The idle-unloader deliberately stops the engine to free RAM: SIGTERM, then
// SIGKILL 3s later if it has not exited. Because diagnoseEngineExit mapped a
// bare SIGKILL to log_hint_oom, that intentional shutdown surfaced as
// "Out of memory. Pick a smaller model…" on machines with gigabytes free —
// advice that is not merely noise but points the user the wrong way.
//
// The OS OOM killer really does SIGKILL, so the signal keeps its meaning for
// kills we did not initiate.

import { test } from "node:test";
import assert from "node:assert/strict";

import { diagnoseEngineExit } from "../src/logBus.ts";

const BENIGN = [
  "srv  update_slots: all slots are idle",
  "srv  cancel task, id_task = 5",
].join("\n");

test("a SIGKILL we sent ourselves is not diagnosed as OOM", () => {
  const d = diagnoseEngineExit(BENIGN, null, "SIGKILL", {
    deliberate: true,
  });
  assert.notEqual(d.hintKey, "log_hint_oom");
});

test("a deliberate stop is reported calmly, not as an error", () => {
  const d = diagnoseEngineExit(BENIGN, null, "SIGKILL", { deliberate: true });
  assert.equal(d.hintKey, "log_hint_model_unloaded");
  assert.equal(d.level, "info");
});

test("a SIGKILL we did NOT send still reads as OOM", () => {
  // The OS OOM killer is the real thing this heuristic is for.
  const d = diagnoseEngineExit(BENIGN, null, "SIGKILL");
  assert.equal(d.hintKey, "log_hint_oom");
});

test("genuine allocation failures are still OOM even when deliberate", () => {
  // If the engine was already dying of memory exhaustion when we stopped it,
  // the output is the stronger evidence and should win.
  const d = diagnoseEngineExit(
    "ggml: failed to allocate buffer of size 8192",
    null,
    "SIGKILL",
    { deliberate: true },
  );
  assert.equal(d.hintKey, "log_hint_oom");
});
