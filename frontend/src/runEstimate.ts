// ── How long this run will take ──
//
// An author committing a 120,000-word manuscript deserves to know whether they
// are waiting ten minutes or two hours, and on a paid run they deserve it
// before they pay. The app already had the sentence — "a 120,000-word book
// takes roughly 10-15 minutes" — collapsed inside an accordion and describing
// somebody else's book. This computes it for theirs.
//
// The measured figure is preferred wherever one exists. `recordJobThroughput`
// has been storing end-to-end words-per-second after every finished job since
// long before anything read it, and that number already accounts for parallel
// slots, warm-up and the reviewer pass — everything a hand-built model of the
// pipeline would have to guess at. The published fallbacks below are only for
// the first run on a given engine.

/** Words per second, end to end, when nothing has been measured yet. */
const FALLBACK_WORDS_PER_SEC: Record<string, number> = {
  // Scaleway, 24 chapters at a time. Set so a 120,000-word book lands inside
  // the 10-15 minutes the cloud disclosure already promises: quoting a
  // different number in two places is worse than either number being wrong.
  cloud: 160,
  // A bundled GGUF on typical consumer hardware at the default 3 slots. Well
  // below the cloud, which is the honest shape of the trade.
  local: 12,
};

export interface RunEstimate {
  /** Seconds, rounded to something worth showing. */
  seconds: number;
  /** True when this came from a real measurement on this machine. */
  measured: boolean;
}

/**
 * `wordsPerSec` is the map from `/api/models/perf`, keyed by model file name.
 * `isCloud` picks the fallback when that model has never finished a job here.
 */
export function estimateRun(
  words: number,
  modelFile: string | null,
  wordsPerSec: Record<string, number>,
  isCloud: boolean,
): RunEstimate | null {
  if (!Number.isFinite(words) || words <= 0) return null;
  const measuredRate = modelFile ? wordsPerSec[modelFile] : undefined;
  const rate =
    measuredRate && measuredRate > 0
      ? measuredRate
      : FALLBACK_WORDS_PER_SEC[isCloud ? "cloud" : "local"];
  if (!rate || rate <= 0) return null;
  return { seconds: words / rate, measured: Boolean(measuredRate) };
}

/**
 * A duration a person would say out loud. Deliberately coarse and rounded up:
 * an estimate that reads "about 12 minutes" and takes 15 feels broken, while
 * "about 15 minutes" that takes 12 feels fine. Under a minute is not worth a
 * number at all.
 */
export function formatEstimate(
  seconds: number,
  t: (key: string, fallback?: string) => string,
): string {
  if (seconds < 60) return t("eta_under_minute", "under a minute");
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 10) return `~${minutes} ${t("eta_minutes", "minutes")}`;
  if (minutes < 60) {
    // To the nearest five: the input is a rate estimate, and a single-minute
    // figure claims a precision it does not have.
    return `~${Math.ceil(minutes / 5) * 5} ${t("eta_minutes", "minutes")}`;
  }
  const hours = seconds / 3600;
  if (hours < 2) {
    const half = Math.round(hours * 2) / 2;
    return `~${half} ${t("eta_hours", "hours")}`;
  }
  return `~${Math.ceil(hours)} ${t("eta_hours", "hours")}`;
}
