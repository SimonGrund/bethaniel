// ── Cloud job token/cost estimator ──
//
// Estimates how many tokens a job will burn BEFORE it runs, so "Betty in the
// Cloud" can quote a price up front. Built on the same `estimateTokens`
// chars/token heuristic the engine already uses for post-hoc context-window
// telemetry (see llm.ts) — this module is the first place that heuristic gets
// summed across a whole job instead of a single call.
//
// Deliberately approximate: actual output size depends on how many issues
// Betty finds, which is unknowable ahead of time. `confidence` tells the
// caller (and the UI) how much to trust the number — "estimate" for the
// corrections modes (a fixed function of chunk count), "lower_bound" for
// translate/analysis modes where a real run can do meaningfully more work
// than this formula assumes.

import { estimateTokens } from "./llm.js";
import { MODEL_CATALOG } from "./modelCatalog.js";
import { RUN_MODE_PRESETS, type RunModeKnobs } from "./runModePresets.js";
import {
  buildCopyEditCorrectionsPrompt,
  buildLineEditCorrectionsPrompt,
  buildCombinedEditPrompt,
  buildReviewerPrompt,
  buildTranslationPrompt,
  buildTranslationReviewerPrompt,
  buildTranslationUpgradePrompt,
  buildFluencyReviewerPrompt,
} from "./prompts.js";
import { DEFAULT_COPY_EDIT_OPTIONS, DEFAULT_LINE_EDIT_OPTIONS } from "./types.js";

/** Average characters per word (including the trailing space) in English
 *  prose — used to turn a word count into a character count for
 *  `estimateTokens`. Not exact, but consistent with the chars/token
 *  approximation already used elsewhere for this purpose. */
const CHARS_PER_WORD = 6;

/** Assumed output size as a fraction of a call's `num_predict` cap. Using the
 *  raw cap would wildly overestimate cost — real output is bounded by how
 *  many issues exist in the text, not by the ceiling the model is allowed to
 *  fill. Tune this once real cloud-job usage data exists. */
const ASSUMED_OUTPUT_FRACTION = 0.35;

/** Reviewer calls re-embed the chunk text plus the editor's JSON corrections
 *  list on top of their own system prompt. We don't know the real correction
 *  count ahead of time, so a fixed per-chunk token allowance stands in for
 *  the corrections-list payload. */
const ASSUMED_CORRECTIONS_PAYLOAD_TOKENS = 300;

/** Translate mode's re-translate/re-polish passes are reviewer-verdict
 *  driven (one extra call per flagged paragraph) — this is a rough share of
 *  chunks assumed to need a redo, not a measured rate. */
const ASSUMED_RETRANSLATE_RATE = 0.15;

function wordsToTokens(words: number): number {
  return estimateTokens("x".repeat(Math.max(0, Math.round(words * CHARS_PER_WORD))));
}

/** The mode strings the frontend's mode picker actually sends — mirrors
 *  TaskMode (types.ts) minus the modes this estimator doesn't model yet
 *  (developmental_edit, proofread, publication_scan, text_evaluator), which
 *  fall through to the copy-edit-shaped formula as a reasonable stand-in
 *  rather than being silently mis-costed as something else. */
export type CloudEstimateMode = string;

const ANALYSIS_MODE_NAMES = new Set([
  "character_catalog",
  "location_catalog",
  "timeline",
  "combined_analysis",
]);

/** Mirrors routes.ts's /queue/add merge logic: copy_edit + line_edit collapse
 *  into one combined_edit task, and ANY selection of analysis modes collapses
 *  into a single combined_analysis task — never one task per checkbox. An
 *  estimate that didn't mirror this would double- or triple-count work the
 *  real job never does. */
function toEffectiveModes(modes: CloudEstimateMode[]): CloudEstimateMode[] {
  const hasCopy = modes.includes("copy_edit");
  const hasLine = modes.includes("line_edit");
  const mergeEdits = hasCopy && hasLine;
  const hasAnalysis = modes.some((m) => ANALYSIS_MODE_NAMES.has(m));

  const other = modes.filter(
    (m) =>
      !ANALYSIS_MODE_NAMES.has(m) &&
      !(mergeEdits && (m === "copy_edit" || m === "line_edit")),
  );
  return [
    ...other,
    ...(mergeEdits ? ["combined_edit"] : []),
    ...(hasAnalysis ? ["combined_analysis"] : []),
  ];
}

export interface CloudEstimateInput {
  /** Word count per selected unit (chapter, or scope slice). */
  units: { wordCount: number }[];
  modes: CloudEstimateMode[];
  wordsPerChunk: number;
  runMode: "speed" | "custom";
  reviewMode: boolean;
  reviewerCount: number;
  dualEditor: boolean;
  dualCount: number;
  styleComplianceAgent: boolean;
  extraPass: boolean;
  /** Model's configured output cap — drives the assumed-output-fraction math. */
  numPredict: number;
  styleGuideChars?: number;
  manuscriptLang?: string;
}

export interface CloudEstimateResult {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  confidence: "estimate" | "lower_bound";
  perMode: Record<string, { inputTokens: number; outputTokens: number }>;
}

/** Editor calls per chunk for the corrections modes, mirroring runModePresets.ts. */
function editorCallsPerChunk(input: CloudEstimateInput): number {
  const base = input.dualEditor ? Math.max(1, input.dualCount) : 1;
  return base + (input.styleComplianceAgent ? 1 : 0);
}

function reviewerCallsPerChunk(input: CloudEstimateInput): number {
  return input.reviewMode ? Math.max(0, input.reviewerCount) : 0;
}

function correctionsModeSystemPromptTokens(
  mode: "copy_edit" | "line_edit" | "combined_edit",
  input: CloudEstimateInput,
): number {
  const styleGuide = input.styleGuideChars
    ? "x".repeat(input.styleGuideChars)
    : undefined;
  const prompt =
    mode === "copy_edit"
      ? buildCopyEditCorrectionsPrompt(
          DEFAULT_COPY_EDIT_OPTIONS,
          styleGuide,
          undefined,
          input.manuscriptLang,
        )
      : mode === "line_edit"
        ? buildLineEditCorrectionsPrompt(
            DEFAULT_LINE_EDIT_OPTIONS,
            styleGuide,
            undefined,
            input.manuscriptLang,
          )
        : buildCombinedEditPrompt(
            DEFAULT_COPY_EDIT_OPTIONS,
            DEFAULT_LINE_EDIT_OPTIONS,
            styleGuide,
            undefined,
            input.manuscriptLang,
          );
  return estimateTokens(prompt);
}

function estimateCorrectionsMode(
  mode: "copy_edit" | "line_edit" | "combined_edit",
  input: CloudEstimateInput,
): { inputTokens: number; outputTokens: number } {
  const systemTokens = correctionsModeSystemPromptTokens(mode, input);
  const reviewerSystemTokens = input.reviewMode
    ? estimateTokens(buildReviewerPrompt(undefined, mode, input.manuscriptLang))
    : 0;
  const editorCalls = editorCallsPerChunk(input);
  const reviewerCalls = reviewerCallsPerChunk(input);
  const outputTokensPerCall = input.numPredict * ASSUMED_OUTPUT_FRACTION;

  let inputTokens = 0;
  let outputTokens = 0;

  for (const unit of input.units) {
    const numChunks = Math.max(1, Math.ceil(unit.wordCount / input.wordsPerChunk));
    const chunkTokens = wordsToTokens(unit.wordCount / numChunks);

    // Editor agents: system + chunk body in, corrections JSON out.
    inputTokens += numChunks * editorCalls * (systemTokens + chunkTokens);
    outputTokens += numChunks * editorCalls * outputTokensPerCall;

    // Reviewer agents: system + chunk body + the editor's corrections list in,
    // a short verdict out.
    if (reviewerCalls > 0) {
      inputTokens +=
        numChunks *
        reviewerCalls *
        (reviewerSystemTokens + chunkTokens + ASSUMED_CORRECTIONS_PAYLOAD_TOKENS);
      outputTokens += numChunks * reviewerCalls * (outputTokensPerCall * 0.3);
    }
  }

  // extraPass re-runs the whole pass a second time for copy/combined edit.
  if (input.extraPass && mode !== "line_edit") {
    inputTokens *= 2;
    outputTokens *= 2;
  }

  return { inputTokens: Math.ceil(inputTokens), outputTokens: Math.ceil(outputTokens) };
}

function estimateTranslateMode(
  input: CloudEstimateInput,
): { inputTokens: number; outputTokens: number } {
  const draftSystemTokens = estimateTokens(
    buildTranslationPrompt(
      "the target language",
      input.styleGuideChars ? "x".repeat(input.styleGuideChars) : undefined,
    ),
  );
  const reviewerSystemTokens = input.reviewMode
    ? estimateTokens(buildTranslationReviewerPrompt())
    : 0;
  const upgradeSystemTokens = estimateTokens(
    buildTranslationUpgradePrompt("the target language"),
  );
  const fluencySystemTokens = input.reviewMode
    ? estimateTokens(buildFluencyReviewerPrompt("the target language"))
    : 0;
  const reviewerCalls = reviewerCallsPerChunk(input);

  let inputTokens = 0;
  let outputTokens = 0;

  for (const unit of input.units) {
    const numChunks = Math.max(1, Math.ceil(unit.wordCount / input.wordsPerChunk));
    const chunkTokens = wordsToTokens(unit.wordCount / numChunks);
    // Translations run roughly the same length as the source.
    const translatedTokens = chunkTokens;

    // Draft translation.
    inputTokens += numChunks * (draftSystemTokens + chunkTokens);
    outputTokens += numChunks * translatedTokens;

    // Draft review + a share of chunks getting one re-translate call.
    if (reviewerCalls > 0) {
      inputTokens +=
        numChunks * reviewerCalls * (reviewerSystemTokens + chunkTokens + translatedTokens);
      outputTokens += numChunks * reviewerCalls * (translatedTokens * 0.2);
      const retranslateChunks = numChunks * ASSUMED_RETRANSLATE_RATE;
      inputTokens += retranslateChunks * (draftSystemTokens + chunkTokens);
      outputTokens += retranslateChunks * translatedTokens;
    }

    // Upgrade/polish pass over the translated output.
    inputTokens += numChunks * (upgradeSystemTokens + translatedTokens);
    outputTokens += numChunks * translatedTokens;

    if (reviewerCalls > 0) {
      inputTokens +=
        numChunks * reviewerCalls * (fluencySystemTokens + translatedTokens * 2);
      outputTokens += numChunks * reviewerCalls * (translatedTokens * 0.2);
      const repolishChunks = numChunks * ASSUMED_RETRANSLATE_RATE;
      inputTokens += repolishChunks * (upgradeSystemTokens + translatedTokens);
      outputTokens += repolishChunks * translatedTokens;
    }
  }

  return { inputTokens: Math.ceil(inputTokens), outputTokens: Math.ceil(outputTokens) };
}

/** Analysis modes (character/location/timeline) aren't chunked by word count:
 *  one call per chapter, plus part-synthesis and a final synthesis call. Part
 *  boundaries come from the manuscript's own headings, which this estimator
 *  doesn't parse — `chaptersPerPart` is a rough stand-in, not a measurement. */
function estimateAnalysisMode(
  input: CloudEstimateInput,
): { inputTokens: number; outputTokens: number } {
  const chaptersPerPart = 8;
  const numChapters = input.units.length;
  const numParts = Math.max(1, Math.ceil(numChapters / chaptersPerPart));
  const ANALYSIS_OUTPUT_TOKENS_PER_CHAPTER = 600; // small structured JSON extraction
  const PART_SYNTHESIS_TOKENS = 1500;
  const FINAL_SYNTHESIS_TOKENS = 3000;

  let inputTokens = 0;
  let outputTokens = 0;

  for (const unit of input.units) {
    inputTokens += wordsToTokens(unit.wordCount);
    outputTokens += ANALYSIS_OUTPUT_TOKENS_PER_CHAPTER;
  }
  inputTokens += numParts * PART_SYNTHESIS_TOKENS;
  outputTokens += numParts * (PART_SYNTHESIS_TOKENS * 0.3);
  inputTokens += FINAL_SYNTHESIS_TOKENS;
  outputTokens += FINAL_SYNTHESIS_TOKENS * 0.3;

  return { inputTokens: Math.ceil(inputTokens), outputTokens: Math.ceil(outputTokens) };
}

/**
 * Estimated OUTPUT tokens for a single task (one unit, one already-merged
 * mode) — the same per-mode formulas `estimateCloudJob` sums across a whole
 * job, scoped down to one chapter's worth of work. Used to drive the local
 * progress bar: dividing tokens generated so far by this number gives a real
 * fraction instead of the chunk-count/heuristic-curve approximation it
 * replaces. Input tokens are irrelevant here — progress tracks what the
 * engine emits, not what it reads — so only the output half is returned.
 */
export function estimateTaskOutputTokens(
  mode: "copy_edit" | "line_edit" | "combined_edit" | "translate",
  wordCount: number,
  input: Omit<CloudEstimateInput, "units" | "modes">,
): number {
  const scoped: CloudEstimateInput = {
    ...input,
    units: [{ wordCount }],
    modes: [mode],
  };
  const result =
    mode === "translate"
      ? estimateTranslateMode(scoped)
      : estimateCorrectionsMode(mode, scoped);
  return result.outputTokens;
}

export function estimateCloudJob(input: CloudEstimateInput): CloudEstimateResult {
  const perMode: Record<string, { inputTokens: number; outputTokens: number }> = {};
  let confidence: "estimate" | "lower_bound" = "estimate";
  const effectiveModes = toEffectiveModes(input.modes);

  for (const mode of effectiveModes) {
    let result: { inputTokens: number; outputTokens: number };
    if (mode === "copy_edit" || mode === "line_edit" || mode === "combined_edit") {
      result = estimateCorrectionsMode(mode, input);
    } else if (mode === "translate") {
      result = estimateTranslateMode(input);
      confidence = "lower_bound";
    } else if (ANALYSIS_MODE_NAMES.has(mode)) {
      result = estimateAnalysisMode(input);
      confidence = "lower_bound";
    } else {
      // developmental_edit / proofread / publication_scan / text_evaluator —
      // not individually modeled yet. Cost roughly like a copy-edit pass
      // rather than mis-costing it as something else; flag as a lower bound.
      result = estimateCorrectionsMode("copy_edit", input);
      confidence = "lower_bound";
    }
    perMode[mode] = result;
  }

  const estimatedInputTokens = Object.values(perMode).reduce(
    (sum, r) => sum + r.inputTokens,
    0,
  );
  const estimatedOutputTokens = Object.values(perMode).reduce(
    (sum, r) => sum + r.outputTokens,
    0,
  );

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    confidence,
    perMode,
  };
}

/** Betty in the Cloud always runs the Speed preset.
 *
 *  The Max preset was retired because benchmarking showed it did not earn its
 *  cost, but "custom" still exposes 4 editors + a style agent + 4 reviewers +
 *  a second pass. On a cloud job those knobs are not the user's to spend:
 *  they multiply what Bethaniel pays upstream ~6x (a 100k-word manuscript
 *  goes from 1.2M tokens to 7.1M) for output the benchmarks say is no better.
 *
 *  Forced here rather than in the UI because this is the only place both the
 *  price quote and the actual run pass through — a client that sent its own
 *  knobs could otherwise be quoted a Speed price and then run a custom job.
 *  Returns null for every other model, leaving local/BYO-key runs untouched:
 *  there the compute is the user's own to spend however they like. */
export function cloudRunKnobs(model: unknown): RunModeKnobs | null {
  const cloudEntry = MODEL_CATALOG.find((e) => e.id === "bethaniel-cloud");
  return model === cloudEntry?.fileName ? RUN_MODE_PRESETS.speed : null;
}

// ── What Betty in the Cloud is allowed to run ──
//
// Only the modes whose cloud behaviour has actually been tested. Developmental
// editing and the story-analysis family are deliberately excluded: they are
// long-context, whole-book passes whose output quality and token cost have not
// been validated against a cloud model, and selling an untested pass is worse
// than not offering it. Widen this list once each has been benchmarked.
//
// "Final readthrough" is a two-mode selection in the UI (proofread +
// publication_scan), so both are listed; publication_scan is deterministic and
// costs no tokens, but it must not be *rejected* when it arrives alongside a
// proofread.
export const CLOUD_ALLOWED_MODES: readonly string[] = [
  "copy_edit",
  "line_edit",
  "combined_edit",
  "proofread",
  "publication_scan",
  "translate",
];

/** Split a mode selection into what the cloud will run and what it will not.
 *  Returns `rejected` empty when everything is allowed. */
export function partitionCloudModes(modes: readonly string[]): {
  allowed: string[];
  rejected: string[];
} {
  const allowed: string[] = [];
  const rejected: string[] = [];
  for (const m of modes) {
    (CLOUD_ALLOWED_MODES.includes(m) ? allowed : rejected).push(m);
  }
  return { allowed, rejected };
}
