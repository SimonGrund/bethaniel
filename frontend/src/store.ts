// ── Zustand store with localStorage persistence ──
// Settings, model selection, edit options, scope, and wizard state persist
// across browser sessions. Transient state (tasks, logs, document text) is not persisted.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  DocumentMeta,
  Lexicon,
  TaskState,
  TaskResult,
  EditUnit,
  Lang,
  Chapter,
  TaskMode,
  CopyEditOptions,
  LineEditOptions,
  LogEntry,
  DownloadProgress,
  CatalogEntry,
  HardwareInfo,
  InstalledModel,
  ModelRecommendation,
  PerfAdvice,
  RunStats,
  LanguageToolDownload,
  EngineDeviceStatus,
  DetectedSettings,
} from "./types";
import {
  DEFAULT_COPY_EDIT_OPTIONS,
  DEFAULT_LINE_EDIT_OPTIONS,
  isReliable,
  styleGuideApplies,
} from "./types";

type ScopeMode = "whole_book" | "selected_chapters" | "first_n_words";
export type WizardStep =
  | "model"
  | "edits"
  | "upload"
  | "style"
  | "run"
  | "done"
  | "folded";

/**
 * The wizard rail, in order.
 *
 * "model" only appears in advanced mode — non-technical users are given a
 * recommendation instead of a choice, so the step would be an obstacle. The
 * numbering in StepBar is derived from this array, so hiding the step
 * renumbers Style from 4 to 3 automatically.
 */
export function stepOrder(
  advancedMode: boolean,
  styleApplies = true,
): WizardStep[] {
  const steps: WizardStep[] = advancedMode
    ? ["upload", "edits", "model", "style", "run"]
    : ["upload", "edits", "style", "run"];
  // A run that never reads the style guide must not be able to stop on it:
  // filtering the render alone would leave advanceWizard walking onto a step
  // with nothing on screen, and the wizard stuck there.
  return styleApplies ? steps : steps.filter((s) => s !== "style");
}

// Defaults — extracted so resetAll can reference them
const DEFAULT_SCOPE_MODE: ScopeMode = "whole_book";
const DEFAULT_PARALLEL = 3;
// Ceiling for the parallel-jobs slider before hardware detection reports back.
// Single-GPU decode is bandwidth-bound, so local models rarely exceed this.
const DEFAULT_MAX_PARALLEL = 3;
const DEFAULT_WORDS_PER_CHUNK = 2500;
const DEFAULT_OVERLAP = 1;
const DEFAULT_REVIEWER_THRESHOLD = 3;
const DEFAULT_REVIEWER_COUNT = 1;
const DEFAULT_DUAL_COUNT = 2;
const DEFAULT_FIRST_N_WORDS = 5000;
const DEFAULT_TARGET_LANG = "English";
const DEFAULT_MANUSCRIPT_LANG = "en";

// ── Run-mode presets ─────────────────────────────────────────────────────
// A run mode bundles the advanced LLM-work knobs into one choice. It sets only
// values the pipeline already reads — no new orchestration. Deterministic
// checks (spell/retext/grammar) stay ON in every preset because they are cheap,
// local, and catch most mechanical errors. `parallel` is handled separately by
// the model-change auto-tune (hardware recommendation / API ceiling), not here.
// Mirrors backend/src/runModePresets.ts — keep the two tables in sync.
//
// "Max" (3 editors + 2 reviewers + a thorough 2nd pass) and "Balanced" both
// existed as presets here and were removed after benchmarking: Max helped on
// External Betty (a strong API model) but bought nothing on either bundled
// local model, and rather than keep a heavy preset that only pays off for one
// model source, it was dropped everywhere for one predictable pipeline. See
// docs/run-modes.md. `runMode` and the "custom" tag (a knob was hand-tuned
// away from the one preset) stay, since CLI/benchmark callers and the knob
// setters below still use them.
export type RunMode = "speed" | "custom";
const DEFAULT_RUN_MODE: RunMode = "speed";

interface RunModeKnobs {
  reviewMode: boolean;
  reviewerThreshold: number;
  spellCheck: boolean;
  retextCheck: boolean;
  grammarCheck: boolean;
  styleComplianceAgent: boolean;
  extraPass: boolean;
}

const RUN_MODE_PRESETS: Record<Exclude<RunMode, "custom">, RunModeKnobs> = {
  // The only preset: 1 editor + style agent + 1 reviewer. No thorough 2nd pass.
  speed: {
    reviewMode: true,
    reviewerThreshold: DEFAULT_REVIEWER_THRESHOLD,
    spellCheck: true,
    retextCheck: true,
    grammarCheck: true,
    styleComplianceAgent: true,
    extraPass: false,
  },
};

const DEFAULT_KNOBS = RUN_MODE_PRESETS[DEFAULT_RUN_MODE];

interface AppState {
  // Language
  lang: Lang;
  setLang: (lang: Lang) => void;

  // Settings
  model: string;
  setModel: (m: string) => void;
  models: string[];
  setModels: (m: string[]) => void;
  wordsPerChunk: number;
  setWordsPerChunk: (n: number) => void;
  overlapParagraphs: number;
  setOverlapParagraphs: (n: number) => void;
  reviewMode: boolean;
  setReviewMode: (b: boolean) => void;
  reviewerThreshold: number;
  setReviewerThreshold: (n: number) => void;
  spellCheck: boolean;
  setSpellCheck: (b: boolean) => void;
  retextCheck: boolean;
  setRetextCheck: (b: boolean) => void;
  grammarCheck: boolean;
  setGrammarCheck: (b: boolean) => void;
  styleComplianceAgent: boolean;
  setStyleComplianceAgent: (b: boolean) => void;
  extraPass: boolean;
  setExtraPass: (b: boolean) => void;
  parallel: number;
  setParallel: (n: number) => void;
  // Run-mode preset bundling the knobs above. "custom" = hand-tuned.
  runMode: RunMode;
  setRunMode: (m: RunMode) => void;

  // Task mode
  selectedModes: TaskMode[];
  toggleMode: (m: TaskMode) => void;
  setSelectedModes: (modes: TaskMode[]) => void;
  /** Whether the Edit card includes the line pass. Remembered separately from
   *  `selectedModes` so that switching to another card and back does not
   *  silently re-arm a pass the user deliberately turned off. */
  lineEditEnabled: boolean;
  setLineEditEnabled: (on: boolean) => void;
  copyEditOptions: CopyEditOptions;
  setCopyEditOption: <K extends keyof CopyEditOptions>(
    key: K,
    val: CopyEditOptions[K],
  ) => void;
  lineEditOptions: LineEditOptions;
  setLineEditOption: (key: keyof LineEditOptions, val: boolean) => void;
  targetLang: string;
  setTargetLang: (l: string) => void;
  // Language the manuscript is written in ("en" | "da" | "de" | "es" or
  // free text from the "Other…" option). "en" = legacy default behavior.
  manuscriptLang: string;
  setManuscriptLang: (l: string) => void;

  /**
   * What the last uploaded manuscript said about its own settings. Drives the
   * "detected" / "unsure" badges next to the controls; null before any upload
   * and for documents stored before detection existed.
   */
  detectedSettings: DetectedSettings | null;
  /**
   * The settings Betty could not read that the author has since answered —
   * by picking a value, or confirming the one shown. An answered question
   * stops asking. Cleared with the detection it belongs to.
   */
  settledSettings: (keyof DetectedSettings)[];
  settleSettings: (keys: (keyof DetectedSettings)[]) => void;
  /**
   * Apply a detection result: remember it, and move each confidently detected
   * setting to match the manuscript.
   *
   * Upload wins over a previously chosen value on purpose — the settings
   * describe THIS manuscript, and a dialect picked by hand for last month's
   * book is not evidence about this one. A manual change made afterwards
   * sticks, because nothing re-runs until the next upload.
   */
  applyDetectedSettings: (detected?: DetectedSettings | null) => void;

  // Document
  document: DocumentMeta | null;
  setDocument: (d: DocumentMeta | null) => void;

  /**
   * The manuscript's names & terms (harvested on upload, confirmed here).
   * Persisted with the document it describes and cleared with it. The
   * component that shows it saves to the server; the store only holds the
   * author's current answer.
   */
  lexicon: Lexicon | null;
  setLexicon: (l: Lexicon | null) => void;
  toggleLexiconTerm: (term: string, enabled: boolean) => void;
  setAllLexiconTerms: (enabled: boolean) => void;
  /** False when the term is empty or already listed (case-insensitively). */
  addLexiconTerm: (term: string) => boolean;
  removeLexiconTerm: (term: string) => void;
  markLexiconReviewed: () => void;
  /**
   * Forget the loaded manuscript and everything scoped to it.
   *
   * Used when an upload is refused. Leaving the previous document in place
   * behind an error message invites editing the wrong book — and a refused
   * import is exactly when the user is least sure what is loaded.
   */
  clearDocument: () => void;
  documentMd: string;
  setDocumentMd: (md: string) => void;

  // Scope
  scopeMode: ScopeMode;
  setScopeMode: (m: ScopeMode) => void;
  selectedChapters: number[];
  setSelectedChapters: (idxs: number[]) => void;
  firstNWords: number;
  setFirstNWords: (n: number) => void;

  // Style guide
  styleGuide: string;
  setStyleGuide: (s: string) => void;

  // Queue
  tasks: Record<string, TaskState>;
  setTasks: (t: Record<string, TaskState>) => void;
  // Merge lazily-fetched full results into their tasks (snapshots carry none).
  setTaskResults: (results: Record<string, TaskResult>) => void;

  // Review
  acceptedCorrections: Record<string, Set<string>>;
  seedAcceptances: (taskId: string) => void;
  toggleCorrection: (taskId: string, correctionId: string) => void;
  acceptAll: (taskId: string) => void;
  dismissAll: (taskId: string) => void;
  acceptAllJob: (taskIds: string[]) => void;
  /**
   * The deck's record of what the author has answered, in order. A card is
   * "decided" once it has been accepted or dismissed from the deck; Back pops
   * the last answer and puts the card back as it was. Session-only, like the
   * acceptances themselves.
   */
  decisionLog: { taskId: string; correctionId: string; wasAccepted: boolean }[];
  /**
   * The deck's memory, kept with the decisions so a reviewer who leaves and
   * comes back finds the deck as it was: cards put off for later (keys
   * `taskId\u0000correctionId`, in the order put off), what Back undoes
   * (the last thing done, an answer or a postponement), and the chapter
   * each job was last at.
   */
  deckPostponed: string[];
  deckHistory: { kind: "decide" | "postpone"; taskId: string }[];
  reviewCursor: Record<string, string>;
  postponeCard: (key: string) => void;
  /** Undo the last thing done in the deck of the given tasks (one job's).
   *  Returns what was undone. */
  deckBack: (taskIds: string[]) => "decide" | "postpone" | null;
  setReviewCursor: (jobId: string, taskId: string) => void;
  /** Drop every review decision — with the runs they were about. */
  forgetReview: () => void;
  decideCorrection: (taskId: string, correctionId: string, action: "accept" | "dismiss") => void;
  /** Take back the last answer — of the given tasks, when a set is given. */
  undoDecision: (taskIds?: string[]) => { taskId: string; correctionId: string } | null;
  acceptCorrection: (taskId: string, correctionId: string) => void;
  unacceptCorrections: (taskId: string, correctionIds: string[]) => void;
  dismissCorrection: (taskId: string, correctionId: string) => void;
  toggleOccurrence: (
    taskId: string,
    correctionId: string,
    occIdx: number,
    totalOccurrences: number,
  ) => void;

  // Loading states
  uploading: boolean;
  setUploading: (b: boolean) => void;
  submitting: boolean;
  setSubmitting: (b: boolean) => void;
  pendingTaskIds: string[];
  setPendingTaskIds: (ids: string[]) => void;

  // Model warm-up
  warmingModel: string | null;
  warmingStatus: "warming" | "ready" | "error" | null;
  setWarming: (
    model: string | null,
    status: "warming" | "ready" | "error" | null,
  ) => void;

  // Model downloads — transient (NOT persisted). Lifted out of ModelSelector so
  // progress keeps accruing while the user navigates between setup menus.
  downloads: Record<string, DownloadProgress>;
  setDownloadProgress: (p: DownloadProgress) => void;
  clearDownload: (modelId: string) => void;
  /** Bumped only on a completed download so ModelSelector can re-refresh its
   *  installed list + auto-select, regardless of which step is mounted. */
  downloadDoneTick: number;
  bumpDownloadDone: () => void;
  downloadError: string | null;
  setDownloadError: (msg: string | null) => void;

  // Diagnostic log
  logs: LogEntry[];
  /** Error-level entries only, for the Diagnostics panel. Persist until the
   *  user clears the log — survives ring rotation & snapshot replacement. */
  errorLogs: LogEntry[];
  setLogs: (logs: LogEntry[]) => void;
  appendLog: (entry: LogEntry) => void;
  clearLogs: () => void;
  /** Drop a task's entries once it has succeeded (see logBus.resolveLogsForTask). */
  resolveLogsForTask: (taskId: string) => void;
  logPanelOpen: boolean;
  setLogPanelOpen: (b: boolean) => void;
  unreadLogCount: number;
  resetUnreadLogs: () => void;

  // Session boundary — tasks submitted before this timestamp belong to a previous session
  sessionStartedAt: number;
  setSessionStartedAt: (ts: number) => void;

  // External Betty (API)
  apiKeyConfigured: boolean;
  setApiKeyConfigured: (b: boolean) => void;
  apiModel: string;
  setApiModel: (m: string) => void;

  // Model visibility toggles (hidden by default)
  showCustomBetty: boolean;
  setShowCustomBetty: (b: boolean) => void;
  showExternalBetty: boolean;
  setShowExternalBetty: (b: boolean) => void;

  // ── Model runtime ──
  // Machine-derived data, fetched by useModelRuntime and never persisted: it
  // describes this computer right now, so a stale copy from localStorage would
  // be worse than no copy at all.
  hardware: HardwareInfo | null;
  setHardware: (hw: HardwareInfo | null) => void;
  catalog: CatalogEntry[];
  setCatalog: (c: CatalogEntry[]) => void;
  installed: InstalledModel[];
  setInstalled: (m: InstalledModel[]) => void;
  preferredOrder: string[];
  setPreferredOrder: (o: string[]) => void;
  recommendation: ModelRecommendation | null;
  setRecommendation: (r: ModelRecommendation | null) => void;
  /** False until the first environment fetch lands. Anything that reasons about
   *  what is installed must wait for it, or an empty list reads as "nothing
   *  installed" and the UI briefly lies. */
  modelEnvLoaded: boolean;
  setModelEnvLoaded: (b: boolean) => void;
  /** Live run statistics from the `run:stats` socket event. Transient — this
   *  is what the engine is doing right now, not a setting, so it is never
   *  persisted. */
  runStats: RunStats | null;
  setRunStats: (s: RunStats | null) => void;
  /** Whether the running engine is on GPU or CPU, from `engine:device` /
   *  GET /api/engine/status. Null until the first fetch lands. */
  engineDevice: EngineDeviceStatus | null;
  setEngineDevice: (s: EngineDeviceStatus | null) => void;
  /** Ceiling for the parallel-jobs slider — hardware- or provider-derived. */
  maxParallel: number;
  setMaxParallel: (n: number) => void;

  // First-run intro guide
  hasSeenIntro: boolean;
  setHasSeenIntro: (b: boolean) => void;
  introOpen: boolean;
  setIntroOpen: (b: boolean) => void;

  // ── First-run model flow ──
  // The model step is hidden by default, so the app has to volunteer a model
  // instead of waiting to be asked. These drive that conversation.
  hasSeenModelIntro: boolean;
  setHasSeenModelIntro: (b: boolean) => void;
  modelIntroOpen: boolean;
  setModelIntroOpen: (b: boolean) => void;
  /** True between accepting the recommended download and its completion popup. */
  awaitingFirstModel: boolean;
  setAwaitingFirstModel: (b: boolean) => void;
  modelReadyOpen: boolean;
  setModelReadyOpen: (b: boolean) => void;
  /** Live throughput advice from the backend, or null when dismissed. */
  perfAdvice: PerfAdvice | null;
  setPerfAdvice: (a: PerfAdvice | null) => void;
  /** Advice the user has waved away, keyed "<tier>:<kind>". Persisted — a
   *  "keep going" answer should survive a restart. */
  dismissedAdvice: string[];
  dismissAdvice: (key: string) => void;

  /** Whether the grammar layer is installed. Null until the check lands.
   *  Kept separate from `languageToolAdvice` so the answer can be *known*
   *  without a dialog being raised about it: the offer now travels with the
   *  model download at Run rather than interrupting on launch. */
  languageToolAvailable: boolean | null;
  setLanguageToolAvailable: (b: boolean | null) => void;
  /** Progress of an in-flight (or just-finished) on-demand LanguageTool
   *  download. Transient — re-synced from the server on mount. */
  languageToolDownload: LanguageToolDownload | null;
  setLanguageToolDownload: (p: LanguageToolDownload | null) => void;

  /** Reveals the model step and its advanced settings. Off for new users. */
  advancedMode: boolean;
  /**
   * Whether the experimental-modes drawer is offered on the edits step.
   *
   * Off by default: the front cards are the product, and a drawer of
   * half-tested passes sitting under them invites people into work that is
   * not ready. It is a preference, so it survives resetAll exactly as
   * advancedMode does. See BetaFeatures.tsx for why a selection already
   * inside the drawer keeps it visible regardless of this flag.
   */
  showExperimental: boolean;
  setShowExperimental: (v: boolean) => void;
  setAdvancedMode: (b: boolean) => void;

  // Wizard flow
  wizardStep: WizardStep;
  setWizardStep: (step: WizardStep) => void;
  completedSteps: WizardStep[];
  markStepComplete: (step: WizardStep) => void;
  highlightedModel: string;
  setHighlightedModel: (m: string) => void;
  showEngineStatus: boolean;
  setShowEngineStatus: (b: boolean) => void;
  // Sidebar queue panel expansion (mini-bar when false)
  queueExpanded: boolean;
  setQueueExpanded: (b: boolean) => void;
  // DOCX export: how minor section breaks render ("hash" = Atticus-safe "#")
  minorBreakStyle: "blank" | "hash";
  setMinorBreakStyle: (s: "blank" | "hash") => void;
  // Reset
  resetAll: () => void;

  // Wizard navigation: advance past already-completed steps
  advanceWizard: (fromStep: WizardStep) => void;
}

// Accumulate error-level entries for the Diagnostics panel. Deduped by id and
// capped generously — errors are rare, so this is effectively "persist until
// cleared" while still bounding worst-case growth.
const MAX_ERROR_LOGS = 500;
function mergeErrorLogs(existing: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const errors = incoming.filter((e) => e.level === "error");
  if (errors.length === 0) return existing;
  const seen = new Set(existing.map((e) => e.id));
  const fresh = errors.filter((e) => !seen.has(e.id));
  if (fresh.length === 0) return existing;
  return [...existing, ...fresh].slice(-MAX_ERROR_LOGS);
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      lang: "en",
      setLang: (lang) => set({ lang }),

      model: "",
      setModel: (model) => set({ model }),
      models: [],
      setModels: (models) => set({ models }),
      wordsPerChunk: DEFAULT_WORDS_PER_CHUNK,
      setWordsPerChunk: (wordsPerChunk) => set({ wordsPerChunk }),
      overlapParagraphs: DEFAULT_OVERLAP,
      setOverlapParagraphs: (overlapParagraphs) => set({ overlapParagraphs }),
      reviewMode: DEFAULT_KNOBS.reviewMode,
      setReviewMode: (reviewMode) => set({ reviewMode, runMode: "custom" }),
      reviewerThreshold: DEFAULT_KNOBS.reviewerThreshold,
      setReviewerThreshold: (reviewerThreshold) =>
        set({ reviewerThreshold, runMode: "custom" }),
      spellCheck: DEFAULT_KNOBS.spellCheck,
      setSpellCheck: (spellCheck) => set({ spellCheck, runMode: "custom" }),
      retextCheck: DEFAULT_KNOBS.retextCheck,
      setRetextCheck: (retextCheck) => set({ retextCheck, runMode: "custom" }),
      grammarCheck: DEFAULT_KNOBS.grammarCheck,
      setGrammarCheck: (grammarCheck) =>
        set({ grammarCheck, runMode: "custom" }),
      styleComplianceAgent: DEFAULT_KNOBS.styleComplianceAgent,
      setStyleComplianceAgent: (styleComplianceAgent) =>
        set({ styleComplianceAgent, runMode: "custom" }),
      extraPass: DEFAULT_KNOBS.extraPass,
      setExtraPass: (extraPass) => set({ extraPass, runMode: "custom" }),
      parallel: DEFAULT_PARALLEL,
      setParallel: (parallel) => set({ parallel }),
      runMode: DEFAULT_RUN_MODE,
      setRunMode: (runMode) => {
        if (runMode === "custom") {
          set({ runMode });
          return;
        }
        // Apply the preset's knobs in one update; `parallel` is left to the
        // model-change auto-tune in ModelSelector.
        set({ runMode, ...RUN_MODE_PRESETS[runMode] });
      },

      // Empty on purpose: the task step asks "I want to…" and arrives with
      // that question unanswered, so no card is selected and no controls
      // panel is open. EditTrigger and StepBar both already treat an empty
      // selection as "not ready" rather than as an error.
      selectedModes: [],
      toggleMode: (m) =>
        set((state) => {
          const has = state.selectedModes.includes(m);
          if (has) {
            if (state.selectedModes.length <= 1) return state;
            return {
              selectedModes: state.selectedModes.filter((x) => x !== m),
            };
          }
          return { selectedModes: [...state.selectedModes, m] };
        }),
      // Atomic replacement — used wherever a whole selection is swapped at once
      // (category switches, the editing panel's exclusivity rules). Same
      // invariant as toggleMode: never leave the selection empty.
      setSelectedModes: (modes) =>
        set((state) => {
          if (modes.length === 0) return state;
          // Switching to a run that reads no style guide while standing ON the
          // style step would strand the user there: the step is filtered out of
          // the page and the step bar, so there would be nothing on screen and
          // no way forward. Same guard the model step needs when advanced mode
          // is turned off.
          const leavingStyle =
            state.wizardStep === "style" && !styleGuideApplies(modes);
          return {
            selectedModes: [...modes],
            ...(leavingStyle ? { wizardStep: "run" as WizardStep } : {}),
          };
        }),
      lineEditEnabled: true,
      setLineEditEnabled: (lineEditEnabled) => set({ lineEditEnabled }),
      copyEditOptions: { ...DEFAULT_COPY_EDIT_OPTIONS },
      setCopyEditOption: (key, val) =>
        set((state) => ({
          copyEditOptions: { ...state.copyEditOptions, [key]: val },
        })),
      lineEditOptions: { ...DEFAULT_LINE_EDIT_OPTIONS },
      setLineEditOption: (key, val) =>
        set((state) => ({
          lineEditOptions: { ...state.lineEditOptions, [key]: val },
        })),
      targetLang: DEFAULT_TARGET_LANG,
      setTargetLang: (targetLang) => set({ targetLang }),
      manuscriptLang: DEFAULT_MANUSCRIPT_LANG,
      setManuscriptLang: (manuscriptLang) => set({ manuscriptLang }),

      detectedSettings: null,
      settledSettings: [],
      settleSettings: (keys) =>
        set((state) => ({
          settledSettings: [...new Set([...state.settledSettings, ...keys])],
        })),
      applyDetectedSettings: (detected) => {
        if (!detected) {
          set({ detectedSettings: null, settledSettings: [] });
          return;
        }
        set((state) => {
          const copyEditOptions = { ...state.copyEditOptions };
          // Only confident answers move a control. An "unsure" detection is
          // shown as a badge asking the author to decide, and deliberately
          // leaves the existing value where it is.
          if (detected.englishDialect?.status === "detected") {
            copyEditOptions.englishDialect = detected.englishDialect.value;
          }
          if (detected.oxfordComma?.status === "detected") {
            copyEditOptions.oxfordComma = detected.oxfordComma.value;
          }
          if (detected.introductoryComma?.status === "detected") {
            copyEditOptions.introductoryComma =
              detected.introductoryComma.value;
          }
          if (detected.danishComma?.status === "detected") {
            copyEditOptions.danishComma = detected.danishComma.value;
          }
          return {
            detectedSettings: detected,
            settledSettings: [],
            copyEditOptions,
            manuscriptLang:
              detected.manuscriptLang?.status === "detected"
                ? detected.manuscriptLang.value
                : state.manuscriptLang,
          };
        });
      },

      document: null,
      setDocument: (document) => set({ document }),

      lexicon: null,
      setLexicon: (lexicon) => set({ lexicon }),
      toggleLexiconTerm: (term, enabled) =>
        set((state) => {
          if (!state.lexicon) return {};
          return {
            lexicon: {
              ...state.lexicon,
              terms: state.lexicon.terms.map((t) => (t.term === term ? { ...t, enabled } : t)),
            },
          };
        }),
      setAllLexiconTerms: (enabled) =>
        set((state) => {
          if (!state.lexicon) return {};
          return {
            lexicon: { ...state.lexicon, terms: state.lexicon.terms.map((t) => ({ ...t, enabled })) },
          };
        }),
      addLexiconTerm: (raw) => {
        const term = raw.trim().replace(/\s+/g, " ");
        if (!term) return false;
        const state = get();
        const lexicon: Lexicon = state.lexicon ?? {
          version: 1,
          harvestedAt: Date.now(),
          terms: [],
          nearMisses: [],
        };
        const lower = term.toLowerCase();
        if (lexicon.terms.some((t) => t.term.toLowerCase() === lower)) return false;
        set({
          lexicon: {
            ...lexicon,
            terms: [
              ...lexicon.terms,
              {
                term,
                count: 0,
                kind: term.includes(" ") ? "phrase" : "name",
                source: "manual",
                enabled: true,
              },
            ],
          },
        });
        return true;
      },
      removeLexiconTerm: (term) =>
        set((state) => {
          if (!state.lexicon) return {};
          return {
            lexicon: { ...state.lexicon, terms: state.lexicon.terms.filter((t) => t.term !== term) },
          };
        }),
      markLexiconReviewed: () =>
        set((state) =>
          state.lexicon && !state.lexicon.reviewedAt
            ? { lexicon: { ...state.lexicon, reviewedAt: Date.now() } }
            : {},
        ),

      clearDocument: () =>
        set((state) => ({
          document: null,
          documentMd: "",
          // The badges describe a manuscript that is no longer loaded.
          detectedSettings: null,
          settledSettings: [],
          lexicon: null,
          scopeMode: DEFAULT_SCOPE_MODE,
          selectedChapters: [],
          // Upload is no longer done, and no later step can be reached without
          // it — so send the wizard back rather than leaving it stranded on a
          // step that has nothing to work on.
          completedSteps: state.completedSteps.filter((s) => s !== "upload"),
          wizardStep: "upload",
        })),
      documentMd: "",
      setDocumentMd: (documentMd) => set({ documentMd }),

      scopeMode: DEFAULT_SCOPE_MODE,
      setScopeMode: (scopeMode) => set({ scopeMode }),
      selectedChapters: [0],
      setSelectedChapters: (selectedChapters) => set({ selectedChapters }),
      firstNWords: DEFAULT_FIRST_N_WORDS,
      setFirstNWords: (firstNWords) => set({ firstNWords }),

      styleGuide: "",
      setStyleGuide: (styleGuide) => set({ styleGuide }),

      tasks: {},
      setTasks: (incoming) => {
        const pending = get().pendingTaskIds;
        if (pending.length > 0 && pending.every((id) => id in incoming)) {
          set({ submitting: false, pendingTaskIds: [] });
        }
        // Task-set membership follows the server (deletes/retries propagate),
        // but snapshots never carry `result` — keep any locally-hydrated one.
        const prev = get().tasks;
        const tasks: Record<string, TaskState> = {};
        for (const [tid, t] of Object.entries(incoming)) {
          const old = prev[tid];
          tasks[tid] = !t.result && old?.result ? { ...t, result: old.result } : t;
        }
        set({ tasks });
      },

      setTaskResults: (results) =>
        set((state) => {
          const tasks = { ...state.tasks };
          const acceptedCorrections = { ...state.acceptedCorrections };
          for (const [tid, result] of Object.entries(results)) {
            const task = tasks[tid];
            if (!task) continue;
            tasks[tid] = { ...task, result };
            // Nothing is ticked on arrival. Every suggestion — the ones
            // Betty stands behind included — goes through the reviewer,
            // where "Betty would accept this" is the hint on the card, not
            // a decision taken for the author. (They used to be pre-ticked;
            // that made accepting one leave nothing to offer on its twins,
            // and put changes in the export nobody had looked at.) The
            // entry itself is created so a task is seeded once only.
            if (task.status === "done" && !acceptedCorrections[tid]) {
              acceptedCorrections[tid] = new Set<string>();
            }
          }
          return { tasks, acceptedCorrections };
        }),

      warmingModel: null,
      warmingStatus: null,
      setWarming: (warmingModel, warmingStatus) =>
        set({ warmingModel, warmingStatus }),

      downloads: {},
      setDownloadProgress: (p) =>
        set((state) => ({
          downloads: {
            ...state.downloads,
            // Merge so a name seeded at start survives modelId-only progress events.
            [p.modelId]: { ...state.downloads[p.modelId], ...p },
          },
        })),
      clearDownload: (modelId) =>
        set((state) => {
          if (!(modelId in state.downloads)) return {};
          const next = { ...state.downloads };
          delete next[modelId];
          return { downloads: next };
        }),
      downloadDoneTick: 0,
      bumpDownloadDone: () =>
        set((state) => ({ downloadDoneTick: state.downloadDoneTick + 1 })),
      downloadError: null,
      setDownloadError: (downloadError) => set({ downloadError }),

      acceptedCorrections: {},
      // Tick everything Betty is confident about, once, when the result
      // first lands. Reviewing is then reading down a list and UNticking what
      // you disagree with, rather than re-entering every verdict the pipeline
      // already reached. Nothing is ticked (see setTaskResults): the entry is
      // created empty so the task counts as seeded and is left alone after.
      seedAcceptances: (taskId) =>
        set((state) => {
          const task = state.tasks[taskId];
          if (!task?.result) return state;
          if (state.acceptedCorrections[taskId]) return state;
          return {
            acceptedCorrections: {
              ...state.acceptedCorrections,
              [taskId]: new Set<string>(),
            },
          };
        }),
      toggleCorrection: (taskId, correctionId) =>
        set((state) => {
          const current =
            state.acceptedCorrections[taskId] ?? new Set<string>();
          const next = new Set(current);
          if (next.has(correctionId)) {
            next.delete(correctionId);
          } else {
            next.add(correctionId);
          }
          return {
            acceptedCorrections: {
              ...state.acceptedCorrections,
              [taskId]: next,
            },
          };
        }),
      decisionLog: [],
      decideCorrection: (taskId, correctionId, action) => {
        const state = get();
        const set0 = state.acceptedCorrections[taskId] ?? new Set<string>();
        const wasAccepted =
          set0.has(correctionId) || [...set0].some((k) => k.startsWith(`${correctionId}:`));
        if (action === "accept") state.acceptCorrection(taskId, correctionId);
        else state.dismissCorrection(taskId, correctionId);
        set((st) => ({
          decisionLog: [
            ...st.decisionLog.filter((d) => !(d.taskId === taskId && d.correctionId === correctionId)),
            { taskId, correctionId, wasAccepted },
          ],
          deckHistory: [...st.deckHistory, { kind: "decide", taskId }],
          // A card answered is no longer put off.
          deckPostponed: st.deckPostponed.filter((k) => k !== `${taskId}\u0000${correctionId}`),
        }));
      },
      deckPostponed: [],
      deckHistory: [],
      reviewCursor: {},
      postponeCard: (key) =>
        set((st) => ({
          deckPostponed: [...st.deckPostponed.filter((k) => k !== key), key],
          deckHistory: [...st.deckHistory, { kind: "postpone", taskId: key.split(" ")[0] }],
        })),
      deckBack: (taskIds) => {
        const mine = new Set(taskIds);
        const history = get().deckHistory;
        let at = history.length - 1;
        while (at >= 0 && !mine.has(history[at].taskId)) at--;
        if (at < 0) return null;
        const last = history[at];
        set((st) => ({ deckHistory: st.deckHistory.filter((_, i) => i !== at) }));
        if (last.kind === "postpone") {
          set((st) => {
            let p = st.deckPostponed.length - 1;
            while (p >= 0 && !mine.has(st.deckPostponed[p].split(" ")[0])) p--;
            return p < 0 ? st : { deckPostponed: st.deckPostponed.filter((_, i) => i !== p) };
          });
        } else get().undoDecision(taskIds);
        return last.kind;
      },
      setReviewCursor: (jobId, taskId) =>
        set((st) =>
          st.reviewCursor[jobId] === taskId
            ? st
            : { reviewCursor: { ...st.reviewCursor, [jobId]: taskId } },
        ),
      forgetReview: () =>
        set({
          acceptedCorrections: {},
          decisionLog: [],
          deckPostponed: [],
          deckHistory: [],
          reviewCursor: {},
        }),
      undoDecision: (taskIds) => {
        const state = get();
        const mine = taskIds ? new Set(taskIds) : null;
        let at = state.decisionLog.length - 1;
        while (at >= 0 && mine && !mine.has(state.decisionLog[at].taskId)) at--;
        if (at < 0) return null;
        const last = state.decisionLog[at];
        if (last.wasAccepted) state.acceptCorrection(last.taskId, last.correctionId);
        else state.dismissCorrection(last.taskId, last.correctionId);
        set((st) => ({ decisionLog: st.decisionLog.filter((_, i) => i !== at) }));
        return { taskId: last.taskId, correctionId: last.correctionId };
      },
      acceptAll: (taskId) =>
        set((state) => {
          const task = state.tasks[taskId];
          if (!task?.result) return state;
          // Skips only the doubted bucket — the corrections a reviewer
          // actually scored low. The other two flagged kinds (never scored,
          // and doubted by the precision pass alone) measure as reliable as
          // unflagged work, so excluding them made "accept all" quietly drop
          // most of what Betty got right.
          const ids = new Set(
            task.result.corrections
              .filter(isReliable)
              .map((c) => c.id ?? "")
              .filter(Boolean),
          );
          return {
            acceptedCorrections: {
              ...state.acceptedCorrections,
              [taskId]: ids,
            },
          };
        }),
      dismissAll: (taskId) =>
        set((state) => ({
          acceptedCorrections: {
            ...state.acceptedCorrections,
            [taskId]: new Set<string>(),
          },
        })),
      acceptAllJob: (taskIds) =>
        set((state) => {
          const next = { ...state.acceptedCorrections };
          for (const tid of taskIds) {
            const task = state.tasks[tid];
            if (!task?.result) continue;
            // Same rule as acceptAll: only the doubted bucket is skipped.
            const ids = new Set(
              task.result.corrections
                .filter(isReliable)
                .map((c) => c.id ?? "")
                .filter(Boolean),
            );
            next[tid] = ids;
          }
          return { acceptedCorrections: next };
        }),
      // Remove corrections from the accepted set — both the bare id and any
      // per-occurrence "id:N" keys. Used by the export-time spell check to
      // exclude corrections that would introduce misspellings.
      unacceptCorrections: (taskId, correctionIds) =>
        set((state) => {
          const current = state.acceptedCorrections[taskId];
          if (!current) return state;
          const next = new Set(current);
          for (const id of correctionIds) {
            next.delete(id);
            for (const key of current) {
              if (key.startsWith(`${id}:`)) next.delete(key);
            }
          }
          return {
            acceptedCorrections: {
              ...state.acceptedCorrections,
              [taskId]: next,
            },
          };
        }),
      acceptCorrection: (taskId, correctionId) =>
        set((state) => {
          const current =
            state.acceptedCorrections[taskId] ?? new Set<string>();
          const next = new Set(current);
          next.add(correctionId);
          return {
            acceptedCorrections: {
              ...state.acceptedCorrections,
              [taskId]: next,
            },
          };
        }),
      dismissCorrection: (taskId, correctionId) =>
        set((state) => {
          const current =
            state.acceptedCorrections[taskId] ?? new Set<string>();
          const next = new Set(current);
          next.delete(correctionId);
          for (const key of current) {
            if (key.startsWith(`${correctionId}:`)) next.delete(key);
          }
          return {
            acceptedCorrections: {
              ...state.acceptedCorrections,
              [taskId]: next,
            },
          };
        }),
      toggleOccurrence: (taskId, correctionId, occIdx, totalOccurrences) =>
        set((state) => {
          const current =
            state.acceptedCorrections[taskId] ?? new Set<string>();
          const next = new Set(current);
          const occKey = `${correctionId}:${occIdx}`;

          if (current.has(correctionId)) {
            next.delete(correctionId);
            for (let j = 0; j < totalOccurrences; j++) {
              if (j !== occIdx) next.add(`${correctionId}:${j}`);
            }
          } else if (current.has(occKey)) {
            next.delete(occKey);
          } else {
            next.add(occKey);
          }

          let allPresent = totalOccurrences > 0;
          for (let j = 0; j < totalOccurrences && allPresent; j++) {
            if (!next.has(`${correctionId}:${j}`)) allPresent = false;
          }
          if (allPresent) {
            for (let j = 0; j < totalOccurrences; j++) {
              next.delete(`${correctionId}:${j}`);
            }
            next.add(correctionId);
          }

          return {
            acceptedCorrections: {
              ...state.acceptedCorrections,
              [taskId]: next,
            },
          };
        }),

      uploading: false,
      setUploading: (uploading) => set({ uploading }),
      submitting: false,
      setSubmitting: (submitting) => set({ submitting }),
      pendingTaskIds: [],
      setPendingTaskIds: (pendingTaskIds) => set({ pendingTaskIds }),

      logs: [],
      errorLogs: [],
      resolveLogsForTask: (taskId) =>
        set((state) => ({
          logs: state.logs.filter(
            (e) => e.taskId !== taskId || e.level === "info",
          ),
          errorLogs: state.errorLogs.filter((e) => e.taskId !== taskId),
        })),

      // Snapshot replaces the rolling log but only *adds* to the persistent
      // error list, so past errors survive reconnect/snapshot replacement.
      setLogs: (logs) =>
        set((state) => ({
          logs,
          errorLogs: mergeErrorLogs(state.errorLogs, logs),
          unreadLogCount: 0,
        })),
      appendLog: (entry) =>
        set((state) => {
          if (state.logs.some((e) => e.id === entry.id)) return state;
          const next = [...state.logs, entry].slice(-500);
          const isError = entry.level === "error";
          return {
            logs: next,
            errorLogs: isError
              ? mergeErrorLogs(state.errorLogs, [entry])
              : state.errorLogs,
            // The Diagnostics panel shows errors only, so the unread badge
            // tracks unseen errors only (info/warn flow lives in the sidebar).
            unreadLogCount:
              state.logPanelOpen || !isError
                ? state.unreadLogCount
                : state.unreadLogCount + 1,
          };
        }),
      clearLogs: () => set({ logs: [], errorLogs: [], unreadLogCount: 0 }),
      logPanelOpen: false,
      setLogPanelOpen: (b) =>
        set((state) => ({
          logPanelOpen: b,
          unreadLogCount: b ? 0 : state.unreadLogCount,
        })),
      unreadLogCount: 0,
      resetUnreadLogs: () => set({ unreadLogCount: 0 }),

      sessionStartedAt: Date.now(),
      setSessionStartedAt: (sessionStartedAt) => set({ sessionStartedAt }),

      apiKeyConfigured: false,
      setApiKeyConfigured: (apiKeyConfigured) => set({ apiKeyConfigured }),
      apiModel: "",
      setApiModel: (apiModel) => set({ apiModel }),
      showCustomBetty: true,
      setShowCustomBetty: (showCustomBetty) => set({ showCustomBetty }),
      showExternalBetty: true,
      setShowExternalBetty: (showExternalBetty) => set({ showExternalBetty }),

      hardware: null,
      setHardware: (hardware) => set({ hardware }),
      catalog: [],
      setCatalog: (catalog) => set({ catalog }),
      installed: [],
      setInstalled: (installed) => set({ installed }),
      preferredOrder: [],
      setPreferredOrder: (preferredOrder) => set({ preferredOrder }),
      recommendation: null,
      setRecommendation: (recommendation) => set({ recommendation }),
      modelEnvLoaded: false,
      runStats: null,
      setRunStats: (runStats) => set({ runStats }),
      engineDevice: null,
      setEngineDevice: (engineDevice) => set({ engineDevice }),
      setModelEnvLoaded: (modelEnvLoaded) => set({ modelEnvLoaded }),
      maxParallel: DEFAULT_MAX_PARALLEL,
      setMaxParallel: (maxParallel) => set({ maxParallel }),

      hasSeenIntro: false,
      setHasSeenIntro: (hasSeenIntro) => set({ hasSeenIntro }),
      introOpen: false,
      setIntroOpen: (introOpen) => set({ introOpen }),

      hasSeenModelIntro: false,
      setHasSeenModelIntro: (hasSeenModelIntro) => set({ hasSeenModelIntro }),
      modelIntroOpen: false,
      setModelIntroOpen: (modelIntroOpen) => set({ modelIntroOpen }),
      awaitingFirstModel: false,
      setAwaitingFirstModel: (awaitingFirstModel) => set({ awaitingFirstModel }),
      modelReadyOpen: false,
      setModelReadyOpen: (modelReadyOpen) => set({ modelReadyOpen }),
      perfAdvice: null,
      setPerfAdvice: (perfAdvice) => set({ perfAdvice }),
      dismissedAdvice: [],
      dismissAdvice: (key) =>
        set((state) => ({
          perfAdvice: null,
          dismissedAdvice: state.dismissedAdvice.includes(key)
            ? state.dismissedAdvice
            : [...state.dismissedAdvice, key],
        })),

      languageToolAvailable: null,
      setLanguageToolAvailable: (languageToolAvailable) =>
        set({ languageToolAvailable }),
      languageToolDownload: null,
      setLanguageToolDownload: (languageToolDownload) =>
        set({ languageToolDownload }),

      advancedMode: false,
      setAdvancedMode: (advancedMode) => set({ advancedMode }),
      showExperimental: false,
      setShowExperimental: (showExperimental) => set({ showExperimental }),

      wizardStep: "upload",
      setWizardStep: (wizardStep) => set({ wizardStep }),
      completedSteps: [],
      markStepComplete: (step) =>
        set((state) => ({
          completedSteps: state.completedSteps.includes(step)
            ? state.completedSteps
            : [...state.completedSteps, step],
        })),
      highlightedModel: "",
      setHighlightedModel: (highlightedModel) => set({ highlightedModel }),
      showEngineStatus: true,
      setShowEngineStatus: (showEngineStatus) => set({ showEngineStatus }),
      queueExpanded: false,
      setQueueExpanded: (queueExpanded) => set({ queueExpanded }),
      minorBreakStyle: "blank",
      setMinorBreakStyle: (minorBreakStyle) => set({ minorBreakStyle }),

      resetAll: () =>
        set({
          model: "",
          highlightedModel: "",
          wordsPerChunk: DEFAULT_WORDS_PER_CHUNK,
          overlapParagraphs: DEFAULT_OVERLAP,
          runMode: DEFAULT_RUN_MODE,
          reviewMode: DEFAULT_KNOBS.reviewMode,
          reviewerThreshold: DEFAULT_KNOBS.reviewerThreshold,
          spellCheck: DEFAULT_KNOBS.spellCheck,
          retextCheck: DEFAULT_KNOBS.retextCheck,
          grammarCheck: DEFAULT_KNOBS.grammarCheck,
          styleComplianceAgent: DEFAULT_KNOBS.styleComplianceAgent,
          extraPass: DEFAULT_KNOBS.extraPass,
          parallel: DEFAULT_PARALLEL,
          // Back to an unanswered question, same as a fresh profile.
          // lineEditEnabled resets to its own default for when Edit is picked.
          selectedModes: [],
          lineEditEnabled: true,
          copyEditOptions: { ...DEFAULT_COPY_EDIT_OPTIONS },
          lineEditOptions: { ...DEFAULT_LINE_EDIT_OPTIONS },
          targetLang: DEFAULT_TARGET_LANG,
          manuscriptLang: DEFAULT_MANUSCRIPT_LANG,
          scopeMode: DEFAULT_SCOPE_MODE,
          selectedChapters: [0],
          firstNWords: DEFAULT_FIRST_N_WORDS,
          styleGuide: "",
          wizardStep: "upload",
          completedSteps: [],
          document: null,
          documentMd: "",
          detectedSettings: null,
          settledSettings: [],
          lexicon: null,
          tasks: {},
          pendingTaskIds: [],
          submitting: false,
          // Offer the model recommendation again on the next upload. Harmless
          // when a model is already installed — the popup checks for that.
          // advancedMode and showExperimental are deliberately kept: they are
          // user preferences, like the interface language, not part of the run
          // being reset.
          hasSeenModelIntro: false,
          awaitingFirstModel: false,
          modelIntroOpen: false,
          modelReadyOpen: false,
        }),

      advanceWizard: (fromStep) => {
        const state = get();
        // Must match StepBar's rail: with the model step hidden, advancing off
        // "upload" has to skip straight past it or the wizard lands on a step
        // that renders nothing.
        const STEP_ORDER = stepOrder(
          state.advancedMode,
          styleGuideApplies(state.selectedModes),
        );
        const fromIdx = STEP_ORDER.indexOf(fromStep);
        for (let i = fromIdx + 1; i < STEP_ORDER.length; i++) {
          if (!state.completedSteps.includes(STEP_ORDER[i])) {
            set({ wizardStep: STEP_ORDER[i] });
            return;
          }
        }
        // All subsequent steps already completed — go to run
        set({ wizardStep: "run" });
      },
    }),
    {
      name: "bethaniel-settings",
      // Bumped when "max" run mode was removed: a persisted install that had
      // "max" selected (including every External Betty user — it used to be
      // the auto-selected default there) would otherwise keep max-shaped
      // knobs (extraPass and the since-removed editor/reviewer fan-out)
      // forever, since
      // those are persisted independently of the runMode label itself.
      version: 2,
      migrate: (persisted, version) => {
        let state = persisted as Partial<AppState> & { runMode?: string };
        if (version < 1 && state?.runMode && state.runMode !== "speed" && state.runMode !== "custom") {
          state = { ...state, runMode: DEFAULT_RUN_MODE, ...DEFAULT_KNOBS };
        }
        // v2: every copy and line edit option is on by default. An install
        // from before carries the old defaults in its persisted options, so
        // the flags that changed are switched on once here.
        if (version < 2) {
          state = {
            ...state,
            copyEditOptions: {
              ...DEFAULT_COPY_EDIT_OPTIONS,
              ...(state.copyEditOptions ?? {}),
              introductoryComma: true,
              dialogueTags: true,
            },
            lineEditOptions: {
              ...DEFAULT_LINE_EDIT_OPTIONS,
              ...(state.lineEditOptions ?? {}),
              showDontTell: true,
              sentenceRhythm: true,
              dialogueNaturalness: true,
              tightenProse: true,
            },
          };
        }
        return state as unknown as AppState;
      },
      // The accepted sets are Sets; JSON has none. They go out as
      // {__set: [...]} and come back as Sets.
      storage: createJSONStorage(() => localStorage, {
        replacer: (_key, value) =>
          value instanceof Set ? { __set: [...value] } : value,
        reviver: (_key, value) =>
          value && typeof value === "object" && Array.isArray((value as { __set?: unknown[] }).__set)
            ? new Set((value as { __set: string[] }).__set)
            : value,
      }),
      partialize: (state) => ({
        // Persisted across sessions
        lang: state.lang,
        model: state.model,
        selectedModes: state.selectedModes,
        lineEditEnabled: state.lineEditEnabled,
        copyEditOptions: state.copyEditOptions,
        lineEditOptions: state.lineEditOptions,
        targetLang: state.targetLang,
        manuscriptLang: state.manuscriptLang,
        wordsPerChunk: state.wordsPerChunk,
        overlapParagraphs: state.overlapParagraphs,
        runMode: state.runMode,
        reviewMode: state.reviewMode,
        reviewerThreshold: state.reviewerThreshold,
        spellCheck: state.spellCheck,
        retextCheck: state.retextCheck,
        grammarCheck: state.grammarCheck,
        styleComplianceAgent: state.styleComplianceAgent,
        extraPass: state.extraPass,
        parallel: state.parallel,
        scopeMode: state.scopeMode,
        selectedChapters: state.selectedChapters,
        firstNWords: state.firstNWords,
        styleGuide: state.styleGuide,
        document: state.document,
        // Persisted with the document it describes, so the badges survive a
        // refresh exactly as the loaded manuscript does.
        detectedSettings: state.detectedSettings,
        settledSettings: state.settledSettings,
        lexicon: state.lexicon,
        apiKeyConfigured: state.apiKeyConfigured,
        apiModel: state.apiModel,
        hasSeenIntro: state.hasSeenIntro,
        hasSeenModelIntro: state.hasSeenModelIntro,
        dismissedAdvice: state.dismissedAdvice,
        advancedMode: state.advancedMode,
        showExperimental: state.showExperimental,
        wizardStep: state.wizardStep,
        completedSteps: state.completedSteps,
        highlightedModel: state.highlightedModel,
        showEngineStatus: state.showEngineStatus,
        queueExpanded: state.queueExpanded,
        minorBreakStyle: state.minorBreakStyle,
        // The review itself: what was accepted, in what order, what was put
        // off, and where each run was left — so closing the app mid-review
        // costs nothing. Keyed by task id, so old runs keep theirs.
        acceptedCorrections: state.acceptedCorrections,
        decisionLog: state.decisionLog,
        deckPostponed: state.deckPostponed,
        deckHistory: state.deckHistory,
        reviewCursor: state.reviewCursor,
      }),
    },
  ),
);
