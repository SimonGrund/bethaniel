// ── Turning model/hardware facts into sentences ──
//
// The backend deliberately returns structured facts rather than prose: it has
// no locale. This module is where those facts become something a novelist can
// read, in whichever of the four languages they picked.

import type { ModelRecommendation, PerfAdvice } from "./types";

type Translate = (key: string) => string;

/** "2.8 GB" / "640 MB" / "12 KB" / "218 B". */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${mb.toFixed(0)} MB`;
  // Storage & data lists config sidecars and API-key files, which are bytes —
  // without these branches they all rendered as a confusing "0 MB".
  const kb = bytes / 1024;
  if (kb >= 1) return `${kb.toFixed(0)} KB`;
  return `${bytes} B`;
}

/** "1 hour 20 minutes" / "45 minutes", from a duration in seconds. */
export function formatDuration(seconds: number, t: Translate): string {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} ${t("unit_minutes")}`;
  const hours = Math.round(mins / 60);
  return `${hours} ${hours === 1 ? t("unit_hour") : t("unit_hours")}`;
}

/** How this machine is described in the recommendation sentence. */
function machinePhrase(rec: ModelRecommendation, t: Translate): string {
  const { hardware } = rec;
  switch (hardware.kind) {
    case "apple":
      // "an Apple M4 Max with 64 GB" — the chip name is the honest identifier,
      // since bandwidth varies ~3× across variants at the same memory size.
      return `${hardware.gpuName ?? t("hw_apple_silicon")} · ${hardware.totalRamGb} GB`;
    case "nvidia":
      return hardware.vramGb != null
        ? `${hardware.gpuName ?? t("hw_nvidia")} · ${Math.round(hardware.vramGb)} GB ${t("hw_vram")}`
        : (hardware.gpuName ?? t("hw_nvidia"));
    default:
      return `${t("hw_cpu_only")} · ${hardware.totalRamGb} GB`;
  }
}

/**
 * The manuscript every expectation is phrased against — a 90,000-word novel.
 * Mirrors REFERENCE_WORDS in the backend's modelRecommendation.ts.
 */
export const REFERENCE_WORDS = 90_000;

/** Above this, a local run is an overnight job rather than a coffee break. */
const SLOW_SECONDS = 2 * 3600;

export type LocalVerdict = "fast" | "ok" | "slow";

/**
 * Is running locally on this machine a wait worth having?
 *
 * "fast" is a novel inside half an hour, "ok" inside two hours, "slow" is
 * anything longer — which still works, overnight, but is where the cloud
 * earns its mention.
 */
export function localVerdict(rec: ModelRecommendation): LocalVerdict {
  const seconds = REFERENCE_WORDS / rec.wordsPerSec;
  if (seconds <= 30 * 60) return "fast";
  if (seconds <= SLOW_SECONDS) return "ok";
  return "slow";
}

/**
 * The sentence under "Betty needs a brain": what this machine is, and how
 * long a novel should take on it.
 *
 * There is one local model now, so the question is no longer which Betty fits
 * but whether local is worth the wait here. When the figure is measured rather
 * than read off the hardware table, say so — it is a stronger claim and the
 * user has earned the more confident wording.
 */
export function hardwareReason(rec: ModelRecommendation, t: Translate): string {
  const duration = formatDuration(REFERENCE_WORDS / rec.wordsPerSec, t);
  const key =
    rec.basis === "measured"
      ? "local_expect_measured"
      : localVerdict(rec) === "slow"
        ? "local_expect_slow"
        : "local_expect_estimated";
  return t(key)
    .replace("{machine}", machinePhrase(rec, t))
    .replace("{name}", rec.name)
    .replace("{duration}", duration);
}

/**
 * How fast Betty is going, in the unit a novelist thinks in.
 *
 * `medianTps` is *tokens* per second — roughly 4/3 of the word rate, so
 * printing it as "words a second" overstates by a third or more. When a
 * completed job has given us a real words/second figure we use that; otherwise
 * we return null and the caller drops the number rather than quoting a
 * misleading one.
 */
export function formatWordRate(
  advice: PerfAdvice,
  t: Translate,
): string | null {
  if (!advice.wordsPerSec || advice.wordsPerSec <= 0) return null;
  const wps = advice.wordsPerSec;
  if (wps >= 1) return `${wps.toFixed(1)} ${t("unit_words_per_second")}`;
  // Below one a second, "N words a minute" is easier to picture.
  return `${Math.max(1, Math.round(wps * 60))} ${t("unit_words_per_minute")}`;
}

/**
 * Estimated wall-clock for a manuscript at the measured rate.
 *
 * Built from observed words/second across a completed job, which already
 * accounts for parallel slots and review passes — not from a token model.
 * Returns null when there is nothing measured to base it on.
 */
export function estimateRuntime(
  advice: PerfAdvice,
  words: number,
  t: Translate,
): string | null {
  if (!advice.wordsPerSec || advice.wordsPerSec <= 0 || words <= 0) return null;
  return formatDuration(words / advice.wordsPerSec, t);
}
