// ── Text-evaluator orchestrator: writing-quality feedback ──
//
// Samples passages spread across the manuscript, critiques each one with the
// LLM into structured observations against a fixed craft-theme taxonomy, then
// synthesizes ONE narrative Markdown report for the author. Optionally takes
// a corrections digest from a finished copy/line edit job so the report can
// call out recurring habits.
//
// The LLM caller is injected so tests drive the orchestrator with scripted
// responses (see backend/test/textEvaluator.test.ts).

import { splitIntoParagraphs } from "./chunking.js";
import { parseJsonResponse } from "./llm.js";
import {
  buildPassageCritiquePrompt,
  buildWritingReportPrompt,
} from "./prompts.js";
import type { LlmCall } from "./storyAnalysis.js";
import type { Correction, CorrectionsDigest, EditUnit } from "./types.js";

export const CRITIQUE_THEMES = [
  "repetition",
  "adverb_overuse",
  "show_dont_tell",
  "sentence_rhythm",
  "filter_words",
  "weak_verbs",
  "dialogue",
  "pacing",
  "description_balance",
  "pov_consistency",
  "strength",
] as const;

export type CritiqueTheme = (typeof CRITIQUE_THEMES)[number];

export interface SampledPassage {
  chapter: string;
  index: number;
  text: string;
  wordCount: number;
}

export interface CritiqueObservation {
  theme: CritiqueTheme;
  chapter: string;
  quote: string;
  note: string;
  passageIndex: number;
}

export interface TextEvaluatorState {
  passages: SampledPassage[];
  observations: CritiqueObservation[];
  nextPassageIndex: number;
}

export interface TextEvaluatorResultData {
  themes: {
    theme: CritiqueTheme;
    observations: { chapter: string; quote: string; note: string }[];
  }[];
  correctionsDigest?: CorrectionsDigest;
  passageCount: number;
  sampledWords: number;
}

export interface TextEvaluatorDeps {
  llm: LlmCall;
  styleGuide?: string;
  correctionsDigest?: CorrectionsDigest;
  onProgress?: (completed: number, total: number, label: string) => void;
  onCheckpoint?: (state: TextEvaluatorState) => void;
  resumeFrom?: TextEvaluatorState | null;
  signal?: AbortSignal;
}

// ── passage sampling ──

const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const isHeading = (p: string) => /^\s*#{1,6}\s/.test(p);
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

/**
 * Deterministically pick passages spread evenly across the manuscript:
 * ~1 per 7k words (clamped 6–14, never more than 1 per 1600 words so the
 * strata cannot overlap), each paragraph-aligned, grown to ≥minWords but
 * ≤maxWords, and never crossing a chapter boundary.
 */
export function samplePassages(
  units: EditUnit[],
  opts?: { minWords?: number; maxWords?: number; maxPassages?: number },
): SampledPassage[] {
  const minWords = opts?.minWords ?? 450;
  const maxWords = opts?.maxWords ?? 800;
  const maxPassages = opts?.maxPassages ?? 14;

  type Para = { unit: number; text: string; words: number };
  const paras: Para[] = [];
  for (let u = 0; u < units.length; u++) {
    for (const text of splitIntoParagraphs(units[u].original)) {
      paras.push({ unit: u, text, words: countWords(text) });
    }
  }
  const totalWords = paras.reduce((s, p) => s + p.words, 0);
  if (totalWords === 0) return [];

  const n = Math.max(
    1,
    Math.min(
      clamp(Math.round(totalWords / 7000), 6, maxPassages),
      Math.floor(totalWords / 1600),
    ),
  );

  const passages: SampledPassage[] = [];
  let cursor = 0; // first paragraph index not yet consumed (prevents overlap)
  for (let i = 0; i < n; i++) {
    const target = ((i + 0.5) * totalWords) / n;
    let acc = 0;
    let start = paras.length - 1;
    for (let k = 0; k < paras.length; k++) {
      acc += paras[k].words;
      if (acc > target) {
        start = k;
        break;
      }
    }
    start = Math.max(start, cursor);
    while (
      start < paras.length &&
      (isHeading(paras[start].text) || paras[start].words === 0)
    ) {
      start++;
    }
    if (start >= paras.length) break;

    const unit = paras[start].unit;
    let end = start;
    let words = paras[start].words;
    while (
      end + 1 < paras.length &&
      paras[end + 1].unit === unit &&
      !isHeading(paras[end + 1].text) &&
      words < minWords &&
      words + paras[end + 1].words <= maxWords
    ) {
      end++;
      words += paras[end].words;
    }

    passages.push({
      chapter: units[unit].name,
      index: passages.length,
      text: paras
        .slice(start, end + 1)
        .map((p) => p.text)
        .join("")
        .replace(/^\n+|\n+$/g, ""),
      wordCount: words,
    });
    cursor = end + 1;
  }
  return passages;
}

// ── corrections digest ──

const REASON_BUCKETS: [string, RegExp][] = [
  ["spelling", /spell|typo|misspel/i],
  [
    "punctuation",
    /punctuat|comma|period|semicolon|colon|apostrophe|quot|hyphen|dash|ellips/i,
  ],
  ["capitalization", /capital|uppercase|lowercase/i],
  ["repetition", /repeat|repetit|redundan|duplicat/i],
  ["adverb overuse", /adverb/i],
  ["weak verbs", /weak verb|stronger verb|passive voice/i],
  ["filter words", /filter word/i],
  ["tense", /\btense\b/i],
  ["dialogue tags", /dialogue tag|dialog tag/i],
  ["awkward phrasing", /awkward|phras|wordy|clarity|flow|smooth|tighten/i],
];

const truncate = (s: string, max = 120) =>
  s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;

/** Aggregate a finished edit job's corrections into recurring-habit patterns. */
export function digestCorrections(
  corrections: Correction[],
): CorrectionsDigest {
  const groups = new Map<
    string,
    { count: number; examples: { original: string; corrected: string }[] }
  >();
  let total = 0;
  for (const c of corrections) {
    if (c.flagged) continue;
    total++;
    const reason = (c.reason ?? "").trim();
    const bucket = REASON_BUCKETS.find(([, re]) => re.test(reason));
    const label = bucket
      ? bucket[0]
      : reason
        ? reason.toLowerCase().replace(/\s+/g, " ").replace(/[.!]+$/, "")
        : "other";
    const group = groups.get(label) ?? { count: 0, examples: [] };
    group.count++;
    if (group.examples.length < 3) {
      group.examples.push({
        original: truncate(c.original),
        corrected: truncate(c.corrected),
      });
    }
    groups.set(label, group);
  }
  const patterns = [...groups.entries()]
    .map(([label, g]) => ({ label, ...g }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return { total, patterns };
}

// ── LLM plumbing (same conventions as storyAnalysis.ts) ──

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Evaluation cancelled");
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;

function validateCritique(v: unknown): string | null {
  const o = asObj(v);
  if (!o) return "expected a JSON object";
  if (!Array.isArray(o.observations)) return 'missing "observations" array';
  for (const item of o.observations) {
    const io = asObj(item);
    if (!io) return "every observation must be an object";
    if (typeof io.theme !== "string") return 'every observation needs a "theme"';
    if (typeof io.quote !== "string") return 'every observation needs a "quote"';
    if (typeof io.note !== "string") return 'every observation needs a "note"';
  }
  return null;
}

async function callJson(
  deps: TextEvaluatorDeps,
  system: string,
  user: string,
  maxTokens: number,
): Promise<Obj> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfAborted(deps.signal);
    const payload =
      attempt === 0
        ? user
        : `${user}\n\nYOUR PREVIOUS RESPONSE WAS INVALID (${lastError}). Respond again with STRICT valid JSON only — no prose, no code fences.`;
    const raw = await deps.llm(system, payload, { maxTokens });
    const parsed = parseJsonResponse(raw);
    if (parsed === null) {
      lastError = "could not be parsed as JSON";
      continue;
    }
    const err = validateCritique(parsed);
    if (err) {
      lastError = err;
      continue;
    }
    return parsed as Obj;
  }
  throw new Error(
    `Text evaluation: model did not return valid JSON after a retry (${lastError})`,
  );
}

// ── applying critique results ──

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Keep only observations with a known theme and a quote that actually occurs
 * in the passage (whitespace/case-insensitive) — small models paraphrase or
 * invent quotes, and a report built on fabricated evidence is worse than none.
 */
function applyCritiqueResult(
  state: TextEvaluatorState,
  parsed: Obj,
  passage: SampledPassage,
): void {
  const passageNorm = normalize(passage.text);
  for (const item of (parsed.observations as unknown[]) ?? []) {
    const io = asObj(item);
    if (!io) continue;
    const theme = io.theme as string;
    const quote = (io.quote as string).trim();
    const note = (io.note as string).trim();
    if (!CRITIQUE_THEMES.includes(theme as CritiqueTheme)) continue;
    if (!quote || !note) continue;
    if (!passageNorm.includes(normalize(quote))) continue;
    state.observations.push({
      theme: theme as CritiqueTheme,
      chapter: passage.chapter,
      quote,
      note,
      passageIndex: passage.index,
    });
  }
}

function groupByTheme(
  observations: CritiqueObservation[],
): TextEvaluatorResultData["themes"] {
  const themes: TextEvaluatorResultData["themes"] = [];
  for (const theme of CRITIQUE_THEMES) {
    const list = observations
      .filter((o) => o.theme === theme)
      .map(({ chapter, quote, note }) => ({ chapter, quote, note }));
    if (list.length > 0) themes.push({ theme, observations: list });
  }
  return themes;
}

// ── payload builders ──

function buildPassagePayload(
  passage: SampledPassage,
  total: number,
): string {
  return `PASSAGE ${passage.index + 1} OF ${total} — sampled from "${passage.chapter}":
<<<
${passage.text}
>>>`;
}

function buildReportPayload(
  units: EditUnit[],
  state: TextEvaluatorState,
  correctionsDigest?: CorrectionsDigest,
): string {
  const sampledWords = state.passages.reduce((s, p) => s + p.wordCount, 0);
  return JSON.stringify({
    manuscriptStats: {
      totalWords: units.reduce((s, u) => s + countWords(u.original), 0),
      passageCount: state.passages.length,
      sampledWords,
    },
    ...(correctionsDigest ? { correctionsDigest } : {}),
    themes: groupByTheme(state.observations),
  });
}

// ── main orchestration loop ──

export async function runTextEvaluation(
  units: EditUnit[],
  deps: TextEvaluatorDeps,
): Promise<{
  report: string;
  structuredData: TextEvaluatorResultData;
  state: TextEvaluatorState;
}> {
  const state = deps.resumeFrom
    ? (structuredClone(deps.resumeFrom) as TextEvaluatorState)
    : {
        passages: samplePassages(units),
        observations: [],
        nextPassageIndex: 0,
      };
  const total = state.passages.length;
  const critiquePrompt = buildPassageCritiquePrompt(deps.styleGuide);
  const reportPrompt = buildWritingReportPrompt(deps.styleGuide);

  for (let i = state.nextPassageIndex; i < total; i++) {
    const passage = state.passages[i];
    deps.onProgress?.(i, total + 1, passage.chapter);
    const parsed = await callJson(
      deps,
      critiquePrompt,
      buildPassagePayload(passage, total),
      1200,
    );
    applyCritiqueResult(state, parsed, passage);
    state.nextPassageIndex = i + 1;
    deps.onCheckpoint?.(state);
  }

  throwIfAborted(deps.signal);
  deps.onProgress?.(total, total + 1, "writing report");
  const report = (
    await deps.llm(
      reportPrompt,
      buildReportPayload(units, state, deps.correctionsDigest),
      { maxTokens: 3000 },
    )
  ).trim();

  const structuredData: TextEvaluatorResultData = {
    themes: groupByTheme(state.observations),
    ...(deps.correctionsDigest
      ? { correctionsDigest: deps.correctionsDigest }
      : {}),
    passageCount: state.passages.length,
    sampledWords: state.passages.reduce((s, p) => s + p.wordCount, 0),
  };

  deps.onProgress?.(total + 1, total + 1, "done");
  return { report, structuredData, state };
}
