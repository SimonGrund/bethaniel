// ── Shared types (mirrors backend/src/types.ts) ──

export type TaskMode =
  | "copy_edit"
  | "line_edit"
  | "proofread"
  | "translate"
  | "character_catalog"
  | "location_catalog"
  | "timeline"
  | "combined_analysis"
  | "combined_edit"
  | "analysis_summary"
  | "blurb"
  | "text_evaluator"
  | "developmental_edit"
  | "publication_scan";

export const EDIT_MODES: TaskMode[] = [
  "copy_edit",
  "line_edit",
  "proofread",
  "translate",
  "combined_edit",
];
export const ANALYSIS_MODES: TaskMode[] = [
  "character_catalog",
  "location_catalog",
  "timeline",
  "combined_analysis",
];

// The UI presents these two as a single "Publication Scan" choice (its own
// top-level card): a surface proofread pass plus the deterministic
// structural scan. They stay separate backend modes (different task
// granularity and result shapes) — only the selection and the labels are
// merged.
export const FINAL_READTHROUGH_MODES: TaskMode[] = [
  "proofread",
  "publication_scan",
];

// Collapse a selection into i18n label keys, so a Final-readthrough selection
// reads as one name instead of "Proofread + Publication scan".
export function modeLabelKeys(modes: TaskMode[]): string[] {
  const keys: string[] = [];
  let finalAdded = false;
  for (const m of modes) {
    if (FINAL_READTHROUGH_MODES.includes(m)) {
      if (finalAdded) continue;
      finalAdded = true;
      keys.push("mode_final_readthrough");
    } else {
      keys.push(`mode_${m}`);
    }
  }
  return keys;
}

// ── Task-step grouping ──
//
// The three front cards are the paid product: FRONT_CARD_MODES must stay
// equal to CLOUD_ALLOWED_MODES (backend/src/cloudEstimate.ts) minus
// combined_edit, which the backend synthesises from copy_edit + line_edit and
// no user ever selects. backend/test/cloudModes.test.ts pins the other side.

export type FrontCard = "edit" | "readthrough" | "translate";

/** Modes each front card selects. The Edit card's line_edit is removable via
 *  its own toggle; copy_edit is not — without it the card means nothing. */
export const FRONT_CARD_MODES: Record<FrontCard, TaskMode[]> = {
  edit: ["copy_edit", "line_edit"],
  readthrough: FINAL_READTHROUGH_MODES,
  translate: ["translate"],
};

export type BetaGroupId = "developmental" | "analysis" | "feedback";

export interface BetaGroup {
  id: BetaGroupId;
  modes: TaskMode[];
  /** A whole-manuscript pass that cannot be combined with anything else. */
  exclusive: boolean;
}

export const BETA_GROUPS: BetaGroup[] = [
  { id: "developmental", modes: ["developmental_edit"], exclusive: true },
  {
    id: "analysis",
    modes: ["character_catalog", "location_catalog", "timeline"],
    exclusive: false,
  },
  { id: "feedback", modes: ["text_evaluator"], exclusive: true },
];

/** Which front card, if any, a selection belongs to. First match wins, most
 *  specific first: the cards do not overlap, but a selection persisted by an
 *  older UI can hold modes from more than one. */
export function frontCardFor(modes: TaskMode[]): FrontCard | null {
  if (modes.some((m) => FRONT_CARD_MODES.translate.includes(m))) return "translate";
  if (modes.some((m) => FRONT_CARD_MODES.readthrough.includes(m)))
    return "readthrough";
  if (modes.some((m) => FRONT_CARD_MODES.edit.includes(m))) return "edit";
  return null;
}

/** Which Beta group a selection belongs to, if any. Drives whether the
 *  disclosure starts open so a saved choice is never invisible. */
export function betaGroupFor(modes: TaskMode[]): BetaGroupId | null {
  for (const group of BETA_GROUPS) {
    if (modes.some((m) => group.modes.includes(m))) return group.id;
  }
  return null;
}

export interface CopyEditOptions {
  spelling: boolean;
  punctuation: boolean;
  capitalization: boolean;
  duplicateWords: boolean;
  englishDialect: "american" | "british";
  oxfordComma: boolean;
  introductoryComma: boolean;
  dialogueTags: boolean;
}

export const DEFAULT_COPY_EDIT_OPTIONS: CopyEditOptions = {
  spelling: true,
  punctuation: true,
  capitalization: true,
  duplicateWords: true,
  englishDialect: "american",
  oxfordComma: true,
  introductoryComma: false,
  dialogueTags: false,
};

export interface LineEditOptions {
  awkwardPhrasing: boolean;
  redundancy: boolean;
  weakVerbs: boolean;
  cliches: boolean;
  showDontTell: boolean;
  sentenceRhythm: boolean;
  dialogueNaturalness: boolean;
  tightenProse: boolean;
}

export const DEFAULT_LINE_EDIT_OPTIONS: LineEditOptions = {
  awkwardPhrasing: true,
  redundancy: true,
  weakVerbs: true,
  cliches: true,
  showDontTell: false,
  sentenceRhythm: false,
  dialogueNaturalness: false,
  tightenProse: false,
};

export interface CatalogCharacter {
  name: string;
  aliases: string[];
  firstMention: string;
  description: string;
}

export interface CatalogLocation {
  name: string;
  aliases: string[];
  firstMention: string;
  description: string;
}

export interface TimelineEvent {
  chapter: string;
  event: string;
  characters: string[];
  timeReference: string;
}

export interface Chapter {
  title: string;
  level: number;
  start: number;
  end: number;
  wordCount: number;
}

export interface DocumentMeta {
  id: string;
  name: string;
  chapters: Chapter[];
  wordCount: number;
  uploadedAt: number;
  md?: string; // only when fetched with full text
}

export interface Correction {
  original: string;
  corrected: string;
  chunk?: string;
  id?: string;
  reason?: string;
  confidence?: number;
  reviewReason?: string;
  flagged?: boolean;
  /**
   * Combined (copy + line) edits: "copy" = objective fix, "line" = prose
   * improvement. Set by the LLM's "kind" label; absent on single-mode tasks and
   * treated as "copy" when unlabeled.
   */
  editType?: "copy" | "line";
  /**
   * Whether this is an objective/mechanical error (spelling, duplicated
   * words/phrases, missing words, spacing, punctuation that's grammatically
   * wrong, dialogue-tag punctuation, missing articles/prepositions) that
   * should block publication until fixed, vs. a subjective style/word-choice
   * suggestion. Set by the backend's classifyPublicationBlocking.
   */
  blocksPublication?: boolean;
  /**
   * Whether original→corrected differs only in punctuation/spacing — no
   * word added, removed, or changed. Set by the backend alongside
   * blocksPublication so the UI can group these separately (e.g. "N
   * comma-level suggestions — run the Copy Editor for a full polish").
   */
  polishOnly?: boolean;
}

export interface TaskResult {
  editedText: string;
  originalText: string;
  corrections: Correction[];
  skipped: Correction[];
  errors: string[];
  structuredData?: unknown;
}

export type TaskStatus = "queued" | "editing" | "done" | "error" | "cancelled";

/** Lightweight result summary carried by snapshots instead of the full result. */
export interface ResultMeta {
  corrections: number;
  skipped: number;
  errors: number;
  hasStructured: boolean;
  hasText: boolean;
}

export interface TaskState {
  id: string;
  jobId: string;
  status: TaskStatus;
  progress: number;
  phase: string;
  name: string;
  source: string;
  mode: TaskMode;
  wordCount: number;
  submittedAt: number;
  startedAt?: number;
  finishedAt?: number;
  result: TaskResult | null;
  // Present in server snapshots (result itself arrives via lazy hydration).
  resultMeta?: ResultMeta | null;
  editOptions?: Record<string, boolean>;
  targetLang?: string;
  model?: string;
  tokPerSec?: string;
  etaSeconds?: number;
}

export interface EditUnit {
  name: string;
  original: string;
}

export type Lang = "en" | "da" | "de" | "es";

export interface ConsistencyReport {
  title: string;
  totalIssues: number;
  sections: { title: string; items: string[] }[];
}

export interface DownloadProgress {
  modelId: string;
  /** Friendly model name, seeded at download start so surfaces without the
   *  catalog (e.g. LogPanel) can label rows/badges. */
  name?: string;
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
  status?: string; // "starting" | "progress" | "done" | "error" | "cancelled"
  error?: string;
}

/** GET /api/languagetool/status — whether grammar checking can run, and
 *  which half (jar / Java) is missing if not. */
export interface LanguageToolStatus {
  available: boolean;
  hasJar: boolean;
  hasJava: boolean;
}

/** POST /api/languagetool/download progress, via the `languagetool:download`
 *  socket event or the resync endpoint. No byte-level progress — the backend
 *  reports coarse stages only, since the download spans two separate files. */
export interface LanguageToolDownload {
  status: "starting" | "downloading" | "done" | "error";
  error?: string;
}

/** GET /api/engine/status — is the running llama-server using the GPU? */
export interface EngineDeviceStatus {
  device: "gpu" | "cpu" | "unknown";
  running: boolean;
  model: string | null;
}

// ── Models & hardware ──
// Shared by the model-runtime hook, the selector, and the first-run popups.
// Previously these lived as private interfaces inside ModelSelector, which is
// why nothing outside that component could see which models were installed.

export interface CatalogEntry {
  id: string;
  tier: string;
  name: string;
  description: string;
  fileName: string;
  source: "gguf" | "ollama" | "api" | "custom_gguf";
  sizeBytes: number;
  minRamGb: number;
  minRamAppleSiliconGb: number;
  allowed: boolean;
  fitsGpu: boolean | null;
}

export interface HardwareInfo {
  totalRamGb: number;
  freeRamGb: number;
  platform: string;
  arch: string;
  appleSilicon: boolean;
  cpuCount: number;
  gpu: { vendor: string; vramGb: number | null; name: string | null };
  allowedTiers: string[];
}

export interface InstalledModel {
  id: string;
  tier: string;
  name: string;
  fileName: string;
}

/** What the backend knows about the machine, in a form the UI can phrase. */
export interface HardwareSummary {
  kind: "apple" | "nvidia" | "cpu";
  gpuName: string | null;
  appleVariant: "base" | "pro" | "max" | "ultra" | null;
  vramGb: number | null;
  totalRamGb: number;
}

/** Measured throughput disagreeing with the model in use. */
export interface PerfAdvice {
  /** "downgrade" — a smaller Betty would be better. "slow" — nothing smaller exists. */
  kind: "downgrade" | "slow";
  from: string;
  to: string;
  medianTps: number;
  wordsPerSec?: number;
  recommendedModelId: string;
  recommendedFileName: string;
  recommendedName: string;
  recommendedSizeBytes: number;
}

/** GET /api/models/recommendation — the one Betty this machine should run. */
export interface ModelRecommendation {
  modelId: string;
  fileName: string;
  name: string;
  description: string;
  sizeBytes: number;
  tier: string;
  /** "measured" once real throughput on this machine informed the answer. */
  basis: "estimated" | "measured";
  advice: Omit<
    PerfAdvice,
    | "recommendedModelId"
    | "recommendedFileName"
    | "recommendedName"
    | "recommendedSizeBytes"
  > | null;
  hardware: HardwareSummary;
  installed: boolean;
}

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  hintKey?: string;
  hint?: string;
  model?: string;
  taskId?: string;
}

// ── Local storage accounting ("Storage & data") ──

export interface StorageUsage {
  models: { bytes: number; files: { name: string; bytes: number }[] };
  documents: { bytes: number; count: number };
  database: { bytes: number };
  settings: { bytes: number; hasApiKey: boolean };
  total: number;
}

export interface PurgeSelection {
  models?: boolean;
  documents?: boolean;
  settings?: boolean;
}

// ── Live run statistics (socket event `run:stats`, never persisted) ──

export interface JobProgress {
  /** 0..1, share of the job's words successfully edited. */
  fraction: number;
  wordsDone: number;
  wordsTotal: number;
  /** Permanently failed chapters — why `fraction` may never reach 1. */
  failed: number;
  /** Chapters the user stopped. Their decision, not a fault to report back. */
  cancelled: number;
  /** Nothing queued or in flight: the run is over, however it ended. */
  settled: boolean;
}

export interface RuntimeStats {
  activeStreams: number;
  aggregateTokPerSec: number;
  parallelSlots: number;
  estimatedSecondsRemaining?: number;
}

export interface RunStats {
  jobProgress: Record<string, JobProgress>;
  runtime: RuntimeStats;
}
