// ── Shared types (mirrors backend/src/types.ts) ──

export type TaskMode =
  | "copy_edit"
  | "line_edit"
  | "translate"
  | "character_catalog"
  | "location_catalog"
  | "timeline"
  | "combined_analysis"
  | "combined_edit"
  | "analysis_summary"
  | "blurb"
  | "text_evaluator"
  | "publication_scan";

export const EDIT_MODES: TaskMode[] = [
  "copy_edit",
  "line_edit",
  "translate",
  "combined_edit",
];
export const ANALYSIS_MODES: TaskMode[] = [
  "character_catalog",
  "location_catalog",
  "timeline",
  "combined_analysis",
];

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
