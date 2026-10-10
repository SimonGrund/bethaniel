// ── What Betty says about the GPU engine (frontend gpuEngineNote.ts) ──

import { test } from "node:test";
import assert from "node:assert/strict";

import { gpuNoteFor } from "../../frontend/src/gpuEngineNote.ts";

const ctx = { localModel: true, sawSetup: true, dismissed: [] as string[] };

test("progress, testing and ready are said while the setup runs", () => {
  assert.deepEqual(
    gpuNoteFor({ state: "downloading", engine: "cuda", gpu: "RTX 3060", bytes: 450, total: 1000 }, ctx),
    { key: "gpu_setup_downloading", gpu: "RTX 3060", percent: 45 },
  );
  assert.equal(gpuNoteFor({ state: "testing", gpu: "RTX 3060" }, ctx)?.key, "gpu_setup_testing");
  assert.equal(gpuNoteFor({ state: "ready", gpu: "RTX 3060" }, ctx)?.key, "gpu_setup_ready");
  // Ready since an earlier session is not news.
  assert.equal(gpuNoteFor({ state: "ready", gpu: "RTX 3060" }, { ...ctx, sawSetup: false }), null);
});

test("no driver and a failed setup are said once, until waved away", () => {
  const driver = gpuNoteFor({ state: "needs-driver", gpu: "Microsoft Basic Display Adapter" }, ctx);
  assert.equal(driver?.key, "gpu_needs_driver");
  assert.match(driver?.link ?? "", /nvidia\.com/);
  assert.equal(gpuNoteFor({ state: "needs-driver" }, { ...ctx, dismissed: ["gpu-needs-driver"] }), null);
  assert.equal(gpuNoteFor({ state: "failed", error: "x" }, ctx)?.dismissKey, "gpu-failed");
  assert.equal(gpuNoteFor({ state: "failed" }, { ...ctx, dismissed: ["gpu-failed"] }), null);
});

test("nothing is said where there is no GPU to talk about, or no local model", () => {
  for (const state of ["checking", "not-needed"] as const) assert.equal(gpuNoteFor({ state }, ctx), null);
  assert.equal(gpuNoteFor(null, ctx), null);
  assert.equal(gpuNoteFor({ state: "needs-driver" }, { ...ctx, localModel: false }), null);
});
