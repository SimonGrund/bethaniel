// ── Shared type definitions ──

// Type-only, so the detectSettings -> dialect -> types cycle (and the
// lexicon -> types one) is erased at runtime and never becomes a real
// import cycle.
import type { QuoteStyle } from "./quoteMarks.js";
import type { DetectedSettings } from "./detectSettings.js";
import type { Lexicon, ProtectedTerms } from "./lexicon.js";

export type { DetectedSettings };

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
  | "publication_scan"
  | "language_analysis"
  | "language_enhance";

export const EDIT_MODES: TaskMode[] = [
  "copy_edit",
  "line_edit",
  "proofread",
  "combined_edit",
];
/** Passes that count rather than infer: no model, no grammar server, no
 *  download. A job made only of these runs on any install as it stands. */
export const DETERMINISTIC_MODES: TaskMode[] = [
  "publication_scan",
  "language_analysis",
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
  /**
   * The quotation-mark style the manuscript is held to — curly “ ” or
   * straight " ". Both are correct; only inconsistency is an error. Declared
   * here rather than decided by majority inside each check, for the same
   * reason englishDialect is: a 60/40 book would otherwise be normalised
   * against its author's wishes.
   */
  quoteStyle: QuoteStyle;
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
  // Curly is the default only in the sense that a word processor produces it.
  // detectQuoteStyle overwrites this from the manuscript itself at upload, and
  // a book with no clear convention leaves the author to answer.
  quoteStyle: "curly",
  oxfordComma: true,
  // Every pass on by default; the manuscript's own detection (detectSettings)
  // still moves the comma conventions to what the book actually does.
  introductoryComma: true,
  // Grammatisk komma is the more common default in Danish fiction and is what
  // a reader is most likely to expect; nyt komma is the deliberate choice.
  danishComma: "grammatisk",
  dialogueTags: true,
};

export const DEFAULT_LINE_EDIT_OPTIONS: LineEditOptions = {
  awkwardPhrasing: true,
  redundancy: true,
  weakVerbs: true,
  cliches: true,
  showDontTell: true,
  sentenceRhythm: true,
  dialogueNaturalness: true,
  tightenProse: true,
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
  /** What the text itself says about the settings the author is asked to
   *  declare — language, dialect, comma conventions. Computed once on upload
   *  (detectSettings.ts) and stored so re-selecting a document from the list
   *  pre-fills exactly as a fresh upload does. Absent on documents uploaded
   *  before detection existed. */
  detected?: DetectedSettings;
  /** The names and terms the manuscript itself spells consistently,
   *  harvested on upload (lexicon.ts) and confirmed or amended by the
   *  author. Protected from "correction" while a term is enabled. Absent on
   *  documents uploaded before the lexicon existed. */
  lexicon?: Lexicon;
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
   * The PRECISION PASS's own 1-5 score, kept separately from `confidence`.
   *
   * The pass has always produced a real score — same parser, same 1-5 scale as
   * the main reviewer — and then thrown it away after comparing it to two
   * thresholds, which made a second opinion look like a yes/no when it was
   * never that. Keeping it is what makes the two cuts tunable against a
   * benchmark instead of guessed, and lets the review screen say how strongly
   * the pass objected rather than only that it did.
   *
   * Absent where the pass does not run: line_edit tasks, and per-item on
   * preApproved and LINE-kind corrections.
   */
  precisionConfidence?: number;
  /**
   * No reviewer ran on this correction at all, because the run had review
   * turned off — as opposed to a reviewer running and missing it, which is
   * what an absent `confidence` means. The two look identical on the
   * correction otherwise, and they are not the same claim: a miss inside a
   * reviewed run inherits its cohort's quality, while this inherits nothing.
   *
   * Never set on preApproved corrections: the spell-checker and an editor
   * agent independently produced the identical fix, which is a confirmation
   * of its own and does not depend on the reviewer having run.
   */
  unreviewed?: boolean;
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
   * Set on a correction that was NOT proposed because it would have changed a
   * word the manuscript's own names & terms list vouches for — the term it
   * would have altered. Structured rather than read back out of `reason`,
   * which is English prose built for a human and is the wrong thing for the
   * UI to count by.
   */
  protectedTerm?: string;
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
  /** Where this chapter sits in the manuscript, 0-based. The name alone
   *  cannot order chapters called "Thirteen" and "Twenty-two". */
  unitIndex?: number;
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
  /**
   * Which Betty produced this run — "2.27.0", or "2.27.0-dev" for a
   * development build. Recorded rather than inferred: a dev run and the
   * installed app share a data directory and can report the same version, so
   * a defect reported from a run could not otherwise be placed. See
   * appVersion.ts.
   */
  appVersion?: string;
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
  styleGuide?: string;
  spellCheck?: boolean;
  /** Deterministic retext prose checks (a/an, contractions, doubled words…). */
  retextCheck?: boolean;
  /** LanguageTool grammar/punctuation checks (local server; degrades if absent). */
  grammarCheck?: boolean;
  styleComplianceAgent?: boolean;
  extraPass?: boolean;
  /** Run-mode preset the concrete knobs were resolved from (logging only). */
  runMode?: string;
  /** Story analysis: all manuscript chapters (the task spans the whole book). */
  units?: EditUnit[];
  /** Text evaluator: recurring-habit digest from a finished edit job. */
  correctionsDigest?: CorrectionsDigest;
  consistentTerms?: string[];
  /** The document's enabled lexicon, for the gate (queue.ts). */
  protectedTerms?: ProtectedTerms;
  unitIndex?: number;
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
  spellCheck?: boolean;
  retextCheck?: boolean;
  grammarCheck?: boolean;
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

/**
 * Every structural check the scan can report.
 *
 * A list rather than a bare union because the review panel labels each one
 * with `t("scan_check_" + check)`, and a missing label renders the raw key
 * instead of failing — so the frontend's strings have to be checkable against
 * this from a test. See publicationScanLabels.test.ts.
 */
export const STRUCTURAL_CHECKS = [
  "duplicate",
  "repetition",
  "empty_chapter",
  "numbering",
  "truncation",
  "dialect",
  "quote_style",
  "apostrophe_style",
  "ellipsis_style",
  "invisible_character",
  "placeholder",
] as const;

export type StructuralCheck = (typeof STRUCTURAL_CHECKS)[number];

export interface StructuralFinding {
  check: StructuralCheck;
  severity: FindingSeverity;
  /** Chapter name, or "Chapter 3 ↔ Chapter 9" for cross-chapter findings. */
  location: string;
  message: string;
  /** Optional supporting snippet (e.g. the start of a duplicated block). */
  detail?: string;
  /**
   * The same message as an i18n key and its values, so the interface can say
   * it in the reader's language. `message` and `detail` stay as the English
   * rendering of the same templates — results saved before these existed
   * carry only those, and the PDF falls back to them too.
   */
  messageKey?: string;
  detailKey?: string;
  params?: Record<string, string | number>;
  /** Params whose value is itself an i18n key — a dialect's name. */
  labelParams?: Record<string, string>;
  /** About the book as a whole rather than one chapter: `location` is then
   *  the word "Manuscript", which the interface translates. */
  wholeManuscript?: boolean;
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

/** One thing worth a look, chosen by how far past its threshold it sits. The
 *  interface phrases it in the reader's language from `params`. */
export interface LanguageFinding {
  id:
    | "adverbs_high"
    | "filter_words_high"
    | "crutch_word"
    | "opener_dominant"
    | "opener_runs"
    | "rhythm_flat"
    | "sentences_long"
    | "tags_ornate"
    | "paragraphs_long"
    | "echoes";
  params: Record<string, string | number>;
}

/** The language-analysis report: counts, no model. See languageAnalysis.ts. */
export interface LanguageAnalysisReport {
  language: string;
  chaptersScanned: number;
  words: number;
  sentences: number;
  headlines: LanguageFinding[];
  /** Per section: within typical range, worth a look, or nothing to judge. */
  sections: Record<
    "overused" | "adverbs" | "filter" | "openers" | "echoes" | "rhythm" | "tags" | "paragraphs",
    "ok" | "look" | "na"
  >;
  overused: { word: string; count: number; perThousand: number; kind: "crutch" | "frequent" }[];
  adverbs: { count: number; perThousand: number; top: { word: string; count: number }[]; detected: boolean };
  filterWords: { count: number; perThousand: number; top: { word: string; count: number }[] };
  openers: { word: string; count: number; share: number }[];
  openerRuns: { chapter: string; word: string; length: number; excerpt: string }[];
  echoes: { chapter: string; word: string; distance: number; excerpt: string }[];
  pacing: {
    chapter: string;
    words: number;
    sentences: number;
    meanSentence: number;
    sd: number;
    shortShare: number;
    longShare: number;
    longestSentence: number;
    dialogueShare: number;
  }[];
  rhythm: {
    meanSentence: number;
    sd: number;
    meanByChapter: number[];
    /** The book in equal runs of sentences, each as its mean length. */
    profile: { chapter: string; meanSentence: number; dialogueShare: number }[];
    windowSentences: number;
  };
  /** The thresholds the marks and headlines use; the interface prints these. */
  aims: {
    crutchPerThousand: number;
    adverbsPerThousand: number;
    filterPerThousand: number;
    openerShare: number;
    echoesPerThousand: number;
    sentenceMean: number;
    rhythmCv: number;
    tagsOtherShare: number;
    longParagraphShare: number;
  };
  dialogueTags: { said: number; other: { word: string; count: number }[]; otherCount: number };
  paragraphs: { count: number; mean: number; longest: number; over200: number };
}

/**
 * One row of "what was checked". The point of this list is the zeros: a
 * report saying "9 issues" leaves an author unable to tell a check that
 * passed from a check that never ran, and "no duplicated chapters" is a
 * thing they wanted to know rather than the absence of a thing.
 */
export interface CheckTally {
  check: StructuralCheck;
  /** How many findings this check produced. Zero is the interesting case. */
  found: number;
  /**
   * True when the manuscript gave the check nothing to judge by — a French
   * novel has no English dialect, a book with four quotation marks has no
   * convention. Reported rather than shown as a pass: a check that could not
   * run has not cleared anything.
   */
  skipped?: boolean;
}

export interface StructuralScanReport {
  title: string;
  chaptersScanned: number;
  summary: { error: number; warning: number; info: number };
  findings: StructuralFinding[];
  /** Every check the scan knows, with its count — passes included. */
  checks?: CheckTally[];
}
