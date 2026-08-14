// "Model engine crashed while running Qwen3.5-9B-Q4_K_M.gguf (exit 1)" is what
// the user saw. The engine's own output said something quite different:
//
//   couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 8012
//
// The model was fine. A leftover engine was holding the port. Reporting that as
// a crash sends the user looking for a fault in the model — the one place the
// problem definitely is not.

import { test } from "node:test";
import assert from "node:assert/strict";

import { diagnoseEngineExit, diagnoseTaskError } from "../src/logBus.ts";

const BIND_FAILURE = [
  "main: loading model",
  "srv    load_model: loaded model",
  "main: couldn't bind HTTP server socket, hostname: 127.0.0.1, port: 8012",
  "main: exiting due to model loading error",
].join("\n");

test("a bind failure is reported as a port conflict, not a crash", () => {
  const d = diagnoseEngineExit(BIND_FAILURE, 1, null);
  assert.equal(d.hintKey, "log_hint_port_conflict");
  assert.equal(d.level, "error");
});

test("the port conflict survives the misleading 'model loading error' line", () => {
  // llama-server prints "exiting due to model loading error" on a bind failure
  // too. Whichever rule matches first decides what the user is told, so the
  // port rule must outrank the corrupt-model rule.
  assert.equal(
    diagnoseEngineExit(BIND_FAILURE + "\nfailed to load model", 1, null).hintKey,
    "log_hint_port_conflict",
  );
});

test("a real crash is still a crash", () => {
  assert.equal(
    diagnoseEngineExit("segmentation fault", 1, null).hintKey,
    "log_hint_engine_crash_generic",
  );
});

test("an out-of-memory engine is still OOM", () => {
  // The stronger evidence must keep winning; the new rule must not shadow it.
  assert.equal(
    diagnoseEngineExit("ggml: failed to allocate buffer", 1, null).hintKey,
    "log_hint_oom",
  );
});

test("a deliberate stop is not reported as a port conflict", () => {
  // Stale output can linger in the ring buffer after we ask the engine to quit.
  assert.equal(
    diagnoseEngineExit(BIND_FAILURE, null, "SIGKILL", { deliberate: true })
      .hintKey,
    "log_hint_model_unloaded",
  );
});

test("the pre-flight port error reaches the same hint", () => {
  // We now refuse to launch into a port we know is taken. That error travels
  // the task-error path, which must classify it the same way.
  const d = diagnoseTaskError(
    "Port 8012 is already in use by llama-server (pid 58897). " +
      "Another copy of the engine is probably still running — quit it and try again.",
  );
  assert.equal(d?.hintKey, "log_hint_port_conflict");
});
