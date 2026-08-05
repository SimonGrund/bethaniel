// ── Developmental-edit orchestrator: manuscript-level critique ──
//
// Runs the sequential story read (storyAnalysis.ts) to build a structured read
// of the whole book — outline, parts, chapter summaries, characters with roles,
// tiered event timeline — then synthesizes ONE narrative Markdown developmental
// report (structure, pacing, arcs, plot/continuity, POV, priority revisions).
//
// It deliberately reuses the story read rather than re-reading: the read's
// checkpoint (StoryAnalysisState) also lets a cancelled/crashed developmental
// run resume mid-read. The LLM caller is injected so tests can drive it with
// scripted responses.

import { DEVELOPMENTAL_REVIEW_PROMPT } from "./prompts.js";
import {
  runStoryAnalysis,
  type StoryAnalysisDeps,
  type StoryAnalysisResult,
  type StoryAnalysisState,
} from "./storyAnalysis.js";
import type { EditUnit } from "./types.js";

export type DevelopmentalEditDeps = StoryAnalysisDeps;

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** The slices of the story read the developmental synthesis actually needs. */
function buildDevelopmentalPayload(
  units: EditUnit[],
  data: StoryAnalysisResult,
): string {
  return JSON.stringify({
    manuscriptStats: {
      totalWords: units.reduce((s, u) => s + countWords(u.original), 0),
      chapters: units.length,
    },
    outline: data.outline,
    characters: data.characters.map((c) => ({
      name: c.name,
      role: c.role,
      chapters: c.chapters,
    })),
    events: data.events,
  });
}

export async function runDevelopmentalEdit(
  units: EditUnit[],
  deps: DevelopmentalEditDeps,
): Promise<{
  report: string;
  structuredData: StoryAnalysisResult;
  state: StoryAnalysisState;
}> {
  // Phase 1 — the sequential story read (progress + checkpoint forwarded as-is;
  // the read already signals a final "synthesis" tick which the queue surfaces
  // as the report-writing phase).
  const { structuredData, state } = await runStoryAnalysis(units, deps);

  if (deps.signal?.aborted) throw new Error("Developmental edit cancelled");

  // Phase 2 — one developmental synthesis pass over the structured read.
  const report = (
    await deps.llm(
      DEVELOPMENTAL_REVIEW_PROMPT,
      buildDevelopmentalPayload(units, structuredData),
      { maxTokens: 3500 },
    )
  ).trim();

  return { report, structuredData, state };
}
