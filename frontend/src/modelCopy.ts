// ── Turning model/hardware facts into sentences ──
//
// The backend deliberately returns structured facts rather than prose: it has
// no locale. This module is where those facts become something a novelist can
// read, in whichever of the four languages they picked.

import type { ModelRecommendation, PerfAdvice } from "./types";

type Translate = (key: string) => string;

/** "2.8 GB" / "640 MB". */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
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
 * The sentence under "Betty needs a brain".
 *
 * Says what we found and which Betty follows from it. When the pick came from
 * measured throughput rather than the hardware table, say so — it is a stronger
 * claim and the user has earned the more confident wording.
 */
export function hardwareReason(rec: ModelRecommendation, t: Translate): string {
  const key =
    rec.basis === "measured"
      ? "model_reason_measured"
      : `model_reason_${rec.hardware.kind}`;
  return t(key)
    .replace("{machine}", machinePhrase(rec, t))
    .replace("{name}", rec.name);
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
