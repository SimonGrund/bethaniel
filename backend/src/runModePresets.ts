/**
 * Run-mode presets.
 *
 * A run mode is a named bundle of the existing per-run pipeline knobs
 * (editor count, reviewer count, style agent, thorough pass). It changes
 * NOTHING in the pipeline itself — it only picks values that `runCorrectionPass`
 * already reads. Deterministic checks (spell/retext/grammar/dialect) stay ON in
 * every preset because they are cheap, local, and catch most mechanical errors.
 *
 *   Speed — the only preset. 1 editor + style agent + 1 reviewer. No 2nd pass.
 *   Applies uniformly, including to External Betty (API models).
 *
 * A "Balanced" middle preset and a "Max" heavy preset (3 editors + 2 reviewers
 * + thorough 2nd pass) were both benchmarked and dropped. Max held up on a
 * strong API model (+48% applied corrections on a full novel via External
 * Betty) but bought nothing on either bundled local model — Baby Betty and Big
 * Bad Betty scored statistically identical recall/precision on both copy_edit
 * and line_edit at 2-3x the wall-clock, with zero change in hallucinated false
 * positives on clean text. Rather than keep a heavy preset that only pays off
 * for one model source, it was removed everywhere — including External Betty —
 * in favor of one predictable pipeline. See docs/run-modes.md for both sets of
 * evidence and the removal rationale.
 *
 * The frontend store carries the canonical copy of this table and resolves a
 * preset into concrete knobs before every /queue/add. This module exists so
 * headless/CLI/benchmark callers can pass `runMode` directly and get the same
 * knobs server-side. Keep the two tables in sync (the repo already duplicates
 * defaults store-vs-routes, so this matches house style).
 */

export type RunMode = "speed" | "custom";

/** The pipeline knobs a preset controls. Deterministic checks are always on. */
export interface RunModeKnobs {
  reviewMode: boolean;
  reviewerThreshold: number;
  spellCheck: boolean;
  retextCheck: boolean;
  grammarCheck: boolean;
  styleComplianceAgent: boolean;
  extraPass: boolean;
}

/**
 * What a job runs when nobody says otherwise.
 *
 * This is the single source of truth for the pipeline's shape. routes.ts
 * resolves every knob as `forced ?? explicit ?? preset ?? DEFAULT_RUN_KNOBS`,
 * so a knob's default lives here and nowhere else.
 *
 * It used to live here AND as hardcoded literals at the end of that chain,
 * which let the two drift: a cloud job is forced to the speed preset, and
 * `dualEditor` was false there and true in the literals, so cloud and local
 * ran different pipelines while every benchmark on the site compared them as
 * though they did not.
 */
export const DEFAULT_RUN_KNOBS: RunModeKnobs = {
  reviewMode: true,
  reviewerThreshold: 3,
  spellCheck: true,
  retextCheck: true,
  grammarCheck: true,
  styleComplianceAgent: true,
  extraPass: false,
};

export const RUN_MODE_PRESETS: Record<
  Exclude<RunMode, "custom">,
  RunModeKnobs
> = {
  speed: {
    reviewMode: true,
    reviewerThreshold: 3,
    spellCheck: true,
    retextCheck: true,
    grammarCheck: true,
    styleComplianceAgent: true,
    extraPass: false,
  },
};

/**
 * Resolve a run mode to its knob set. Returns `null` for `custom` / undefined /
 * unrecognized modes (including a stale persisted "max"/"balanced") so callers
 * fall through to their own explicit values and hardcoded defaults.
 */
export function resolveRunMode(
  mode: RunMode | string | undefined,
): RunModeKnobs | null {
  if (mode === "speed") {
    return RUN_MODE_PRESETS.speed;
  }
  return null;
}

/**
 * Whether a task runs the reviewer, given what the job's knobs resolved to.
 *
 * A publication scan's proofread pass overrides them and is always reviewed.
 * The scan's whole output is a list of defects it asserts are worth fixing
 * before publishing, and a correction only earns that assertion when a
 * reviewer confirms it — everything else the panel counts rather than lists.
 * With review off there are no confirmations at all, so the verdict collapses
 * to structural findings plus a number, which is not the readiness answer the
 * user asked for.
 *
 * Forcing the pass rather than refusing the job is the cheaper half of the
 * same bargain the grammar rule makes in routes.ts: the reviewer needs no
 * download, only tokens. It costs nothing in the cloud, whose speed preset
 * already pins reviewMode on.
 */
export function reviewModeForTask(
  mode: string,
  jobModes: readonly string[],
  resolved: boolean,
): boolean {
  if (mode === "proofread" && jobModes.includes("publication_scan")) return true;
  return resolved;
}
