// ── Which Betty should this machine run? ──
//
// The old answer was "the biggest one that fits in RAM". That is wrong twice
// over: RAM tells you a model *loads*, not that it is *usable*, and the tier
// list it derived from always ended in "custom" so the badge landed on the
// cloud card. A 32 GB CPU-only laptop was being pointed at a 24B model that
// decodes at ~2 tok/s.
//
// The answer here has two layers:
//
//   1. A pessimistic guess from GPU class. Unknown hardware falls to the
//      bottom, never the top — being wrong downward costs a user some quality,
//      being wrong upward costs them an unusable app.
//   2. A correction from measured decode throughput. Real tok/s beats any
//      table, so once we have enough samples we let them override the guess.
//
// Everything in this module is pure — hardware and throughput come in as plain
// data so the whole decision table is testable without a GPU. Detection lives
// in routes.ts; persistence lives in db.ts.

import { MODEL_CATALOG, type ModelCatalogEntry } from "./modelCatalog.js";

/** The three bundled local tiers, smallest first. Custom/API are never recommended. */
export const LOCAL_TIERS = ["small", "normal", "big"] as const;
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
// tolerable; the tiers below it are where users give up.
export const FLOOR_TPS = 8;
/** Medians from fewer samples than this are noise (first chunk pays warm-up). */
export const MIN_SAMPLES = 3;
/** Rolling window of retained samples per model. */
export const PERF_WINDOW = 10;

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

// ── Layer 1: guess from GPU class ────────────────────────────────────────

/**
 * The tier this machine's GPU can drive at a usable speed, ignoring RAM.
 *
 * Deliberately conservative. Anything we cannot positively identify as fast —
 * CPU-only, AMD, Intel, an NVIDIA card we couldn't read VRAM from — lands on
 * the smallest model.
 */
export function guessTierFromHardware(hw: HardwareInfo): LocalTier {
  if (hw.appleSilicon) {
    const variant = appleChipVariant(hw.gpu.name);
    // Unified memory doubles as VRAM, but only the wide-bus Max/Ultra parts
    // have the bandwidth to decode a 24B model at a tolerable rate. Read the
    // effective figure so BETHANIEL_FAKE_RAM_GB reaches the guess too, not
    // only the clamp below — otherwise the Apple branches are untestable.
    const unifiedGb = effectiveRamGb(hw);
    if ((variant === "max" || variant === "ultra") && unifiedGb >= 48) {
      return "big";
    }
    if (unifiedGb >= 24) return "normal";
    return "small";
  }

  if (hw.gpu.vendor === "nvidia" && hw.gpu.vramGb != null) {
    // 24 GB is the 4090/5090/pro-card line: the 14.3 GB weights plus KV cache
    // fit entirely in VRAM with headroom for several parallel slots.
    if (hw.gpu.vramGb >= 24) return "big";
    // 12 GB holds the 9B comfortably; below that it spills to system RAM.
    if (hw.gpu.vramGb >= 12) return "normal";
    return "small";
  }

  // No usable accelerator — CPU decode. Baby Betty is the only honest answer.
  return "small";
}

// effectiveRamGb is declared below; hoisting is fine for function declarations.

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
 * This is the download gate for advanced mode, deliberately looser than the
 * recommendation — a user who knows what they're doing may still want the big
 * model. Deduplicated: Custom Betty and External Betty share the "custom" tier
 * and both have minRam 0, which is what made the old `reverse()[0]` derivation
 * always answer "custom".
 */
export function getAllowedTiers(hw: HardwareInfo): string[] {
  const totalRamGb = effectiveRamGb(hw);
  const tiers = new Set<string>();
  for (const entry of MODEL_CATALOG) {
    if (totalRamGb >= minRamFor(entry, hw)) tiers.add(entry.tier);
  }
  return [...tiers];
}

/** Step `tier` down until the machine has the RAM to load it. */
function clampToRam(tier: LocalTier, hw: HardwareInfo): LocalTier {
  const totalRamGb = effectiveRamGb(hw);
  for (let i = LOCAL_TIERS.indexOf(tier); i >= 0; i--) {
    const candidate = LOCAL_TIERS[i];
    const entry = MODEL_CATALOG.find((e) => e.tier === candidate);
    if (entry && totalRamGb >= minRamFor(entry, hw)) return candidate;
  }
  // Under 8 GB nothing officially fits. Recommend the smallest anyway — it is
  // the only thing with a chance, and refusing to name a model leaves the
  // first-run popup with nothing to offer.
  return "small";
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
  /** Set when measurement moved us off the guess, or when even Baby Betty is slow. */
  advice: Advice | null;
}

/** A profile only counts once it has enough samples to not be warm-up noise. */
export function isTrusted(profile: ThroughputProfile | undefined): boolean {
  return profile != null && profile.samples >= MIN_SAMPLES;
}

/**
 * Pick the model to recommend.
 *
 * `profiles` maps a local tier to what we have actually measured for it. Tiers
 * we have never run are simply absent, which is the common case on first launch.
 */
export function recommendModel(
  hw: HardwareInfo,
  profiles: Partial<Record<LocalTier, ThroughputProfile>> = {},
): Recommendation {
  const guessed = clampToRam(guessTierFromHardware(hw), hw);

  let tier = guessed;
  let basis: "estimated" | "measured" = "estimated";

  // Walk down while the tier we would recommend has measured below the floor.
  // Each step is only taken on trusted evidence, so an untested smaller model
  // ends the walk rather than being skipped over.
  while (tier !== "small") {
    const profile = profiles[tier];
    if (!isTrusted(profile) || profile!.medianTps >= FLOOR_TPS) break;
    basis = "measured";
    tier = LOCAL_TIERS[LOCAL_TIERS.indexOf(tier) - 1];
  }

  const entry = MODEL_CATALOG.find((e) => e.tier === tier)!;

  let advice: Advice | null = null;
  if (tier !== guessed) {
    const measured = profiles[guessed]!;
    advice = {
      kind: "downgrade",
      from: guessed,
      to: tier,
      medianTps: measured.medianTps,
      wordsPerSec: measured.wordsPerSec,
    };
  } else {
    // No smaller model to fall back to. If the smallest is itself below the
    // floor, say so plainly with a time estimate instead of offering a
    // downgrade that does not exist — and never nudge toward the cloud.
    const profile = profiles[tier];
    if (tier === "small" && isTrusted(profile) && profile!.medianTps < FLOOR_TPS) {
      basis = "measured";
      advice = {
        kind: "slow",
        from: tier,
        to: tier,
        medianTps: profile!.medianTps,
        wordsPerSec: profile!.wordsPerSec,
      };
    } else if (isTrusted(profile)) {
      basis = "measured";
    }
  }

  return { tier, entry, basis, advice };
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
