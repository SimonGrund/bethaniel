// ── Shared type definitions ──

export type TaskMode =
  | "copy_edit"
  | "line_edit"
  | "translate"
  | "character_catalog"
  | "location_catalog"
  | "timeline";

export const EDIT_MODES: TaskMode[] = ["copy_edit", "line_edit"];
export const ANALYSIS_MODES: TaskMode[] = [
  "character_catalog",
  "location_catalog",
  "timeline",
];

export interface CopyEditOptions {
  spelling: boolean;
  punctuation: boolean;
  capitalization: boolean;
  duplicateWords: boolean;
  britishToAmerican: boolean;
  oxfordComma: boolean;
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
  britishToAmerican: true,
  oxfordComma: true,
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
}

export interface EditUnit {
  name: string;
  original: string;
}

export interface QueueAddRequest {
  docId: string;
  units: EditUnit[];
  model: string;
  mode: TaskMode;
  fast: boolean;
  wordsPerChunk: number;
  overlapParagraphs: number;
  parallel: number;
  styleGuide?: string;
  editOptions?: CopyEditOptions | LineEditOptions;
  targetLang?: string;
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
