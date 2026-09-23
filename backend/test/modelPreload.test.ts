// The pre-warm is speculative, and a guess is not worth a spawned
// llama-server while something else is already running.
//
// The run that produced this: a cloud job. EditTrigger selects the cloud
// model, submits, then restores the model the author had before — so the
// pre-warm saw a local GGUF selected and started llama.cpp beside a job
// running in the cloud. The manuscript did go to the cloud and the credential
// was spent; the local engine was pure waste, and the engine log read as
// though the whole run had gone local.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isLocallyLoaded,
  shouldPreloadModel,
} from "../../frontend/src/modelPreload.ts";

test("a cloud or API model has nothing to load", () => {
  assert.equal(isLocallyLoaded("custom:bethaniel-cloud"), false);
  assert.equal(isLocallyLoaded("custom:deepseek-chat"), false);
  assert.equal(isLocallyLoaded("ollama:llama3"), false);
});

test("a local GGUF does, including a custom one", () => {
  assert.equal(isLocallyLoaded("Qwen3.5-4B-Q4_K_M.gguf"), true);
  // custom:gguf is the exception among custom: ids — it is a local file, the
  // same distinction llamaServer.ensureModelLoaded draws.
  assert.equal(isLocallyLoaded("custom:gguf"), true);
});

test("nothing selected warms nothing", () => {
  assert.equal(shouldPreloadModel({ model: "", taskStatuses: [] }), false);
});

test("an idle app warms the local model it has selected", () => {
  assert.equal(
    shouldPreloadModel({
      model: "Qwen3.5-4B-Q4_K_M.gguf",
      taskStatuses: ["done", "error", "cancelled"],
    }),
    true,
  );
});

test("a cloud run does not start a local engine beside it", () => {
  // The exact shape of the bug: the cloud job is in flight, and the model has
  // just been restored to the local one the author had before.
  assert.equal(
    shouldPreloadModel({
      model: "Qwen3.5-4B-Q4_K_M.gguf",
      taskStatuses: ["editing", "queued"],
    }),
    false,
  );
});

test("nor does a queued job that has not started", () => {
  assert.equal(
    shouldPreloadModel({
      model: "Qwen3.5-4B-Q4_K_M.gguf",
      taskStatuses: ["queued"],
    }),
    false,
  );
});

test("selecting a cloud model never warms anything, running or not", () => {
  for (const statuses of [[], ["editing"], ["done"]]) {
    assert.equal(
      shouldPreloadModel({
        model: "custom:bethaniel-cloud",
        taskStatuses: statuses,
      }),
      false,
    );
  }
});

test("a finished run leaves the next warm free to happen", () => {
  assert.equal(
    shouldPreloadModel({
      model: "Qwen3.5-4B-Q4_K_M.gguf",
      taskStatuses: ["done", "done"],
    }),
    true,
  );
});
