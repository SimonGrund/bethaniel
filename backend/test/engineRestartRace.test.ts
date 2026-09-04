// A 42-task run never finished: the engine restarted itself every ~6 seconds
// and took the editor agents down with it. From the log —
//
//   20:05:58.913  Model ready: Baby Betty
//   20:05:59.051  Model unloaded to free memory        (138 ms after ready)
//   20:05:59.127  Launching model: Baby Betty
//   20:05:59.286  Model unloaded to free memory        (kills a mid-load child)
//   20:05:59.352  Model engine did not become ready: exited before startup
//                 finished (signal SIGTERM)
//
// — followed by "Editor agent 1/2 failed for chunk 1/1 (fetch failed)" and,
// after enough rounds, "All 2 editor agents failed for chunk 1/1".
//
// Two independent defects produced that loop:
//
//  1. Every LLM request calls ensureModelLoaded() (llm.ts), and the
//     satisfaction check demanded currentCtx === targetCtx. A request wanting
//     a *smaller* context than the running engine therefore forced a full
//     restart — mid-job, out from under the agents already streaming.
//
//  2. The idle-unloader killed whatever child existed. It guarded on
//     childProcess, which is assigned at spawn, while currentModel is only
//     assigned after the health check passes — so it happily SIGTERMed an
//     engine that was still loading, and one that was still answering.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeStop,
  engineSatisfies,
  mayStopEngine,
} from "../src/llamaServer.ts";

const READY = {
  model: "Qwen3.5-4B-Q4_K_M.gguf",
  ctx: 8192,
  slots: 2,
  alive: true,
};

// ── engineSatisfies: what counts as "already loaded" ────────────────────────

test("an engine loaded with room to spare satisfies a smaller request", () => {
  // The restart loop. Chunk contexts vary per request (~3411 tok here, ~5972
  // there); demanding an exact match meant almost every request reloaded.
  assert.equal(
    engineSatisfies(READY, {
      model: "Qwen3.5-4B-Q4_K_M.gguf",
      ctx: 4096,
      slots: 1,
    }),
    true,
  );
});

test("an exact match satisfies", () => {
  assert.equal(
    engineSatisfies(READY, {
      model: "Qwen3.5-4B-Q4_K_M.gguf",
      ctx: 8192,
      slots: 2,
    }),
    true,
  );
});

test("a request needing more context than is loaded does not satisfy", () => {
  // The analysis-summary synthesis step genuinely needs a bigger window.
  assert.equal(
    engineSatisfies(READY, {
      model: "Qwen3.5-4B-Q4_K_M.gguf",
      ctx: 16384,
      slots: 1,
    }),
    false,
  );
});

test("a request needing more slots than are loaded does not satisfy", () => {
  assert.equal(
    engineSatisfies(READY, {
      model: "Qwen3.5-4B-Q4_K_M.gguf",
      ctx: 8192,
      slots: 3,
    }),
    false,
  );
});

test("a different model never satisfies, however roomy the running one", () => {
  assert.equal(
    engineSatisfies(READY, {
      model: "Qwen3.5-9B-Q4_K_M.gguf",
      ctx: 1024,
      slots: 1,
    }),
    false,
  );
});

test("a dead or missing child never satisfies", () => {
  assert.equal(
    engineSatisfies(
      { ...READY, alive: false },
      { model: "Qwen3.5-4B-Q4_K_M.gguf", ctx: 8192, slots: 2 },
    ),
    false,
  );
  assert.equal(
    engineSatisfies(
      { model: null, ctx: null, slots: null, alive: false },
      { model: "Qwen3.5-4B-Q4_K_M.gguf", ctx: 8192, slots: 2 },
    ),
    false,
  );
});

// ── mayStopEngine: when the idle-unloader is allowed to pull the trigger ────

test("an idle unload must not stop an engine that is still loading", () => {
  // This is the "exited before startup finished (signal SIGTERM)" line.
  assert.equal(
    mayStopEngine("idle-unload", { loadInFlight: true, activeRequests: 0 }),
    false,
  );
});

test("an idle unload must not stop an engine that is answering requests", () => {
  // This is the "fetch failed" the editor agents reported.
  assert.equal(
    mayStopEngine("idle-unload", { loadInFlight: false, activeRequests: 1 }),
    false,
  );
});

test("an idle unload may stop a loaded, quiet engine", () => {
  // Reclaiming RAM between jobs is the whole point — it must still work.
  assert.equal(
    mayStopEngine("idle-unload", { loadInFlight: false, activeRequests: 0 }),
    true,
  );
});

test("shutdown stops the engine whatever it is in the middle of", () => {
  // Quitting the app must not be blocked by a wedged request.
  assert.equal(
    mayStopEngine("shutdown", { loadInFlight: true, activeRequests: 4 }),
    true,
  );
});

// ── Naming the stop ─────────────────────────────────────────────────────────
//
// Every deliberate stop logged "Model unloaded to free memory", including the
// kill at the top of a reload. The restart storm above therefore read as an
// idle-unload storm, which is not where the fault was. A stop should say which
// kind it is.

test("the kill that begins a reload is reported as a restart", () => {
  assert.match(describeStop("reload"), /restart/i);
  assert.doesNotMatch(describeStop("reload"), /free memory/i);
});

test("an idle unload still says it is reclaiming memory", () => {
  assert.match(describeStop("idle-unload"), /free memory/i);
});

test("shutdown says so", () => {
  assert.match(describeStop("shutdown"), /shut/i);
});
