// ── Enhanced language analysis: the part a count cannot do ──
//
// The language analysis (languageAnalysis.ts) is arithmetic over the whole
// manuscript — crutch words, adverbs, filter words, rhythm, tags — and runs
// on any machine in under a second. What it cannot see is whether a moment
// is dramatised or merely stated, and that is the note authors ask for most.
// This module adds exactly that, on a paid cloud run: it samples passages
// the way the writing report does, asks for showing-versus-telling notes on
// each (verbatim quote plus a reader's note, never a rewrite), then asks for
// one paragraph of advice that reads those notes together with the counts.
//
// The result merges INTO the existing report on screen rather than becoming
// a second report; see LanguageAnalysisPanel.tsx. The model caller is
// injected so tests can drive it with scripted responses.

import { samplePassages, type SampledPassage } from "./textEvaluator.js";
import { parseJsonResponse } from "./llm.js";
import {
  buildLanguageEnhanceAdvicePrompt,
  buildLanguageEnhancePassagePrompt,
} from "./prompts.js";
import type { LlmCall } from "./storyAnalysis.js";
import type { EditUnit, LanguageAnalysisReport } from "./types.js";

export interface ShowTellNote {
  kind: "told" | "shown";
  chapter: string;
  quote: string;
  note: string;
}

export interface LanguageEnhanceState {
  passages: SampledPassage[];
  notes: ShowTellNote[];
  nextPassageIndex: number;
}

/** What the task stores; the panel reads it beside the counts. */
export interface LanguageEnhanceResult {
  notes: ShowTellNote[];
  /** One paragraph, plain prose, in the manuscript's language. */
  advice: string;
  passageCount: number;
  sampledWords: number;
}

export interface LanguageEnhanceDeps {
  llm: LlmCall;
  /** The counts this run enriches; the advice paragraph reads them. */
  counts: LanguageAnalysisReport;
  manuscriptLang?: string;
  onProgress?: (completed: number, total: number, label: string) => void;
  onCheckpoint?: (state: LanguageEnhanceState) => void;
  resumeFrom?: LanguageEnhanceState | null;
  signal?: AbortSignal;
}

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Enhanced analysis cancelled");
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;

function validateNotes(v: unknown): string | null {
  const o = asObj(v);
  if (!o) return "expected a JSON object";
  if (!Array.isArray(o.notes)) return 'missing "notes" array';
  for (const item of o.notes) {
    const io = asObj(item);
    if (!io) return "every note must be an object";
    if (typeof io.quote !== "string") return 'every note needs a "quote"';
    if (typeof io.note !== "string") return 'every note needs a "note"';
  }
  return null;
}

async function callForNotes(
  deps: LanguageEnhanceDeps,
  system: string,
  user: string,
): Promise<Obj> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfAborted(deps.signal);
    const payload =
      attempt === 0
        ? user
        : `${user}\n\nYOUR PREVIOUS RESPONSE WAS INVALID (${lastError}). Respond again with STRICT valid JSON only — no prose, no code fences.`;
    const raw = await deps.llm(system, payload, { maxTokens: 900 });
    const parsed = parseJsonResponse(raw);
    if (parsed === null) {
      lastError = "could not be parsed as JSON";
      continue;
    }
    const err = validateNotes(parsed);
    if (err) {
      lastError = err;
      continue;
    }
    return parsed as Obj;
  }
  throw new Error(
    `Enhanced analysis: model did not return valid JSON after a retry (${lastError})`,
  );
}

/**
 * Keep only notes whose quote actually occurs in the passage. A note built
 * on a paraphrased or invented line would send the author looking for words
 * they never wrote. An unknown "kind" is read as "told", the common case.
 */
export function applyNotes(
  state: LanguageEnhanceState,
  parsed: Obj,
  passage: SampledPassage,
): void {
  const passageNorm = normalize(passage.text);
  for (const item of (parsed.notes as unknown[]) ?? []) {
    const io = asObj(item);
    if (!io) continue;
    const quote = String(io.quote).trim();
    const note = String(io.note).trim();
    if (!quote || !note) continue;
    if (!passageNorm.includes(normalize(quote))) continue;
    state.notes.push({
      kind: io.kind === "shown" ? "shown" : "told",
      chapter: passage.chapter,
      quote,
      note,
    });
  }
}

function buildPassagePayload(passage: SampledPassage, total: number): string {
  return `PASSAGE ${passage.index + 1} OF ${total} — sampled from "${passage.chapter}":
<<<
${passage.text}
>>>`;
}

/** The counts, in words the advice prompt can reason about — the report's
 *  finding ids are internal names, so each carries a gloss. */
const FINDING_GLOSS: Record<string, string> = {
  adverbs_high: "-ly adverbs are frequent",
  filter_words_high: "perception filters (saw, felt, noticed) are frequent",
  crutch_word: "one word is leaned on far more than usual",
  opener_dominant: "many sentences open the same way",
  opener_runs: "runs of consecutive sentences open with the same word",
  rhythm_flat: "sentence lengths vary little — the rhythm is even",
  sentences_long: "sentences run long on average",
  tags_ornate: "dialogue tags other than 'said' are frequent",
  paragraphs_long: "many paragraphs run past 200 words",
  echoes: "the same distinctive word recurs within a few lines",
};

export function buildAdvicePayload(
  units: EditUnit[],
  state: LanguageEnhanceState,
  counts: LanguageAnalysisReport,
): string {
  return JSON.stringify({
    manuscriptStats: {
      totalWords: units.reduce((s, u) => s + countWords(u.original), 0),
      passageCount: state.passages.length,
      sampledWords: state.passages.reduce((s, p) => s + p.wordCount, 0),
    },
    counts: {
      flagged: counts.headlines.map((h) => ({
        habit: FINDING_GLOSS[h.id] ?? h.id,
        ...h.params,
      })),
      areas: counts.sections,
      mostUsed: counts.overused.slice(0, 6).map((w) => `${w.word} (${w.count})`),
    },
    notes: state.notes,
  });
}

export async function runLanguageEnhance(
  units: EditUnit[],
  deps: LanguageEnhanceDeps,
): Promise<{ result: LanguageEnhanceResult; state: LanguageEnhanceState }> {
  const state: LanguageEnhanceState = deps.resumeFrom
    ? (structuredClone(deps.resumeFrom) as LanguageEnhanceState)
    : { passages: samplePassages(units), notes: [], nextPassageIndex: 0 };
  const total = state.passages.length;
  const passagePrompt = buildLanguageEnhancePassagePrompt(deps.manuscriptLang);
  const advicePrompt = buildLanguageEnhanceAdvicePrompt(deps.manuscriptLang);

  for (let i = state.nextPassageIndex; i < total; i++) {
    const passage = state.passages[i];
    deps.onProgress?.(i, total + 1, passage.chapter);
    const parsed = await callForNotes(
      deps,
      passagePrompt,
      buildPassagePayload(passage, total),
    );
    applyNotes(state, parsed, passage);
    state.nextPassageIndex = i + 1;
    deps.onCheckpoint?.(state);
  }

  throwIfAborted(deps.signal);
  deps.onProgress?.(total, total + 1, "advice");
  const advice = (
    await deps.llm(advicePrompt, buildAdvicePayload(units, state, deps.counts), {
      maxTokens: 600,
    })
  )
    .trim()
    // One paragraph was asked for; a model that wraps it in a fence or a
    // heading anyway gets those stripped rather than shown.
    .replace(/^```[a-z]*\s*|\s*```$/g, "")
    .replace(/^#+\s.*\n+/, "")
    .trim();

  const result: LanguageEnhanceResult = {
    notes: state.notes,
    advice,
    passageCount: total,
    sampledWords: state.passages.reduce((s, p) => s + p.wordCount, 0),
  };
  deps.onProgress?.(total + 1, total + 1, "done");
  return { result, state };
}
