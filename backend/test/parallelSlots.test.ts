// Decode on unified memory is bandwidth-bound: extra slots divide throughput
// rather than add it. Measured on an M1 Pro — 20.9 tok/s single-stream against
// ~17.4 aggregate across 3 slots. Slots earn their keep by overlapping prefill,
// and the second one captures most of that.

import { test } from "node:test";
import assert from "node:assert/strict";

import { slotCapFor } from "../src/llamaServer.ts";

test("Apple Silicon caps at 2", () => {
  assert.equal(slotCapFor("darwin", "arm64"), 2);
});

test("Intel Macs and other platforms keep 3", () => {
  // Discrete GPUs give KV caches their own memory, so the trade-off differs.
  assert.equal(slotCapFor("darwin", "x64"), 3);
  assert.equal(slotCapFor("linux", "x64"), 3);
  assert.equal(slotCapFor("win32", "x64"), 3);
});
