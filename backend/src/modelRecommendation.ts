// ── Is this machine worth running Betty on? ──
//
// There used to be two local models and this module chose between them from
// GPU class. There is one now: the 9B tied the 4B on copy edit, lost to it on
// line edit, and the one pass it was better at — translation — no longer runs
// locally at all. So the question is no longer "which Betty" but "how long
// will Local Betty take here, and is that a wait worth having".
//
// The answer has two layers:
//
//   1. An expected words-per-second from hardware class. Calibrated against
//      one real measurement (an RTX 5090 doing 80,000 words in 15 minutes)
//      and scaled down by memory bandwidth from there; unknown hardware falls
//      to the bottom, never the top. Being wrong downward costs a user a
//      pleasant surprise, being wrong upward costs them an evening.
//   2. A correction from measured throughput. Real figures beat any table,
//      so once a job has finished here its rate overrides the guess.
//
// Everything in this module is pure — hardware and throughput come in as plain
// data so the whole decision table is testable without a GPU. Detection lives
// in hardware.ts; persistence lives in db.ts.

import {
  MODEL_CATALOG,
  getLocalEntry,
  type ModelCatalogEntry,
} from "./modelCatalog.js";

/**
 * The bundled local tier. "normal" (the 9B) is deprecated and no longer
 * recommended, but a throughput profile measured for it before that still
 * parses, so the type keeps both.
 */
export const LOCAL_TIERS = ["small", "normal"] as const;
export type LocalTier = (typeof LOCAL_TIERS)[number];

export interface HardwareInfo {
  totalRamGb: number;
  freeRamGb: number;
  platform: string;
  arch: string;
  appleSilicon: boolean;
  cpuCount: number;
  gpu: { vendor: string; vramGb: number | null; name: string | null };
}

/** Rolling decode-throughput profile for one model file. */
export interface ThroughputProfile {
  /** Median decode tok/s over the retained samples. */
  medianTps: number;
  /** How many samples the median is drawn from. */
  samples: number;
  /** Observed words/second at the job level (accounts for parallel slots). */
  wordsPerSec?: number;
}

// ── Tuning constants ─────────────────────────────────────────────────────
// Below FLOOR_TPS a run stops feeling like software and starts feeling like
// waiting. 8 tok/s is roughly "a correction every few seconds" — slow but
// tolerable; below it is where users give up.
export const FLOOR_TPS = 8;
/** Medians from fewer samples than this are noise (first chunk pays warm-up). */
export const MIN_SAMPLES = 3;
/** Rolling window of retained samples per model. */
export const PERF_WINDOW = 10;

/**
 * The manuscript every expectation is phrased against. A novel, because that
 * is what people bring; 90,000 because it is the middle of the range and the
 * number rounds cleanly at every speed in the table.
 */
export const REFERENCE_WORDS = 90_000;

// ── Apple Silicon variants ───────────────────────────────────────────────
// Memory bandwidth differs ~3× between an M4 (120 GB/s) and an M4 Max
// (546 GB/s) at identical RAM, so unified memory alone cannot decide this.

export type AppleVariant = "base" | "pro" | "max" | "ultra";

/** Parse "Apple M4 Max" → "max". Returns "base" for a plain M-series chip. */
export function appleChipVariant(name: string | null): AppleVariant | null {
  if (!name) return null;
  if (!/\bApple\s+M\d/i.test(name)) return null;
  if (/\bUltra\b/i.test(name)) return "ultra";
  if (/\bMax\b/i.test(name)) return "max";
  if (/\bPro\b/i.test(name)) return "pro";
  return "base";
}

// ── Layer 1: expected speed from hardware class ─────────────────────────

/**
 * Manuscript words per second of wall clock — the whole pipeline, parallel
 * slots included — that Local Betty should manage on this hardware before
 * anything has been measured.
 *
 * Decode on a 4B Q4 model is memory-bandwidth-bound, so the table is a
 * bandwidth ladder with one measured rung: an RTX 5090 (1.8 TB/s) did 80,000
 * words in 15 minutes, call it 80/s with headroom. Everything below scales by
 * bandwidth and then rounds DOWN, because an estimate that reads "20 minutes"
 * and takes 30 feels broken while the reverse feels fine.
 *
 * Deliberately conservative on anything it cannot positively identify as
 * fast — AMD, Intel, an NVIDIA card whose VRAM would not read — which all
 * land on the CPU figure.
 */
export function expectedWordsPerSec(hw: HardwareInfo): number {
  if (hw.appleSilicon) {
    switch (appleChipVariant(hw.gpu.name)) {
      case "ultra":
        return 40; // ~800 GB/s
      case "max":
        return 30; // ~400–550 GB/s
      case "pro":
        return 15; // ~200–270 GB/s
      default:
        return 8; // ~100–120 GB/s, and the unnamed case
    }
  }

  if (hw.gpu.vendor === "nvidia" && hw.gpu.vramGb != null) {
    // VRAM is a proxy for card class, and the only figure nvidia-smi gives
    // us for free. Bands sit at the generation boundaries: 32 GB is a 5090,
    // 24 GB a 3090/4090, 16 GB a 4080-class card, 12 GB a 4070, 8 GB a 4060.
    const vram = hw.gpu.vramGb;
    if (vram >= 30) return 80;
    if (vram >= 22) return 50;
    if (vram >= 15) return 35;
    if (vram >= 11) return 25;
    if (vram >= 7) return 15;
    return 8;
  }

  // No usable accelerator — CPU decode. Runs, and runs overnight.
  return 3;
}

// ── RAM gate ─────────────────────────────────────────────────────────────

/** Minimum RAM this entry needs on this machine (Apple Silicon has its own figure). */
export function minRamFor(entry: ModelCatalogEntry, hw: HardwareInfo): number {
  return hw.appleSilicon ? entry.minRamAppleSiliconGb : entry.minRamGb;
}

/** Effective total RAM, honouring the BETHANIEL_FAKE_RAM_GB dev override. */
export function effectiveRamGb(hw: HardwareInfo): number {
  const fake = process.env.BETHANIEL_FAKE_RAM_GB;
  const parsed = fake ? parseFloat(fake) : NaN;
  return Number.isFinite(parsed) ? parsed : hw.totalRamGb;
}

/**
 * Tiers this machine has the memory to load at all.
 *
 * This is the download gate for advanced mode. Deduplicated: Custom Betty and
 * External Betty share the "custom" tier and both have minRam 0, which is what
 * made the old `reverse()[0]` derivation always answer "custom". Deprecated
 * entries never count — a tier nobody can download is not "allowed".
 */
export function getAllowedTiers(hw: HardwareInfo): string[] {
  const totalRamGb = effectiveRamGb(hw);
  const tiers = new Set<string>();
  for (const entry of MODEL_CATALOG) {
    if (entry.deprecated) continue;
    if (totalRamGb >= minRamFor(entry, hw)) tiers.add(entry.tier);
  }
  return [...tiers];
}

// ── Layer 2: correct with measured throughput ────────────────────────────

export type AdviceKind = "downgrade" | "slow";

export interface Advice {
  kind: AdviceKind;
  /** Tier the user is currently running (the one that measured slow). */
  from: LocalTier;
  /** Tier we suggest instead. Equal to `from` for the "slow" variant. */
  to: LocalTier;
  /** The measured median that triggered this. */
  medianTps: number;
  /** Observed words/second, when a completed job supplied one. */
  wordsPerSec?: number;
}

export interface Recommendation {
  tier: LocalTier;
  entry: ModelCatalogEntry;
  /** "measured" once real throughput informed the answer. */
  basis: "estimated" | "measured";
  /** Set when the local model has measured too slow to be pleasant here. */
  advice: Advice | null;
  /**
   * Words per second of wall clock to expect — measured when a job has
   * finished here, the hardware table's figure until then.
   */
  wordsPerSec: number;
}

/** A profile only counts once it has enough samples to not be warm-up noise. */
export function isTrusted(profile: ThroughputProfile | undefined): boolean {
  return profile != null && profile.samples >= MIN_SAMPLES;
}

/**
 * The local model, and what to expect from it here.
 *
 * `profiles` maps a local tier to what has actually been measured for it.
 * Tiers never run are simply absent, which is the common case on first launch.
 * There is no longer a tier walk: the only downloadable model is the small
 * one, so the recommendation is always that, and the interesting output is
 * the speed to expect and whether that is slow enough to say so.
 */
export function recommendModel(
  hw: HardwareInfo,
  profiles: Partial<Record<LocalTier, ThroughputProfile>> = {},
): Recommendation {
  const entry = getLocalEntry();
  const tier = entry.tier as LocalTier;
  const profile = profiles[tier];
  const measured = isTrusted(profile);

  // A measured job rate beats the table, and it is the same unit the estimate
  // needs. A trusted profile without one (recorded before job-level rates
  // existed) still marks the basis measured but keeps the table's speed.
  const wordsPerSec =
    measured && profile!.wordsPerSec && profile!.wordsPerSec > 0
      ? profile!.wordsPerSec
      : expectedWordsPerSec(hw);

  let advice: Advice | null = null;
  if (measured && profile!.medianTps < FLOOR_TPS) {
    // Nothing smaller to fall back to. Say so plainly with a time estimate
    // instead of offering a downgrade that does not exist — and never nudge
    // toward the cloud from here; the UI decides how to phrase that.
    advice = {
      kind: "slow",
      from: tier,
      to: tier,
      medianTps: profile!.medianTps,
      wordsPerSec: profile!.wordsPerSec,
    };
  }

  return {
    tier,
    entry,
    basis: measured ? "measured" : "estimated",
    advice,
    wordsPerSec,
  };
}

// ── Human-readable basis for the recommendation ──────────────────────────
// Returned as a structured hint rather than a sentence: the UI renders it in
// the user's language, and the backend has no locale.

export interface HardwareSummary {
  kind: "apple" | "nvidia" | "cpu";
  /** "Apple M2", "NVIDIA GeForce RTX 4090", or null when unidentifiable. */
  gpuName: string | null;
  appleVariant: AppleVariant | null;
  vramGb: number | null;
  totalRamGb: number;
}

export function summarizeHardware(hw: HardwareInfo): HardwareSummary {
  return {
    kind: hw.appleSilicon ? "apple" : hw.gpu.vendor === "nvidia" ? "nvidia" : "cpu",
    gpuName: hw.gpu.name,
    appleVariant: hw.appleSilicon ? appleChipVariant(hw.gpu.name) : null,
    vramGb: hw.gpu.vramGb,
    totalRamGb: Number(effectiveRamGb(hw).toFixed(1)),
  };
}

// ── Sample bookkeeping ───────────────────────────────────────────────────

/** Median of a sample list. Returns 0 for an empty list. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Append a sample and keep only the most recent PERF_WINDOW entries. */
export function pushSample(samples: number[], value: number): number[] {
  return [...samples, value].slice(-PERF_WINDOW);
}
