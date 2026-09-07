// ── Shared type definitions ──

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
  /**
   * Which Danish comma system the manuscript follows.
   *
   * Danish is the one bundled language with two competing, both-correct comma
   * conventions. Grammatisk komma ("grammatical comma") puts a comma before
   * every subordinate clause; nyt komma ("new comma") mostly does not. Retsk-
   * rivningsordbogen sanctions both, and which one a manuscript uses is the
   * author's choice — so enforcing either without asking would be wrong half
   * the time, which is why Danish comma recall was left alone until this
   * existed. Same shape as the Oxford-comma and dialect options: the author
   * tells us the house style, and only then do we enforce it.
   */
  danishComma: "grammatisk" | "nyt";
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
  // Grammatisk komma is the more common default in Danish fiction and is what
  // a reader is most likely to expect; nyt komma is the deliberate choice.
  danishComma: "grammatisk",
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
  /**
   * For combined (copy + line) edits: which pass produced this suggestion.
   * "copy" = objective fix (spelling/punctuation/grammar/dialect — all
   * deterministic corrections are copy); "line" = prose improvement. Set by the
   * LLM via the "kind" output field; absent for single-mode tasks (the task's
   * mode already tells you) and defaulted to "copy" when unlabeled.
   */
  editType?: "copy" | "line";
  /**
   * Whether this is an objective/mechanical error (spelling, duplicated
   * words/phrases, missing words, spacing, punctuation that's grammatically
   * wrong, dialogue-tag punctuation, missing articles/prepositions) that
   * should block publication until fixed, vs. a subjective style/word-choice
   * suggestion. Set by classifyPublicationBlocking (correctionSeverity.ts).
   */
  blocksPublication?: boolean;
  /**
   * Whether original→corrected differs only in punctuation/spacing — no
   * word added, removed, or changed. Set alongside blocksPublication so the
   * UI can group these separately (e.g. "N comma-level suggestions — run
   * the Copy Editor for a full polish") instead of lumping them in with
   * subjective line-edit suggestions. See isPunctuationOnlyChange.
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
  /** Estimated seconds remaining, from the current tok/s and the task's
   *  estimated output-token budget (see cloudEstimate.ts's estimateTaskOutputTokens). */
  etaSeconds?: number;
  /** Automatic retries already spent on this task (see retryPolicy.ts). */
  attempts?: number;
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
  /** Run-mode preset the concrete knobs were resolved from (logging only). */
  runMode?: string;
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

// ── Publication-readiness structural scan ──
export type FindingSeverity = "error" | "warning" | "info";

export interface StructuralFinding {
  check: "duplicate" | "empty_chapter" | "numbering" | "truncation" | "dialect";
  severity: FindingSeverity;
  /** Chapter name, or "Chapter 3 ↔ Chapter 9" for cross-chapter findings. */
  location: string;
  message: string;
  /** Optional supporting snippet (e.g. the start of a duplicated block). */
  detail?: string;
  /**
   * Whether this should be fixed before publishing.
   *
   * Every structural finding is: they are deterministic, and on a real
   * 32-chapter book all six were genuine defects — a duplicated tail from a
   * botched edit, an unclosed quote, closing marks typed as opening ones. The
   * LLM's comma suggestions are the ones that can wait, and they are not
   * structural findings.
   */
  blocking: boolean;
}

export interface StructuralScanReport {
  title: string;
  chaptersScanned: number;
  summary: { error: number; warning: number; info: number };
  findings: StructuralFinding[];
}
