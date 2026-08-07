// Tests for the "which Betty should this machine run?" decision table.
//
// The bug this replaces: the old logic recommended the biggest model that fit
// in RAM, so a 32 GB CPU-only laptop was pointed at a 24B model decoding at
// ~2 tok/s. The headline assertion here is that the same machine now gets
// Baby Betty.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appleChipVariant,
  getAllowedTiers,
  guessTierFromHardware,
  isTrusted,
  median,
  pushSample,
  recommendModel,
  summarizeHardware,
  FLOOR_TPS,
  MIN_SAMPLES,
  PERF_WINDOW,
  type HardwareInfo,
} from "../src/modelRecommendation.ts";

// ── Helpers ──────────────────────────────────────────────────────────────

function hw(overrides: Partial<HardwareInfo> = {}): HardwareInfo {
  return {
    totalRamGb: 16,
    freeRamGb: 8,
    platform: "linux",
    arch: "x64",
    appleSilicon: false,
    cpuCount: 8,
    gpu: { vendor: "none", vramGb: null, name: null },
    ...overrides,
  };
}

function nvidia(vramGb: number, totalRamGb = 64): HardwareInfo {
  return hw({
    totalRamGb,
    gpu: {
      vendor: "nvidia",
      vramGb,
      name: `NVIDIA GeForce RTX ${vramGb >= 32 ? "5090" : "4070"}`,
    },
  });
}

function apple(chip: string, totalRamGb: number): HardwareInfo {
  return hw({
    totalRamGb,
    platform: "darwin",
    arch: "arm64",
    appleSilicon: true,
    gpu: { vendor: "apple", vramGb: totalRamGb, name: chip },
  });
}

/** A profile with enough samples to be trusted, at the given median. */
function measured(medianTps: number, samples = MIN_SAMPLES) {
  return { medianTps, samples };
}

// ── Apple chip parsing ───────────────────────────────────────────────────

test("appleChipVariant reads the marketing name", () => {
  assert.equal(appleChipVariant("Apple M4 Max"), "max");
  assert.equal(appleChipVariant("Apple M2 Ultra"), "ultra");
  assert.equal(appleChipVariant("Apple M3 Pro"), "pro");
  assert.equal(appleChipVariant("Apple M1"), "base");
});

test("appleChipVariant rejects non-Apple and missing names", () => {
  assert.equal(appleChipVariant(null), null);
  assert.equal(appleChipVariant("Intel(R) Core(TM) i9-9880H"), null);
  assert.equal(appleChipVariant(""), null);
});

// ── Layer 1: the GPU-class guess ─────────────────────────────────────────

test("a CPU-only machine gets Baby Betty however much RAM it has", () => {
  // The headline regression: 32 GB of system RAM used to qualify for the 24B.
  assert.equal(guessTierFromHardware(hw({ totalRamGb: 32 })), "small");
  assert.equal(guessTierFromHardware(hw({ totalRamGb: 128 })), "small");
});

test("NVIDIA VRAM thresholds", () => {
  assert.equal(guessTierFromHardware(nvidia(8)), "small");
  assert.equal(guessTierFromHardware(nvidia(11.9)), "small");
  assert.equal(guessTierFromHardware(nvidia(12)), "normal");
  assert.equal(guessTierFromHardware(nvidia(16)), "normal");
  assert.equal(guessTierFromHardware(nvidia(23.9)), "normal");
  assert.equal(guessTierFromHardware(nvidia(24)), "big");
  assert.equal(guessTierFromHardware(nvidia(32)), "big");
});

test("an unreadable GPU is treated as no GPU, never as a fast one", () => {
  const unknown = hw({
    totalRamGb: 64,
    gpu: { vendor: "amd", vramGb: 24, name: "AMD Radeon RX 7900 XTX" },
  });
  assert.equal(guessTierFromHardware(unknown), "small");

  // NVIDIA detected but VRAM unreadable — still no promotion.
  const noVram = hw({
    totalRamGb: 64,
    gpu: { vendor: "nvidia", vramGb: null, name: "NVIDIA GeForce RTX 4090" },
  });
  assert.equal(guessTierFromHardware(noVram), "small");
});

test("Apple Silicon needs both a wide-bus chip and the memory", () => {
  assert.equal(guessTierFromHardware(apple("Apple M2", 16)), "small");
  assert.equal(guessTierFromHardware(apple("Apple M4", 24)), "normal");
  assert.equal(guessTierFromHardware(apple("Apple M3 Pro", 36)), "normal");
  // 64 GB but a base chip: the memory is there, the bandwidth is not.
  assert.equal(guessTierFromHardware(apple("Apple M4", 64)), "normal");
  // Max/Ultra at 48 GB and up.
  assert.equal(guessTierFromHardware(apple("Apple M4 Max", 48)), "big");
  assert.equal(guessTierFromHardware(apple("Apple M2 Ultra", 128)), "big");
  // Max but not enough unified memory.
  assert.equal(guessTierFromHardware(apple("Apple M4 Max", 36)), "normal");
});

test("an unnamed Apple chip cannot reach the top tier", () => {
  // sysctl failed; we know it's Apple Silicon with 64 GB but not which part.
  const unnamed = hw({
    totalRamGb: 64,
    platform: "darwin",
    arch: "arm64",
    appleSilicon: true,
    gpu: { vendor: "apple", vramGb: 64, name: null },
  });
  assert.equal(guessTierFromHardware(unnamed), "normal");
});

// ── RAM clamp ────────────────────────────────────────────────────────────

test("the RAM gate clamps a guess the machine cannot load", () => {
  // A 24 GB card in a box with only 8 GB of system RAM: the guess says "big",
  // but Big Bad Betty needs 24 GB and Basic Betty 16 GB, so it lands on small.
  const starved = hw({ totalRamGb: 8, gpu: { vendor: "nvidia", vramGb: 24, name: "x" } });
  assert.equal(guessTierFromHardware(starved), "big");
  assert.equal(recommendModel(starved).tier, "small");
});

test("under the minimum for everything we still name the smallest model", () => {
  // Refusing to answer would leave the first-run popup with nothing to offer.
  const tiny = hw({ totalRamGb: 4 });
  assert.equal(recommendModel(tiny).tier, "small");
});

test("getAllowedTiers deduplicates the shared custom tier", () => {
  // Custom Betty and External Betty both have minRam 0 and tier "custom".
  // The old version pushed one entry per catalog row, so the array ended
  // ["small","normal","big","custom","custom"] and reverse()[0] was always
  // "custom" — which is how the Recommended badge ended up on the cloud card.
  const tiers = getAllowedTiers(hw({ totalRamGb: 64 }));
  assert.deepEqual([...tiers].sort(), ["big", "custom", "normal", "small"]);
  assert.equal(new Set(tiers).size, tiers.length);
});

test("getAllowedTiers honours the Apple Silicon minimums", () => {
  // Basic Betty needs 16 GB generally but only 12 GB on Apple Silicon.
  assert.ok(!getAllowedTiers(hw({ totalRamGb: 12 })).includes("normal"));
  assert.ok(getAllowedTiers(apple("Apple M2", 12)).includes("normal"));
});

// ── Layer 2: measured correction ─────────────────────────────────────────

test("a trusted median below the floor downgrades one tier", () => {
  const machine = nvidia(24);
  assert.equal(recommendModel(machine).tier, "big");

  const rec = recommendModel(machine, { big: measured(FLOOR_TPS - 1) });
  assert.equal(rec.tier, "normal");
  assert.equal(rec.basis, "measured");
  assert.equal(rec.advice?.kind, "downgrade");
  assert.equal(rec.advice?.from, "big");
  assert.equal(rec.advice?.to, "normal");
});

test("measurement at or above the floor leaves the guess alone", () => {
  const rec = recommendModel(nvidia(24), { big: measured(FLOOR_TPS) });
  assert.equal(rec.tier, "big");
  assert.equal(rec.advice, null);
  assert.equal(rec.basis, "measured");
});

test("too few samples is not evidence", () => {
  const rec = recommendModel(nvidia(24), {
    big: measured(1, MIN_SAMPLES - 1),
  });
  assert.equal(rec.tier, "big", "warm-up noise must not move the recommendation");
  assert.equal(rec.basis, "estimated");
  assert.equal(rec.advice, null);
});

test("the walk keeps stepping down while each tier measures slow", () => {
  const rec = recommendModel(nvidia(24), {
    big: measured(2),
    normal: measured(3),
  });
  assert.equal(rec.tier, "small");
  assert.equal(rec.advice?.kind, "downgrade");
  assert.equal(rec.advice?.from, "big");
  assert.equal(rec.advice?.to, "small");
});

test("the walk stops at a tier we have never measured", () => {
  // Big measured slow, nothing known about normal — recommend normal and wait
  // for evidence rather than skipping straight to the smallest.
  const rec = recommendModel(nvidia(24), { big: measured(2) });
  assert.equal(rec.tier, "normal");
});

test("a slow Baby Betty informs, and never offers a downgrade", () => {
  const rec = recommendModel(hw({ totalRamGb: 16 }), {
    small: { medianTps: 3, samples: MIN_SAMPLES, wordsPerSec: 0.4 },
  });
  assert.equal(rec.tier, "small");
  assert.equal(rec.advice?.kind, "slow");
  assert.equal(rec.advice?.from, "small");
  assert.equal(rec.advice?.to, "small", "there is nothing smaller to fall back to");
  assert.equal(rec.advice?.wordsPerSec, 0.4);
  assert.equal(rec.basis, "measured");
});

test("a healthy Baby Betty produces no advice at all", () => {
  const rec = recommendModel(hw({ totalRamGb: 16 }), {
    small: measured(FLOOR_TPS + 5),
  });
  assert.equal(rec.advice, null);
  assert.equal(rec.basis, "measured");
});

test("the recommendation carries the catalog entry the UI needs", () => {
  const rec = recommendModel(nvidia(32));
  assert.equal(rec.entry.tier, "big");
  assert.ok(rec.entry.name.length > 0);
  assert.ok(rec.entry.sizeBytes > 0);
  assert.ok(rec.entry.fileName.endsWith(".gguf"));
});

// ── Sample bookkeeping ───────────────────────────────────────────────────

test("isTrusted needs MIN_SAMPLES", () => {
  assert.equal(isTrusted(undefined), false);
  assert.equal(isTrusted({ medianTps: 5, samples: MIN_SAMPLES - 1 }), false);
  assert.equal(isTrusted({ medianTps: 5, samples: MIN_SAMPLES }), true);
});

test("median handles odd, even and empty", () => {
  assert.equal(median([]), 0);
  assert.equal(median([7]), 7);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test("pushSample keeps a rolling window of the most recent values", () => {
  let samples: number[] = [];
  for (let i = 1; i <= PERF_WINDOW + 5; i++) samples = pushSample(samples, i);
  assert.equal(samples.length, PERF_WINDOW);
  assert.equal(samples[0], 6);
  assert.equal(samples.at(-1), PERF_WINDOW + 5);
});

// ── Hardware summary for the UI ──────────────────────────────────────────

test("summarizeHardware classifies the three machine kinds", () => {
  assert.equal(summarizeHardware(apple("Apple M4 Max", 64)).kind, "apple");
  assert.equal(summarizeHardware(apple("Apple M4 Max", 64)).appleVariant, "max");
  assert.equal(summarizeHardware(nvidia(24)).kind, "nvidia");
  assert.equal(summarizeHardware(nvidia(24)).vramGb, 24);
  assert.equal(summarizeHardware(hw()).kind, "cpu");
  assert.equal(summarizeHardware(hw()).appleVariant, null);
});

// ── Dev override ─────────────────────────────────────────────────────────

test("BETHANIEL_FAKE_RAM_GB overrides the RAM gate", () => {
  const machine = hw({ totalRamGb: 64, gpu: { vendor: "nvidia", vramGb: 24, name: "x" } });
  assert.equal(recommendModel(machine).tier, "big");

  process.env.BETHANIEL_FAKE_RAM_GB = "8";
  try {
    assert.equal(recommendModel(machine).tier, "small");
    assert.equal(summarizeHardware(machine).totalRamGb, 8);
  } finally {
    delete process.env.BETHANIEL_FAKE_RAM_GB;
  }
});

test("BETHANIEL_FAKE_RAM_GB also drives the Apple Silicon guess", () => {
  // Unified memory IS the deciding figure on Apple, so an override that only
  // reached the clamp would leave the Max/Ultra branch impossible to exercise
  // on any machine that doesn't already have 48 GB.
  const m4max = apple("Apple M4 Max", 16);
  assert.equal(guessTierFromHardware(m4max), "small");

  process.env.BETHANIEL_FAKE_RAM_GB = "64";
  try {
    assert.equal(guessTierFromHardware(m4max), "big");
    assert.equal(recommendModel(m4max).tier, "big");
  } finally {
    delete process.env.BETHANIEL_FAKE_RAM_GB;
  }
});
