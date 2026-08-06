// ── Sequential story-read analysis orchestrator ──
//
// Reads the manuscript ONE chapter at a time, in order, carrying two
// artifacts forward between calls:
//   • an entity REGISTRY (canonical characters/locations with stable ids and
//     aliases) so identity is resolved at read time — "the queen" links to
//     Katherine's id instead of spawning a duplicate entry;
//   • a STORY-SO-FAR outline (part paragraphs + recent chapter summaries).
// Part boundaries trigger a part-synthesis pass (part paragraph + event tier
// promotion); a final story pass produces the synopsis, character roles and
// location significance. Chronology is correct by construction: events are
// appended with global sequence numbers in reading order.
//
// The LLM caller is injected so tests drive the orchestrator with scripted
// JSON responses (see backend/test/storyAnalysis.test.ts).

import { groupIntoParts, type PartGroup } from "./chapters.js";
import { parseJsonResponse } from "./llm.js";
import {
  buildStoryReadPrompt,
  buildStorySynthesisPrompt,
  buildPartSynthesisPrompt,
} from "./prompts.js";
import type { EditUnit } from "./types.js";

export type LlmCall = (
  systemPrompt: string,
  userPayload: string,
  opts?: { maxTokens?: number },
) => Promise<string>;

export interface RegistryEntry {
  id: string; // "C1", "L1", …
  kind: "character" | "location";
  name: string;
  aliases: string[];
  oneLiner: string;
  chapters: string[];
  lastSeenIndex: number;
  // characters
  physicalDescription?: string;
  personalityTraits?: string[];
  role?: string;
  // locations
  description?: string;
  significance?: string;
}

export interface StoryEvent {
  seq: number;
  chapter: string;
  description: string;
  characters: string[];
  timeReference: string;
  tier: 1 | 2 | 3;
}

export interface StoryAnalysisState {
  registry: RegistryEntry[];
  events: StoryEvent[];
  chapterSummaries: { chapter: string; summary: string }[];
  partSummaries: { title: string; chapters: string[]; summary: string }[];
  nextChapterIndex: number;
  nextPartIndex: number;
  nextIds: { character: number; location: number };
  synopsis?: string;
}

export interface StoryAnalysisResult {
  characters: Array<{
    name: string;
    aliases: string[];
    chapters: string[];
    physicalDescription: string;
    personalityTraits: string[];
    role: string;
  }>;
  locations: Array<{
    name: string;
    aliases: string[];
    chapters: string[];
    description: string;
    significance: string;
  }>;
  events: StoryEvent[];
  outline: {
    synopsis: string;
    parts: { title: string; chapters: string[]; summary: string }[];
    chapterSummaries: { chapter: string; summary: string }[];
  };
}

export interface StoryAnalysisDeps {
  llm: LlmCall;
  styleGuide?: string;
  /** Language the manuscript is written in — the read is reported in it. */
  manuscriptLang?: string;
  onProgress?: (completed: number, total: number, label: string) => void;
  onCheckpoint?: (state: StoryAnalysisState) => void;
  resumeFrom?: StoryAnalysisState | null;
  signal?: AbortSignal;
}

// ── helpers ──

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Analysis cancelled");
}

function initialState(): StoryAnalysisState {
  return {
    registry: [],
    events: [],
    chapterSummaries: [],
    partSummaries: [],
    nextChapterIndex: 0,
    nextPartIndex: 0,
    nextIds: { character: 1, location: 1 },
  };
}

function findEntity(
  state: StoryAnalysisState,
  ref: string,
  kind?: RegistryEntry["kind"],
): RegistryEntry | undefined {
  const n = norm(ref);
  if (!n) return undefined;
  if (/^[cl]\d+$/.test(n)) {
    return state.registry.find((e) => e.id.toLowerCase() === n);
  }
  return state.registry.find(
    (e) =>
      (!kind || e.kind === kind) &&
      (norm(e.name) === n || e.aliases.some((a) => norm(a) === n)),
  );
}

function addAliases(entry: RegistryEntry, incoming: unknown): void {
  if (!Array.isArray(incoming)) return;
  for (const a of incoming) {
    if (typeof a !== "string") continue;
    const n = norm(a);
    if (!n || n === norm(entry.name)) continue;
    if (!entry.aliases.some((x) => norm(x) === n)) entry.aliases.push(a.trim());
  }
}

function addChapter(entry: RegistryEntry, chapter: string, index: number): void {
  if (!entry.chapters.includes(chapter)) entry.chapters.push(chapter);
  entry.lastSeenIndex = index;
}

function addTraits(entry: RegistryEntry, incoming: unknown): void {
  if (!Array.isArray(incoming)) return;
  const traits = (entry.personalityTraits ??= []);
  for (const t of incoming) {
    if (typeof t !== "string" || !t.trim()) continue;
    if (!traits.some((x) => norm(x) === norm(t))) traits.push(t.trim());
  }
}

const isPlaceholder = (s: string | undefined) =>
  !s || !s.trim() || /^not described\.?$/i.test(s.trim());

function mergeDescription(
  entry: RegistryEntry,
  field: "physicalDescription" | "description",
  update: unknown,
): void {
  if (typeof update !== "string" || isPlaceholder(update)) return;
  const current = entry[field];
  if (isPlaceholder(current)) {
    entry[field] = update.trim();
  } else if (current && !current.includes(update.trim())) {
    entry[field] = `${current} ${update.trim()}`;
  }
}

// ── prompt payload builders ──

/** Registry block: recent entities in full, long tail compact, ~32k char cap. */
export function buildRegistryBlock(
  state: StoryAnalysisState,
  currentIndex: number,
): string {
  if (state.registry.length === 0) {
    return "(empty — no entities discovered yet; everything in this chapter is new)";
  }
  const full = (e: RegistryEntry) => ({
    id: e.id,
    kind: e.kind,
    name: e.name,
    aliases: e.aliases,
    oneLiner: e.oneLiner,
    lastSeen: e.chapters[e.chapters.length - 1] ?? "",
  });
  const compact = (e: RegistryEntry) => ({
    id: e.id,
    kind: e.kind,
    name: e.name,
    aliases: e.aliases,
  });
  const isRecent = (e: RegistryEntry) => currentIndex - e.lastSeenIndex <= 5;
  const render = (compactAll: boolean) =>
    JSON.stringify(
      state.registry.map((e) =>
        !compactAll && (isRecent(e) || state.registry.length <= 40)
          ? full(e)
          : compact(e),
      ),
    );
  let block = render(false);
  if (block.length > 32_000) block = render(true);
  return block;
}

function buildStorySoFar(state: StoryAnalysisState): string {
  const lines: string[] = [];
  for (const p of state.partSummaries) {
    lines.push(p.title ? `${p.title}: ${p.summary}` : p.summary);
  }
  const covered = new Set(
    state.partSummaries.flatMap((p) => p.chapters),
  );
  const recent = state.chapterSummaries
    .filter((c) => !covered.has(c.chapter))
    .slice(-3);
  for (const c of recent) lines.push(`${c.chapter}: ${c.summary}`);
  return lines.length > 0 ? lines.join("\n") : "(the story begins here)";
}

function buildChapterPayload(
  state: StoryAnalysisState,
  unit: EditUnit,
  index: number,
  total: number,
): string {
  return `ENTITY REGISTRY (resolve mentions against these ids before creating anything new):
${buildRegistryBlock(state, index)}

STORY SO FAR:
${buildStorySoFar(state)}

CHAPTER ${index + 1} OF ${total} — "${unit.name}":
<<<
${unit.original}
>>>`;
}

function buildPartPayload(
  state: StoryAnalysisState,
  part: PartGroup,
  units: EditUnit[],
): string {
  const chapterNames = part.unitIndices.map((i) => units[i].name);
  const nameSet = new Set(chapterNames);
  return JSON.stringify({
    partTitle: part.title || "(untitled part)",
    chapterSummaries: state.chapterSummaries.filter((c) =>
      nameSet.has(c.chapter),
    ),
    events: state.events
      .filter((e) => nameSet.has(e.chapter))
      .map((e) => ({ seq: e.seq, chapter: e.chapter, description: e.description })),
  });
}

function buildStoryPayload(state: StoryAnalysisState): string {
  return JSON.stringify({
    partSummaries: state.partSummaries,
    chapterSummaries: state.chapterSummaries,
    registry: state.registry.map((e) => ({
      id: e.id,
      kind: e.kind,
      name: e.name,
      aliases: e.aliases,
      oneLiner: e.oneLiner,
      chapters: e.chapters,
      traits: e.personalityTraits,
    })),
  });
}

// ── validation ──

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;

function validateChapter(v: unknown): string | null {
  const o = asObj(v);
  if (!o) return "expected a JSON object";
  if (o.mentions !== undefined && !Array.isArray(o.mentions))
    return '"mentions" must be an array';
  if (o.events !== undefined && !Array.isArray(o.events))
    return '"events" must be an array';
  if (o.mentions === undefined && o.events === undefined && o.chapterSummary === undefined)
    return 'missing "mentions", "events" and "chapterSummary"';
  for (const m of (o.mentions as unknown[]) ?? []) {
    const mo = asObj(m);
    if (!mo) return "every mention must be an object";
    if (typeof mo.id !== "string" && !asObj(mo.new))
      return 'every mention needs an "id" or a "new" object';
    const nn = asObj(mo.new);
    if (nn && typeof nn.name !== "string")
      return 'every "new" entity needs a "name"';
  }
  return null;
}

function validatePart(v: unknown): string | null {
  const o = asObj(v);
  if (!o) return "expected a JSON object";
  if (typeof o.partSummary !== "string")
    return 'missing "partSummary" string';
  if (o.eventTiers !== undefined && !Array.isArray(o.eventTiers))
    return '"eventTiers" must be an array';
  return null;
}

function validateStory(v: unknown): string | null {
  const o = asObj(v);
  if (!o) return "expected a JSON object";
  if (typeof o.synopsis !== "string") return 'missing "synopsis" string';
  return null;
}

// ── LLM call with one validation-feedback retry ──

async function callJson(
  deps: StoryAnalysisDeps,
  system: string,
  user: string,
  validate: (v: unknown) => string | null,
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
    const err = validate(parsed);
    if (err) {
      lastError = err;
      continue;
    }
    return parsed as Obj;
  }
  throw new Error(
    `Story analysis: model did not return valid JSON after a retry (${lastError})`,
  );
}

// ── applying pass results ──

function applyChapterResult(
  state: StoryAnalysisState,
  parsed: Obj,
  chapter: string,
  index: number,
): void {
  for (const m of (parsed.mentions as unknown[]) ?? []) {
    const mo = asObj(m);
    if (!mo) continue;

    if (typeof mo.id === "string") {
      const entry = findEntity(state, mo.id);
      if (!entry) continue; // model invented an id — ignore
      addChapter(entry, chapter, index);
      addAliases(entry, mo.aliases);
      if (entry.kind === "character") {
        addTraits(entry, mo.traits);
        mergeDescription(entry, "physicalDescription", mo.descriptionUpdate);
      } else {
        mergeDescription(entry, "description", mo.descriptionUpdate);
      }
      if (typeof mo.oneLiner === "string" && mo.oneLiner.trim()) {
        entry.oneLiner = mo.oneLiner.trim();
      }
      continue;
    }

    const nn = asObj(mo.new);
    if (!nn || typeof nn.name !== "string") continue;
    const kind: RegistryEntry["kind"] =
      nn.kind === "location" ? "location" : "character";

    // Defensive identity guard: if the "new" entity's name or aliases match an
    // existing same-kind entry, merge instead of duplicating.
    const incomingNames = [
      nn.name,
      ...(Array.isArray(nn.aliases) ? nn.aliases : []),
    ].filter((x): x is string => typeof x === "string");
    let existing: RegistryEntry | undefined;
    for (const ref of incomingNames) {
      existing = findEntity(state, ref, kind);
      if (existing) break;
    }
    if (existing) {
      addChapter(existing, chapter, index);
      addAliases(existing, incomingNames);
      addTraits(existing, nn.personalityTraits);
      mergeDescription(
        existing,
        kind === "character" ? "physicalDescription" : "description",
        kind === "character" ? nn.physicalDescription : nn.description,
      );
      continue;
    }

    const id =
      kind === "character"
        ? `C${state.nextIds.character++}`
        : `L${state.nextIds.location++}`;
    const entry: RegistryEntry = {
      id,
      kind,
      name: nn.name.trim(),
      aliases: [],
      oneLiner: typeof nn.oneLiner === "string" ? nn.oneLiner.trim() : "",
      chapters: [chapter],
      lastSeenIndex: index,
    };
    addAliases(entry, nn.aliases);
    if (kind === "character") {
      entry.physicalDescription =
        typeof nn.physicalDescription === "string"
          ? nn.physicalDescription
          : "not described";
      addTraits(entry, nn.personalityTraits);
    } else {
      entry.description =
        typeof nn.description === "string" ? nn.description : "not described";
    }
    state.registry.push(entry);
  }

  for (const ev of (parsed.events as unknown[]) ?? []) {
    const eo = asObj(ev);
    if (!eo || typeof eo.description !== "string") continue;
    const characters = (Array.isArray(eo.characters) ? eo.characters : [])
      .filter((c): c is string => typeof c === "string")
      .map((c) => findEntity(state, c, "character")?.name ?? c);
    state.events.push({
      seq: state.events.length + 1,
      chapter,
      description: eo.description.trim(),
      characters: [...new Set(characters)],
      timeReference:
        typeof eo.timeReference === "string" && eo.timeReference.trim()
          ? eo.timeReference.trim()
          : "unspecified",
      tier: 3,
    });
  }

  state.chapterSummaries.push({
    chapter,
    summary:
      typeof parsed.chapterSummary === "string"
        ? parsed.chapterSummary.trim()
        : "",
  });
}

function applyPartResult(
  state: StoryAnalysisState,
  parsed: Obj,
  part: PartGroup,
  units: EditUnit[],
): void {
  state.partSummaries.push({
    title: part.title,
    chapters: part.unitIndices.map((i) => units[i].name),
    summary: (parsed.partSummary as string).trim(),
  });
  for (const t of (parsed.eventTiers as unknown[]) ?? []) {
    const to = asObj(t);
    if (!to || typeof to.seq !== "number") continue;
    const tier = to.tier === 1 ? 1 : to.tier === 2 ? 2 : null;
    if (tier === null) continue;
    const event = state.events.find((e) => e.seq === to.seq);
    if (event) event.tier = tier;
  }
}

function applyStoryResult(state: StoryAnalysisState, parsed: Obj): void {
  state.synopsis = (parsed.synopsis as string).trim();
  for (const r of (parsed.characterRoles as unknown[]) ?? []) {
    const ro = asObj(r);
    if (!ro || typeof ro.id !== "string" || typeof ro.role !== "string") continue;
    const entry = findEntity(state, ro.id);
    if (entry?.kind === "character") entry.role = ro.role.trim();
  }
  for (const s of (parsed.locationSignificance as unknown[]) ?? []) {
    const so = asObj(s);
    if (!so || typeof so.id !== "string" || typeof so.significance !== "string")
      continue;
    const entry = findEntity(state, so.id);
    if (entry?.kind === "location") entry.significance = so.significance.trim();
  }
}

// ── final assembly (schema consumed by the existing frontend views) ──

function assemble(state: StoryAnalysisState): StoryAnalysisResult {
  return {
    characters: state.registry
      .filter((e) => e.kind === "character")
      .map((e) => ({
        name: e.name,
        aliases: e.aliases,
        chapters: e.chapters,
        physicalDescription: e.physicalDescription || "not described",
        personalityTraits: e.personalityTraits ?? [],
        role: e.role || "minor",
      })),
    locations: state.registry
      .filter((e) => e.kind === "location")
      .map((e) => ({
        name: e.name,
        aliases: e.aliases,
        chapters: e.chapters,
        description: e.description || "not described",
        significance: e.significance || "",
      })),
    events: [...state.events].sort((a, b) => a.seq - b.seq),
    outline: {
      synopsis: state.synopsis ?? "",
      parts: state.partSummaries.filter((p) => p.title !== ""),
      chapterSummaries: state.chapterSummaries,
    },
  };
}

// ── main orchestration loop ──

export async function runStoryAnalysis(
  units: EditUnit[],
  deps: StoryAnalysisDeps,
): Promise<{ structuredData: StoryAnalysisResult; state: StoryAnalysisState }> {
  const state = deps.resumeFrom
    ? (structuredClone(deps.resumeFrom) as StoryAnalysisState)
    : initialState();
  const parts = groupIntoParts(units.map((u) => u.name));
  const total = units.length;
  const chapterPrompt = buildStoryReadPrompt(
    deps.styleGuide,
    deps.manuscriptLang,
  );
  const storyPrompt = buildStorySynthesisPrompt(
    deps.styleGuide,
    deps.manuscriptLang,
  );
  const partPrompt = buildPartSynthesisPrompt(deps.manuscriptLang);

  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];

    for (const ui of part.unitIndices) {
      if (ui < state.nextChapterIndex) continue; // resumed past this chapter
      deps.onProgress?.(ui, total, units[ui].name);
      const parsed = await callJson(
        deps,
        chapterPrompt,
        buildChapterPayload(state, units[ui], ui, total),
        validateChapter,
        4096,
      );
      applyChapterResult(state, parsed, units[ui].name, ui);
      state.nextChapterIndex = ui + 1;
      deps.onCheckpoint?.(state);
    }

    if (pi < state.nextPartIndex) continue; // resumed past this part pass
    const parsed = await callJson(
      deps,
      partPrompt,
      buildPartPayload(state, part, units),
      validatePart,
      1200,
    );
    applyPartResult(state, parsed, part, units);
    state.nextPartIndex = pi + 1;
    deps.onCheckpoint?.(state);
  }

  if (!state.synopsis) {
    const parsed = await callJson(
      deps,
      storyPrompt,
      buildStoryPayload(state),
      validateStory,
      2000,
    );
    applyStoryResult(state, parsed);
    deps.onCheckpoint?.(state);
  }

  deps.onProgress?.(total, total, "done");
  return { structuredData: assemble(state), state };
}
