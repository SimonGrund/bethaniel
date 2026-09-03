// The sidebar badge said CPU on every Mac, on a machine demonstrably running
// on Metal (-ngl 999, model loaded in 2.8s, 25 GB of GPU memory reported).
//
// llama.cpp b9279 names the Metal device MTL0 in its startup device_info
// block, not "Metal":
//
//   device_info:
//     - MTL0    : Apple M1 Pro (25559 MiB, 25558 MiB free)
//     - BLAS    : Accelerate (0 MiB, 0 MiB free)
//     - CPU     : Apple M1 Pro (32768 MiB, 32768 MiB free)
//
// The GPU pattern matched only the spelled-out backend names, so MTL0 fell
// through and the CPU line — always present alongside a GPU — won by default.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEngineDevice } from "../src/llamaServer.ts";

test("Apple Silicon reports its GPU as MTL0", () => {
  assert.equal(
    parseEngineDevice("  - MTL0    : Apple M1 Pro (25559 MiB, 25558 MiB free)"),
    "gpu",
  );
});

test("the spelled-out backend names still read as GPU", () => {
  assert.equal(
    parseEngineDevice("  - CUDA0 : NVIDIA GeForce RTX 5090 (32607 MiB free)"),
    "gpu",
  );
  assert.equal(parseEngineDevice("  - Vulkan0 : AMD Radeon RX 7900"), "gpu");
  assert.equal(parseEngineDevice("  - Metal : Apple M2"), "gpu");
});

test("a CPU line reads as CPU", () => {
  assert.equal(
    parseEngineDevice("  - CPU     : Apple M1 Pro (32768 MiB, 32768 MiB free)"),
    "cpu",
  );
});

test("Accelerate BLAS is not a GPU", () => {
  // It sits between MTL0 and CPU in the same block and offloads nothing.
  assert.equal(
    parseEngineDevice("  - BLAS    : Accelerate (0 MiB, 0 MiB free)"),
    null,
  );
});

test("unrelated engine chatter reports no device", () => {
  assert.equal(parseEngineDevice("srv update_slots: all slots are idle"), null);
  assert.equal(parseEngineDevice("main: loading model"), null);
});
