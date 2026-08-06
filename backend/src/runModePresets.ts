/**
 * Run-mode presets — Speed / Balanced / Max.
 *
 * A run mode is a named bundle of the existing per-run pipeline knobs
 * (editor count, reviewer count, style agent, thorough pass). It changes
 * NOTHING in the pipeline itself — it only picks values that `runCorrectionPass`
 * already reads. Deterministic checks (spell/retext/grammar/dialect) stay ON in
 * every preset because they are cheap, local, and catch most mechanical errors.
 *
 *   Speed    — local default. 1 editor + style agent + 1 reviewer. No 2nd pass.
 *   Balanced — 2 editors + style agent + 1 reviewer. No 2nd pass.
 *   Max      — External Betty default. 3 editors + style agent + 2 reviewers +
 *              thorough 2nd pass.
 *
 * The frontend store carries the canonical copy of this table and resolves a
 * preset into concrete knobs before every /queue/add. This module exists so
 * headless/CLI/benchmark callers can pass `runMode` directly and get the same
 * knobs server-side. Keep the two tables in sync (the repo already duplicates
 * defaults store-vs-routes, so this matches house style).
 */

export type RunMode = "speed" | "balanced" | "max" | "custom";

/** The pipeline knobs a preset controls. Deterministic checks are always on. */
export interface RunModeKnobs {
  reviewMode: boolean;
  reviewerCount: number;
  reviewerThreshold: number;
  spellCheck: boolean;
  retextCheck: boolean;
  grammarCheck: boolean;
  dualEditor: boolean;
  dualCount: number;
  styleComplianceAgent: boolean;
  extraPass: boolean;
}

export const RUN_MODE_PRESETS: Record<
  Exclude<RunMode, "custom">,
  RunModeKnobs
> = {
  speed: {
    reviewMode: true,
    reviewerCount: 1,
    reviewerThreshold: 3,
    spellCheck: true,
    retextCheck: true,
    grammarCheck: true,
    dualEditor: false,
    dualCount: 2,
    styleComplianceAgent: true,
    extraPass: false,
  },
  balanced: {
    reviewMode: true,
    reviewerCount: 1,
    reviewerThreshold: 3,
    spellCheck: true,
    retextCheck: true,
    grammarCheck: true,
    dualEditor: true,
    dualCount: 2,
    styleComplianceAgent: true,
    extraPass: false,
  },
  max: {
    reviewMode: true,
    reviewerCount: 2,
    reviewerThreshold: 3,
    spellCheck: true,
    retextCheck: true,
    grammarCheck: true,
    dualEditor: true,
    dualCount: 3,
    styleComplianceAgent: true,
    extraPass: true,
  },
};

/**
 * Resolve a run mode to its knob set. Returns `null` for `custom` / undefined /
 * unrecognized modes so callers fall through to their own explicit values and
 * hardcoded defaults.
 */
export function resolveRunMode(
  mode: RunMode | string | undefined,
): RunModeKnobs | null {
  if (mode === "speed" || mode === "balanced" || mode === "max") {
    return RUN_MODE_PRESETS[mode];
  }
  return null;
}
