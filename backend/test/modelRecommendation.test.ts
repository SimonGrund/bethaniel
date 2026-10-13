// Tests for the "is this machine worth running Betty on?" table.
//
// Two local models, picked from the hardware (a strong machine gets the
// larger one), then a speed expectation: how many manuscript words a second
// this hardware should manage, and whether that is slow enough to say so. The bug the original table replaced still
// matters as an assertion: a 32 GB CPU-only laptop must not be promised a
// fast run just because the model fits.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  appleChipVariant,
  expectedFreeVramMib,
  expectedWordsPerSec,
  expectedWordsPerSecFor,
  getAllowedTiers,
  runsLargeModel,
  isTrusted,
  median,
  pushSample,
  recommendModel,
  summarizeHardware,
  CPU_WORDS_PER_SEC,
  FLOOR_TPS,
  MIN_SAMPLES,
  PERF_WINDOW,
  REFERENCE_WORDS,
  type HardwareInfo,
} from "../src/modelRecommendation.ts";
import { getLargeLocalEntry, getLocalEntry, MODEL_CATALOG } from "../src/modelCatalog.ts";
import { fitsInVram } from "../src/llamaServer.ts";

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

// ── The catalog the table is built on ────────────────────────────────────

test("two local models, both called Local Betty: the baseline and a larger one", () => {
  const offered = MODEL_CATALOG.filter((e) => e.source === "gguf" && !e.deprecated);
  assert.deepEqual(offered.map((e) => e.tier).sort(), ["big", "small"]);
  for (const e of offered) assert.equal(e.name, "Local Betty");
  assert.equal(getLocalEntry().tier, "small");
  assert.equal(getLargeLocalEntry()!.tier, "big");
  // Only the advanced settings tell them apart.
  assert.equal(getLocalEntry().variant, undefined);
  assert.equal(getLargeLocalEntry()!.variant, "large");
});

// ── Which Local Betty this machine gets ──────────────────────────────────

test("a strong machine gets the larger model; everything else the 4B", () => {
  assert.equal(runsLargeModel(nvidia(32)), true);
  assert.equal(runsLargeModel(nvidia(24)), true);
  assert.equal(runsLargeModel(nvidia(16)), true);
  assert.equal(runsLargeModel(nvidia(12)), false);
  assert.equal(runsLargeModel(nvidia(8)), false);
  assert.equal(runsLargeModel(apple("Apple M4 Max", 36)), true);
  assert.equal(runsLargeModel(apple("Apple M2 Ultra", 64)), true);
  assert.equal(runsLargeModel(apple("Apple M4 Max", 24)), false);
  assert.equal(runsLargeModel(apple("Apple M3 Pro", 36)), false);
  assert.equal(runsLargeModel(apple("Apple M1", 16)), false);
  assert.equal(runsLargeModel(hw({ totalRamGb: 64 })), false);
  // A big card in a machine short of RAM still gets the 4B.
  assert.equal(runsLargeModel(nvidia(24, 8)), false);
  assert.equal(recommendModel(nvidia(32)).entry.tier, "big");
  assert.equal(recommendModel(nvidia(12)).entry.tier, "small");
  assert.equal(recommendModel(hw()).entry.tier, "small");
});

test("the larger model is promised less speed than the 4B on the same card", () => {
  const big = getLargeLocalEntry()!;
  assert.ok(expectedWordsPerSecFor(nvidia(32), big) < expectedWordsPerSec(nvidia(32)));
  assert.equal(recommendModel(nvidia(32)).wordsPerSec, expectedWordsPerSecFor(nvidia(32), big));
  assert.equal(expectedWordsPerSecFor(nvidia(32), getLocalEntry()), expectedWordsPerSec(nvidia(32)));
});

test("a larger model that measured too slow steps the machine down to the 4B, and says so", () => {
  const rec = recommendModel(nvidia(24), { big: measured(FLOOR_TPS - 1) });
  assert.equal(rec.entry.tier, "small");
  assert.equal(rec.advice?.kind, "downgrade");
  assert.equal(rec.advice?.from, "big");
  assert.equal(rec.advice?.to, "small");
  // Measured fast enough: it stays.
  assert.equal(recommendModel(nvidia(24), { big: measured(FLOOR_TPS + 10) }).entry.tier, "big");
});

// ── Layer 1: expected speed from hardware class ─────────────────────────

test("the calibration point: an RTX 5090 does a novel in about twenty minutes", () => {
  // 80,000 words in 15 minutes was measured on a 5090; the table says 80/s
  // so a 90,000-word novel reads as ~19 minutes, not the "several hours" the
  // old flat 12/s fallback printed.
  const wps = expectedWordsPerSec(nvidia(32));
  assert.equal(wps, 80);
  assert.ok(REFERENCE_WORDS / wps < 25 * 60);
});

test("NVIDIA cards step down by VRAM band, and unreadable VRAM lands at the bottom", () => {
  assert.ok(expectedWordsPerSec(nvidia(24)) < expectedWordsPerSec(nvidia(32)));
  assert.ok(expectedWordsPerSec(nvidia(16)) < expectedWordsPerSec(nvidia(24)));
  assert.ok(expectedWordsPerSec(nvidia(12)) < expectedWordsPerSec(nvidia(16)));
  assert.ok(expectedWordsPerSec(nvidia(8)) < expectedWordsPerSec(nvidia(12)));
  const unreadable = hw({ gpu: { vendor: "nvidia", vramGb: null, name: "x" } });
  assert.equal(expectedWordsPerSec(unreadable), expectedWordsPerSec(hw()));
});

test("a card the loader will not offload to is promised CPU speed, not GPU speed", () => {
  // The loader offloads all or nothing, against the VRAM it finds free. A
  // 6 GB card used to be promised 8 words/s and then ran at 3 on the CPU,
  // and the catalog's GPU-fit hint, reading the card's total, said it fit.
  const local = getLocalEntry();
  for (const vram of [4, 6, 8, 12, 16, 24, 32]) {
    const card = nvidia(vram);
    const offloads = fitsInVram(
      local.sizeBytes,
      local.defaults.num_ctx,
      1,
      expectedFreeVramMib(card)!,
    );
    const promisedGpu = expectedWordsPerSec(card) > CPU_WORDS_PER_SEC;
    assert.equal(promisedGpu, offloads, `${vram} GB card`);
  }
  assert.equal(expectedWordsPerSec(nvidia(6)), CPU_WORDS_PER_SEC);
  assert.ok(expectedWordsPerSec(nvidia(8)) > CPU_WORDS_PER_SEC);
});

test("Apple Silicon is graded by chip variant, not memory", () => {
  // Bandwidth differs ~3× between a base M4 and an M4 Max at the same RAM.
  const base = expectedWordsPerSec(apple("Apple M4", 64));
  const pro = expectedWordsPerSec(apple("Apple M4 Pro", 24));
  const max = expectedWordsPerSec(apple("Apple M4 Max", 36));
  const ultra = expectedWordsPerSec(apple("Apple M2 Ultra", 64));
  assert.ok(base < pro && pro < max && max < ultra);
  // An unnamed chip is graded as base — the table never guesses upward.
  assert.equal(expectedWordsPerSec(apple("", 128)), base);
});

test("a CPU-only machine is slow however much RAM it has", () => {
  // The original bug: 32 GB of RAM read as "fast machine". RAM says the model
  // loads, not that it runs.
  const laptop = hw({ totalRamGb: 32 });
  const wps = expectedWordsPerSec(laptop);
  assert.ok(wps <= 3);
  assert.ok(REFERENCE_WORDS / wps > 2 * 3600, "a novel is an overnight job here");
  // AMD and Intel are not identified as fast, so they read as CPU.
  assert.equal(
    expectedWordsPerSec(hw({ gpu: { vendor: "amd", vramGb: 16, name: "RX 7800" } })),
    wps,
  );
});

// ── RAM gate ─────────────────────────────────────────────────────────────

test("getAllowedTiers deduplicates the shared custom tier", () => {
  const tiers = getAllowedTiers(hw({ totalRamGb: 64 }));
  assert.deepEqual([...tiers].sort(), ["big", "custom", "small"]);
  assert.equal(new Set(tiers).size, tiers.length);
});

// ── Layer 2: measured throughput ─────────────────────────────────────────

test("below the larger model's bar it is the 4B, with the table's speed until measured", () => {
  const rec = recommendModel(nvidia(12));
  assert.equal(rec.entry.id, getLocalEntry().id);
  assert.equal(rec.tier, "small");
  assert.equal(rec.basis, "estimated");
  assert.equal(rec.wordsPerSec, expectedWordsPerSec(nvidia(12)));
  assert.equal(rec.advice, null);
});

test("a measured job rate overrides the table", () => {
  const rec = recommendModel(hw(), {
    small: { medianTps: 40, samples: MIN_SAMPLES, wordsPerSec: 27.5 },
  });
  assert.equal(rec.basis, "measured");
  assert.equal(rec.wordsPerSec, 27.5);
});

test("a trusted profile without a job rate is measured, but keeps the table's speed", () => {
  // Profiles recorded before job-level rates existed have a median but no
  // words/second; "measured" is honest about the basis, and the estimate
  // still has a number to work from.
  const rec = recommendModel(nvidia(12), { small: measured(40) });
  assert.equal(rec.basis, "measured");
  assert.equal(rec.wordsPerSec, expectedWordsPerSec(nvidia(12)));
});

test("warm-up noise never counts as a measurement", () => {
  const rec = recommendModel(nvidia(12), {
    small: { medianTps: 2, samples: MIN_SAMPLES - 1, wordsPerSec: 0.3 },
  });
  assert.equal(rec.basis, "estimated");
  assert.equal(rec.wordsPerSec, expectedWordsPerSec(nvidia(12)));
  assert.equal(rec.advice, null);
});

test("a slow local model informs, and never offers a downgrade", () => {
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

test("a healthy local model produces no advice at all", () => {
  const rec = recommendModel(hw({ totalRamGb: 16 }), {
    small: measured(FLOOR_TPS + 5),
  });
  assert.equal(rec.advice, null);
  assert.equal(rec.basis, "measured");
});

test("the recommendation carries the catalog entry the UI needs", () => {
  const rec = recommendModel(nvidia(32));
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

test("BETHANIEL_FAKE_RAM_GB reaches the summary and the RAM gate", () => {
  const machine = nvidia(24);
  assert.ok(getAllowedTiers(machine).includes("small"));

  process.env.BETHANIEL_FAKE_RAM_GB = "4";
  try {
    assert.equal(summarizeHardware(machine).totalRamGb, 4);
    assert.ok(!getAllowedTiers(machine).includes("small"));
  } finally {
    delete process.env.BETHANIEL_FAKE_RAM_GB;
  }
});
