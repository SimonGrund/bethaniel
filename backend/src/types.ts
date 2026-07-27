// ── Shared type definitions ──

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
  | "text_evaluator";

export const EDIT_MODES: TaskMode[] = [
  "copy_edit",
  "line_edit",
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
  /** Insert a comma after an introductory word/adverb/phrase ("Finally, she…").
   *  Off by default — many fiction authors omit it for flow. */
  introductoryComma: boolean;
  dialogueTags: boolean;
}

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

export const DEFAULT_LINE_EDIT_OPTIONS: LineEditOptions = {
  awkwardPhrasing: true,
  redundancy: true,
  weakVerbs: true,
  cliches: true,
  showDontTell: true,
  sentenceRhythm: false,
  dialogueNaturalness: false,
  tightenProse: false,
};

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
  md: string;
  chapters: Chapter[];
  wordCount: number;
  uploadedAt: number;
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
   * Skip the skeptical reviewer for this correction: it is a high-confidence
   * deterministic fix (e.g. the Hunspell spell-checker and an LLM editor
   * independently produced the identical original→corrected pair). The
   * reviewer's over-caution otherwise withholds obvious spelling fixes, so
   * these are applied without being flagged. See aggregateReviewScores.
   */
  preApproved?: boolean;
  /** Which thorough-mode pass produced this correction (absent = first). */
  pass?: number;
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
  // Lightweight result summary — populated only in client-facing snapshots
  // (see snapshot.ts); never set on the stored task.
  resultMeta?: {
    corrections: number;
    skipped: number;
    errors: number;
    hasStructured: boolean;
    hasText: boolean;
  } | null;
  editOptions?: Record<string, boolean | string>;
  targetLang?: string;
  manuscriptLang?: string;
  model?: string;
  tokPerSec?: string;
  // Stored re-submission spec so a failed task can be re-run without
  // going back to the upload screen. Includes the original chapter text,
  // model, prompt, chunking params, etc.
  retrySpec?: TaskRetrySpec;
  // Story-analysis resume checkpoint (registry + events + summaries +
  // next chapter index), updated after every chapter pass so a cancelled or
  // crashed 30-minute analysis resumes instead of restarting. Stripped from
  // Socket.IO snapshots (like retrySpec).
  analysisCheckpoint?: unknown;
}

export interface TaskRetrySpec {
  name: string;
  source: string;
  original: string;
  wordCount: number;
  model: string;
  mode: TaskMode;
  prompt: string;
  wpc: number;
  overlap: number;
  editOptions?: Record<string, boolean | string>;
  targetLang?: string;
  manuscriptLang?: string;
  reviewMode?: boolean;
  reviewerThreshold?: number;
  reviewerCount?: number;
  styleGuide?: string;
  spellCheck?: boolean;
  /** Deterministic retext prose checks (a/an, contractions, doubled words…). */
  retextCheck?: boolean;
  /** LanguageTool grammar/punctuation checks (local server; degrades if absent). */
  grammarCheck?: boolean;
  dualEditor?: boolean;
  dualCount?: number;
  characterDedup?: boolean;
  styleComplianceAgent?: boolean;
  extraPass?: boolean;
  /** Story analysis: all manuscript chapters (the task spans the whole book). */
  units?: EditUnit[];
  /** Text evaluator: recurring-habit digest from a finished edit job. */
  correctionsDigest?: CorrectionsDigest;
}

/** Aggregated correction patterns fed to the writing-report synthesis. */
export interface CorrectionsDigest {
  total: number;
  patterns: {
    label: string;
    count: number;
    examples: { original: string; corrected: string }[];
  }[];
}

export interface EditUnit {
  name: string;
  original: string;
}

export interface QueueAddRequest {
  docId: string;
  units: EditUnit[];
  model: string;
  modes: TaskMode[];
  wordsPerChunk?: number;
  overlapParagraphs?: number;
  parallel?: number;
  styleGuide?: string;
  editOptions?: CopyEditOptions | LineEditOptions;
  targetLang?: string;
  manuscriptLang?: string;
  reviewMode?: boolean;
  reviewerThreshold?: number;
  reviewerCount?: number;
  spellCheck?: boolean;
  retextCheck?: boolean;
  grammarCheck?: boolean;
  dualEditor?: boolean;
  dualCount?: number;
  characterDedup?: boolean;
  extraPass?: boolean;
}

// ── Structured output shapes for catalog / analysis modes ──

export interface CatalogCharacter {
  name: string;
  aliases: string[];
  chapters: string[];
  physicalDescription: string;
  personalityTraits: string[];
  role: string;
}

export interface CatalogLocation {
  name: string;
  aliases: string[];
  chapters: string[];
  description: string;
  significance: string;
}

export interface TimelineEvent {
  chapter: string;
  description: string;
  characters: string[];
  timeReference: string;
}

export interface ChunkData {
  body: string;
  core: string;
  overlapHeadParagraphs: number;
}

export interface ConsistencyReport {
  title: string;
  totalIssues: number;
  sections: { title: string; items: string[] }[];
}
