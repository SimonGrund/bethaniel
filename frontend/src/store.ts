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

// Defaults — extracted so resetAll can reference them
const DEFAULT_SCOPE_MODE: ScopeMode = "whole_book";
const DEFAULT_PARALLEL = 3;
const DEFAULT_WORDS_PER_CHUNK = 2500;
const DEFAULT_OVERLAP = 1;
const DEFAULT_REVIEWER_THRESHOLD = 3;
const DEFAULT_REVIEWER_COUNT = 1;
const DEFAULT_DUAL_COUNT = 2;
const DEFAULT_FIRST_N_WORDS = 5000;
const DEFAULT_TARGET_LANG = "English";
const DEFAULT_MANUSCRIPT_LANG = "en";

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

  // Task mode
  selectedModes: TaskMode[];
  toggleMode: (m: TaskMode) => void;
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

  // Diagnostic log
  logs: LogEntry[];
  setLogs: (logs: LogEntry[]) => void;
  appendLog: (entry: LogEntry) => void;
  clearLogs: () => void;
  logPanelOpen: boolean;
  setLogPanelOpen: (b: boolean) => void;
  unreadLogCount: number;
  resetUnreadLogs: () => void;

  // Session boundary — tasks submitted before this timestamp belong to a previous session
  sessionStartedAt: number;

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

  // Wizard flow
  wizardStep: WizardStep;
  setWizardStep: (step: WizardStep) => void;
  completedSteps: WizardStep[];
  markStepComplete: (step: WizardStep) => void;
  highlightedModel: string;
  setHighlightedModel: (m: string) => void;
  showAdvancedSettings: boolean;
  setShowAdvancedSettings: (b: boolean) => void;
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
      reviewMode: true,
      setReviewMode: (reviewMode) => set({ reviewMode }),
      reviewerThreshold: DEFAULT_REVIEWER_THRESHOLD,
      setReviewerThreshold: (reviewerThreshold) => set({ reviewerThreshold }),
      reviewerCount: DEFAULT_REVIEWER_COUNT,
      setReviewerCount: (reviewerCount) => set({ reviewerCount }),
      spellCheck: true,
      setSpellCheck: (spellCheck) => set({ spellCheck }),
      retextCheck: true,
      setRetextCheck: (retextCheck) => set({ retextCheck }),
      grammarCheck: true,
      setGrammarCheck: (grammarCheck) => set({ grammarCheck }),
      dualEditor: true,
      setDualEditor: (dualEditor) => set({ dualEditor }),
      dualCount: DEFAULT_DUAL_COUNT,
      setDualCount: (dualCount) => set({ dualCount }),
      characterDedup: false,
      setCharacterDedup: (characterDedup) => set({ characterDedup }),
      styleComplianceAgent: true,
      setStyleComplianceAgent: (styleComplianceAgent) =>
        set({ styleComplianceAgent }),
      extraPass: true,
      setExtraPass: (extraPass) => set({ extraPass }),
      parallel: DEFAULT_PARALLEL,
      setParallel: (parallel) => set({ parallel }),

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
      setLogs: (logs) => set({ logs, unreadLogCount: 0 }),
      appendLog: (entry) =>
        set((state) => {
          if (state.logs.some((e) => e.id === entry.id)) return state;
          const next = [...state.logs, entry].slice(-500);
          return {
            logs: next,
            unreadLogCount: state.logPanelOpen
              ? 0
              : state.unreadLogCount + (entry.level === "info" ? 0 : 1),
          };
        }),
      clearLogs: () => set({ logs: [], unreadLogCount: 0 }),
      logPanelOpen: false,
      setLogPanelOpen: (b) =>
        set((state) => ({
          logPanelOpen: b,
          unreadLogCount: b ? 0 : state.unreadLogCount,
        })),
      unreadLogCount: 0,
      resetUnreadLogs: () => set({ unreadLogCount: 0 }),

      sessionStartedAt: Date.now(),

      apiKeyConfigured: false,
      setApiKeyConfigured: (apiKeyConfigured) => set({ apiKeyConfigured }),
      apiModel: "",
      setApiModel: (apiModel) => set({ apiModel }),
      showCustomBetty: true,
      setShowCustomBetty: (showCustomBetty) => set({ showCustomBetty }),
      showExternalBetty: true,
      setShowExternalBetty: (showExternalBetty) => set({ showExternalBetty }),

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
      showAdvancedSettings: false,
      setShowAdvancedSettings: (showAdvancedSettings) =>
        set({ showAdvancedSettings }),
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
          reviewMode: true,
          reviewerThreshold: DEFAULT_REVIEWER_THRESHOLD,
          reviewerCount: DEFAULT_REVIEWER_COUNT,
          spellCheck: true,
          retextCheck: true,
          grammarCheck: true,
          dualEditor: true,
          dualCount: DEFAULT_DUAL_COUNT,
          characterDedup: false,
          styleComplianceAgent: true,
          extraPass: true,
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
          showAdvancedSettings: false,
          document: null,
          documentMd: "",
          tasks: {},
          pendingTaskIds: [],
          submitting: false,
        }),

      advanceWizard: (fromStep) => {
        const state = get();
        const STEP_ORDER: WizardStep[] = [
          "upload",
          "edits",
          "model",
          "style",
          "run",
        ];
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
