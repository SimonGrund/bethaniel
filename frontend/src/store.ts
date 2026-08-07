// ── Zustand store with localStorage persistence ──
// Settings, model selection, edit options, scope, and wizard state persist
// across browser sessions. Transient state (tasks, logs, document text) is not persisted.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  DocumentMeta,
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
} from "./types";
import { DEFAULT_COPY_EDIT_OPTIONS, DEFAULT_LINE_EDIT_OPTIONS } from "./types";

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
export function stepOrder(advancedMode: boolean): WizardStep[] {
  return advancedMode
    ? ["upload", "edits", "model", "style", "run"]
    : ["upload", "edits", "style", "run"];
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
export type RunMode = "speed" | "max" | "custom";
const DEFAULT_RUN_MODE: RunMode = "speed";

interface RunModeKnobs {
  reviewMode: boolean;
  reviewerCount: number;
  reviewerThreshold: number;
  spellCheck: boolean;
  retextCheck: boolean;
  grammarCheck: boolean;
  dualEditor: boolean;
  dualCount: number;
  styleComplianceAgent: boolean;
  extraPass: boolean;
}

const RUN_MODE_PRESETS: Record<Exclude<RunMode, "custom">, RunModeKnobs> = {
  // Local default: 1 editor + style agent + 1 reviewer. No thorough 2nd pass.
  speed: {
    reviewMode: true,
    reviewerCount: 1,
    reviewerThreshold: DEFAULT_REVIEWER_THRESHOLD,
    spellCheck: true,
    retextCheck: true,
    grammarCheck: true,
    dualEditor: false,
    dualCount: DEFAULT_DUAL_COUNT,
    styleComplianceAgent: true,
    extraPass: false,
  },
  // External Betty default: 3 editors + style agent + 2 reviewers + 2nd pass.
  max: {
    reviewMode: true,
    reviewerCount: 2,
    reviewerThreshold: DEFAULT_REVIEWER_THRESHOLD,
    spellCheck: true,
    retextCheck: true,
    grammarCheck: true,
    dualEditor: true,
    dualCount: 3,
    styleComplianceAgent: true,
    extraPass: true,
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
  reviewerCount: number;
  setReviewerCount: (n: number) => void;
  spellCheck: boolean;
  setSpellCheck: (b: boolean) => void;
  retextCheck: boolean;
  setRetextCheck: (b: boolean) => void;
  grammarCheck: boolean;
  setGrammarCheck: (b: boolean) => void;
  dualEditor: boolean;
  setDualEditor: (b: boolean) => void;
  dualCount: number;
  setDualCount: (n: number) => void;
  characterDedup: boolean;
  setCharacterDedup: (b: boolean) => void;
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

  // Document
  document: DocumentMeta | null;
  setDocument: (d: DocumentMeta | null) => void;
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
  showFlagged: Record<string, boolean>;
  toggleShowFlagged: (taskId: string) => void;
  autoAcceptNonFlagged: (taskId: string) => void;
  toggleCorrection: (taskId: string, correctionId: string) => void;
  acceptAll: (taskId: string) => void;
  dismissAll: (taskId: string) => void;
  acceptAllJob: (taskIds: string[]) => void;
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

  /** Reveals the model step and its advanced settings. Off for new users. */
  advancedMode: boolean;
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
  editSubOptionsOpen: "editing" | "analysis" | "translation" | "feedback" | null;
  setEditSubOptionsOpen: (
    cat: "editing" | "analysis" | "translation" | "feedback" | null,
  ) => void;

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
      reviewerCount: DEFAULT_KNOBS.reviewerCount,
      setReviewerCount: (reviewerCount) =>
        set({ reviewerCount, runMode: "custom" }),
      spellCheck: DEFAULT_KNOBS.spellCheck,
      setSpellCheck: (spellCheck) => set({ spellCheck, runMode: "custom" }),
      retextCheck: DEFAULT_KNOBS.retextCheck,
      setRetextCheck: (retextCheck) => set({ retextCheck, runMode: "custom" }),
      grammarCheck: DEFAULT_KNOBS.grammarCheck,
      setGrammarCheck: (grammarCheck) =>
        set({ grammarCheck, runMode: "custom" }),
      dualEditor: DEFAULT_KNOBS.dualEditor,
      setDualEditor: (dualEditor) => set({ dualEditor, runMode: "custom" }),
      dualCount: DEFAULT_KNOBS.dualCount,
      setDualCount: (dualCount) => set({ dualCount, runMode: "custom" }),
      characterDedup: false,
      setCharacterDedup: (characterDedup) => set({ characterDedup }),
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

      selectedModes: ["copy_edit"],
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
        set((state) =>
          modes.length === 0 ? state : { selectedModes: [...modes] },
        ),
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

      document: null,
      setDocument: (document) => set({ document }),
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
            // Auto-accept non-flagged corrections on first hydration (results
            // only enter the store through this setter now).
            if (task.status === "done" && !acceptedCorrections[tid]) {
              acceptedCorrections[tid] = new Set(
                result.corrections
                  .filter((c) => !c.flagged)
                  .map((c) => c.id ?? "")
                  .filter(Boolean),
              );
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
      showFlagged: {},
      toggleShowFlagged: (taskId) =>
        set((state) => ({
          showFlagged: {
            ...state.showFlagged,
            [taskId]: !state.showFlagged[taskId],
          },
        })),
      autoAcceptNonFlagged: (taskId) =>
        set((state) => {
          const task = state.tasks[taskId];
          if (!task?.result) return state;
          const nonFlaggedIds = new Set(
            task.result.corrections
              .filter((c) => !c.flagged)
              .map((c) => c.id ?? "")
              .filter(Boolean),
          );
          return {
            acceptedCorrections: {
              ...state.acceptedCorrections,
              [taskId]: nonFlaggedIds,
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
      acceptAll: (taskId) =>
        set((state) => {
          const task = state.tasks[taskId];
          if (!task?.result) return state;
          // Flagged corrections are the ones the pipeline refused to
          // auto-apply — bulk accept must not sweep them in. They stay
          // individually acceptable via "Show all suggestions".
          const ids = new Set(
            task.result.corrections
              .filter((c) => !c.flagged)
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
            // Same rule as acceptAll: bulk accept skips flagged corrections.
            const ids = new Set(
              task.result.corrections
                .filter((c) => !c.flagged)
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

      advancedMode: false,
      setAdvancedMode: (advancedMode) => set({ advancedMode }),

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
      editSubOptionsOpen: null,
      setEditSubOptionsOpen: (editSubOptionsOpen) =>
        set({ editSubOptionsOpen }),

      resetAll: () =>
        set({
          model: "",
          highlightedModel: "",
          wordsPerChunk: DEFAULT_WORDS_PER_CHUNK,
          overlapParagraphs: DEFAULT_OVERLAP,
          runMode: DEFAULT_RUN_MODE,
          reviewMode: DEFAULT_KNOBS.reviewMode,
          reviewerThreshold: DEFAULT_KNOBS.reviewerThreshold,
          reviewerCount: DEFAULT_KNOBS.reviewerCount,
          spellCheck: DEFAULT_KNOBS.spellCheck,
          retextCheck: DEFAULT_KNOBS.retextCheck,
          grammarCheck: DEFAULT_KNOBS.grammarCheck,
          dualEditor: DEFAULT_KNOBS.dualEditor,
          dualCount: DEFAULT_KNOBS.dualCount,
          characterDedup: false,
          styleComplianceAgent: DEFAULT_KNOBS.styleComplianceAgent,
          extraPass: DEFAULT_KNOBS.extraPass,
          parallel: DEFAULT_PARALLEL,
          selectedModes: ["copy_edit"],
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
          editSubOptionsOpen: null,
          document: null,
          documentMd: "",
          tasks: {},
          pendingTaskIds: [],
          submitting: false,
          // Offer the model recommendation again on the next upload. Harmless
          // when a model is already installed — the popup checks for that.
          // advancedMode is deliberately kept: it is a user preference, like
          // the interface language, not part of the run being reset.
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
        const STEP_ORDER = stepOrder(state.advancedMode);
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
      partialize: (state) => ({
        // Persisted across sessions
        lang: state.lang,
        model: state.model,
        selectedModes: state.selectedModes,
        copyEditOptions: state.copyEditOptions,
        lineEditOptions: state.lineEditOptions,
        targetLang: state.targetLang,
        manuscriptLang: state.manuscriptLang,
        wordsPerChunk: state.wordsPerChunk,
        overlapParagraphs: state.overlapParagraphs,
        runMode: state.runMode,
        reviewMode: state.reviewMode,
        reviewerThreshold: state.reviewerThreshold,
        reviewerCount: state.reviewerCount,
        spellCheck: state.spellCheck,
        retextCheck: state.retextCheck,
        grammarCheck: state.grammarCheck,
        dualEditor: state.dualEditor,
        dualCount: state.dualCount,
        characterDedup: state.characterDedup,
        styleComplianceAgent: state.styleComplianceAgent,
        extraPass: state.extraPass,
        parallel: state.parallel,
        scopeMode: state.scopeMode,
        selectedChapters: state.selectedChapters,
        firstNWords: state.firstNWords,
        styleGuide: state.styleGuide,
        document: state.document,
        apiKeyConfigured: state.apiKeyConfigured,
        apiModel: state.apiModel,
        hasSeenIntro: state.hasSeenIntro,
        hasSeenModelIntro: state.hasSeenModelIntro,
        dismissedAdvice: state.dismissedAdvice,
        advancedMode: state.advancedMode,
        wizardStep: state.wizardStep,
        completedSteps: state.completedSteps,
        highlightedModel: state.highlightedModel,
        editSubOptionsOpen: state.editSubOptionsOpen,
        showEngineStatus: state.showEngineStatus,
        queueExpanded: state.queueExpanded,
        minorBreakStyle: state.minorBreakStyle,
      }),
    },
  ),
);
