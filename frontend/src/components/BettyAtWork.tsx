// ── BettyAtWork — what the app shows while a run is going ──
//
// This replaces a header that carried, in one strip: a title, a mode chip, a
// Stop button, a percentage, a progress bar, chapters-done, elapsed time, the
// model name, tokens per second, a stream count and an ETA. Eleven facts, most
// of which answer a question nobody asks while waiting — and the Stop button
// and the bar are both in the rail now, so two of them were saying it twice.
//
// Waiting needs three things: that it is working, roughly how far along, and
// roughly how long. Everything else is in the engine log for anyone who wants
// it. The animation carries the first, which is the one a still page is worst
// at telling you.

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { progressPercent, weightedProgress } from "../runProgress";
import type { Lang, TaskState } from "../types";

const META_MODES = new Set(["analysis_summary", "blurb", "text_evaluator"]);

function formatLeft(seconds: number, t: (k: string, f?: string) => string): string {
  if (seconds < 90) return t("eta_under_minute", "under a minute");
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `~${minutes} ${t("eta_minutes", "minutes")}`;
  const hours = Math.round((seconds / 3600) * 2) / 2;
  return `~${hours} ${t("eta_hours", "hours")}`;
}

export default function BettyAtWork({
  jobId,
  jobTasks,
  lang,
}: {
  jobId: string;
  jobTasks: TaskState[];
  lang: Lang;
}) {
  const t = useTranslation(lang);
  const runStats = useStore((s) => s.runStats);

  const chapters = jobTasks.filter((task) => !META_MODES.has(task.mode));
  const tasks = chapters.length > 0 ? chapters : jobTasks;
  const done = tasks.filter((task) => task.status === "done").length;

  // The backend's own figure while the job is live, so this and the engine log
  // cannot disagree. The fallback covers the moment before the first stats
  // frame arrives and computes the same thing the same way — it used to be a
  // share of the chapter COUNT, which is how a one-chapter job managed to read
  // 100% over "0 of 1 chapters done".
  const live = runStats?.jobProgress?.[jobId];
  const pct = progressPercent(live?.fraction ?? weightedProgress(tasks));
  const secondsLeft = runStats?.runtime?.estimatedSecondsRemaining ?? null;

  const source = jobTasks[0]?.source;
  const working = tasks.find((task) => task.status === "editing");

  return (
    <section className="at-work" aria-live="polite">
      {/* The quill writes, the page turns under it. Decorative: every fact it
          conveys is also in the text below. */}
      <div className="at-work__scene" aria-hidden="true">
        <span className="at-work__page" />
        <img src="/logo-icon.svg" alt="" className="at-work__mark" />
        <span className="at-work__ink" />
      </div>

      <h2 className="at-work__title">
        {t("betty_at_work", "Betty is reading")}
        <span className="at-work__dots">
          <i />
          <i />
          <i />
        </span>
      </h2>

      {source && <p className="at-work__source">{source}</p>}

      <p className="at-work__status">
        {tasks.length > 1
          ? t("chapters_done")
              .replace("{n}", String(done))
              .replace("{m}", String(tasks.length))
          : working
            ? working.name
            : t("current_run")}
        {secondsLeft != null && secondsLeft > 0 && (
          <>
            {" · "}
            {formatLeft(secondsLeft, t)}
          </>
        )}
      </p>

      {/* The number is the run's share of its estimated TOKEN cost, not its
          chapter count, so it climbs steadily through a long chapter instead
          of standing still and then jumping. */}
      <div className="at-work__meter">
        <div
          className="at-work__bar"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="at-work__fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="at-work__pct">{pct}%</span>
      </div>
    </section>
  );
}
