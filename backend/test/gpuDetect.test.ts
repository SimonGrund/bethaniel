// ── Which engine a machine's GPU can use (gpuDetect.ts) ──
//
// Windows ships a CPU-only engine; a GPU needs a different build. NVIDIA with
// its driver gets CUDA, a discrete AMD or Intel card gets Vulkan, integrated
// graphics stay on the CPU (sharing system memory, they are rarely faster),
// and an NVIDIA card without its driver is told so — installing a driver
// needs admin rights Betty does not have.

import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyGpu, parseListDevices, parseVideoControllers, planGpuEngine } from "../src/gpuDetect.ts";

test("Windows' video controllers are read by vendor id, not by name", () => {
  const json = JSON.stringify([
    { Name: "NVIDIA GeForce RTX 3060", PNPDeviceID: "PCI\\VEN_10DE&DEV_2504&SUBSYS_1" },
    // No driver: Windows names it generically, but the vendor id is NVIDIA's.
    { Name: "Microsoft Basic Display Adapter", PNPDeviceID: "PCI\\VEN_10DE&DEV_2786" },
    { Name: "Intel(R) UHD Graphics 770", PNPDeviceID: "PCI\\VEN_8086&DEV_4680" },
    { Name: "Parsec Virtual Display Adapter", PNPDeviceID: "ROOT\\DISPLAY\\0000" },
  ]);
  assert.deepEqual(
    parseVideoControllers(json).map((g) => [g.vendor, g.discrete]),
    [["nvidia", true], ["nvidia", true], ["intel", false], ["other", false]],
  );
  // One adapter comes back as an object, not an array; nothing as empty.
  assert.equal(parseVideoControllers(JSON.stringify({ Name: "AMD Radeon RX 7800 XT", PNPDeviceID: "PCI\\VEN_1002&DEV_747E" })).length, 1);
  assert.deepEqual(parseVideoControllers(""), []);
  assert.deepEqual(parseVideoControllers("not json"), []);
});

test("AMD and Intel: discrete cards, not integrated graphics", () => {
  const amd = (name: string) => classifyGpu(name, "PCI\\VEN_1002&DEV_0000");
  const intel = (name: string) => classifyGpu(name, "PCI\\VEN_8086&DEV_0000");
  for (const n of ["AMD Radeon RX 7900 XTX", "AMD Radeon RX 6800M", "AMD Radeon Pro W6800", "AMD Radeon R9 390", "Radeon VII"]) {
    assert.equal(amd(n).discrete, true, n);
  }
  for (const n of ["AMD Radeon(TM) Graphics", "AMD Radeon 780M Graphics", "AMD Radeon Vega 8 Graphics", "AMD Radeon R7 Graphics"]) {
    assert.equal(amd(n).discrete, false, n);
  }
  for (const n of ["Intel(R) Arc(TM) A770 Graphics", "Intel(R) Arc(TM) B580 Graphics", "Intel(R) Arc(TM) A370M Graphics"]) {
    assert.equal(intel(n).discrete, true, n);
  }
  // Core Ultra's integrated graphics are called "Arc" too.
  for (const n of ["Intel(R) Arc(TM) Graphics", "Intel(R) Arc(TM) 140V GPU (16GB)", "Intel(R) Iris(R) Xe Graphics"]) {
    assert.equal(intel(n).discrete, false, n);
  }
});

const g = (vendor: "nvidia" | "amd" | "intel" | "other", name: string, discrete = true) => ({ vendor, name, discrete });

test("the plan: CUDA with NVIDIA's driver, Vulkan for a discrete AMD or Intel card", () => {
  const win = { platform: "win32", arch: "x64" };
  assert.deepEqual(planGpuEngine({ ...win, gpus: [g("nvidia", "NVIDIA GeForce RTX 3060")], nvidiaDriver: true }), {
    engine: "cuda",
    gpu: "NVIDIA GeForce RTX 3060",
  });
  assert.deepEqual(planGpuEngine({ ...win, gpus: [g("amd", "AMD Radeon RX 7800 XT")], nvidiaDriver: false }), {
    engine: "vulkan",
    gpu: "AMD Radeon RX 7800 XT",
  });
  // A laptop with an NVIDIA card beside integrated Intel graphics: CUDA.
  assert.equal(
    planGpuEngine({ ...win, gpus: [g("intel", "Intel(R) UHD Graphics", false), g("nvidia", "NVIDIA GeForce RTX 4060 Laptop GPU")], nvidiaDriver: true }).engine,
    "cuda",
  );
});

test("the plan: an NVIDIA card without its driver is said so; integrated graphics stay on CPU", () => {
  const win = { platform: "win32", arch: "x64" };
  assert.deepEqual(
    planGpuEngine({ ...win, gpus: [g("nvidia", "Microsoft Basic Display Adapter")], nvidiaDriver: false }),
    { engine: "none", reason: "nvidia-needs-driver", gpu: "Microsoft Basic Display Adapter" },
  );
  // ...unless another card can be used meanwhile.
  assert.equal(
    planGpuEngine({ ...win, gpus: [g("nvidia", "x"), g("amd", "AMD Radeon RX 6600")], nvidiaDriver: false }).engine,
    "vulkan",
  );
  assert.deepEqual(planGpuEngine({ ...win, gpus: [g("intel", "Intel(R) Iris(R) Xe Graphics", false)], nvidiaDriver: false }), {
    engine: "none",
    reason: "integrated-only",
  });
  assert.deepEqual(planGpuEngine({ ...win, gpus: [], nvidiaDriver: false }), { engine: "none", reason: "no-gpu" });
  // Mac (Metal) and Linux (bundled Vulkan) already have their GPU engines.
  assert.deepEqual(planGpuEngine({ platform: "darwin", arch: "arm64", gpus: [], nvidiaDriver: false }), {
    engine: "none",
    reason: "bundled",
  });
});

test("the engine's own device list says whether the GPU build really works", () => {
  const cuda = "load_backend: loaded CUDA backend from ggml-cuda.dll\nAvailable devices:\n  CUDA0: NVIDIA GeForce RTX 3060 (12287 MiB, 11233 MiB free)\n";
  assert.deepEqual(parseListDevices(cuda), [{ backend: "cuda", name: "NVIDIA GeForce RTX 3060", freeMiB: 11233 }]);
  const vk = "Available devices:\n  Vulkan0: AMD Radeon RX 7800 XT (16368 MiB, 15800 MiB free)\n";
  assert.equal(parseListDevices(vk)[0].backend, "vulkan");
  // A build whose runtime did not load lists no GPU at all.
  assert.deepEqual(parseListDevices("Available devices:\n"), []);
});

// ── What to do about it (gpuEngineManager.ts) ──

import { gpuEngineAction } from "../src/gpuEngineManager.ts";

test("install, test, use or skip: a GPU engine is used only once it has been tested", () => {
  const cuda = { engine: "cuda" as const, gpu: "RTX" };
  const base = { plan: cuda, installed: false, verifiedVersion: null, failedVersion: null, version: "b9279" };
  assert.equal(gpuEngineAction(base), "install");
  assert.equal(gpuEngineAction({ ...base, installed: true, verifiedVersion: "b9279" }), "use");
  // Installed by an older app, which never tested it.
  assert.equal(gpuEngineAction({ ...base, installed: true }), "test");
  // Tested at an older engine version: the new one is downloaded.
  assert.equal(gpuEngineAction({ ...base, installed: true, verifiedVersion: "b8000" }), "install");
  // A test that failed is not repeated at the same version, but is at a new one.
  assert.equal(gpuEngineAction({ ...base, failedVersion: "b9279" }), "skip");
  assert.equal(gpuEngineAction({ ...base, failedVersion: "b8000" }), "install");
  assert.equal(gpuEngineAction({ ...base, plan: { engine: "none", reason: "no-gpu" } }), "skip");
});
