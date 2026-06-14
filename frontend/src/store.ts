// ── Zustand store ──

import { create } from "zustand";
import type {
  DocumentMeta,
  TaskState,
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
  fastMode: boolean;
  setFastMode: (b: boolean) => void;
  reviewMode: boolean;
  setReviewMode: (b: boolean) => void;
  reviewerThreshold: number;
  setReviewerThreshold: (n: number) => void;
  spellCheck: boolean;
  setSpellCheck: (b: boolean) => void;
  dualEditor: boolean;
  setDualEditor: (b: boolean) => void;
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

  // Review
  acceptedCorrections: Record<string, Set<string>>;
  showFlagged: Record<string, boolean>;
  toggleShowFlagged: (taskId: string) => void;
  autoAcceptNonFlagged: (taskId: string) => void;
  toggleCorrection: (taskId: string, correctionId: string) => void;
  acceptAll: (taskId: string) => void;
  dismissAll: (taskId: string) => void;
  /** Accept all corrections across a list of tasks (for "accept all changes" per job). */
  acceptAllJob: (taskIds: string[]) => void;
  /** Accept all occurrences of a single correction (adds bare correctionId). */
  acceptCorrection: (taskId: string, correctionId: string) => void;
  /** Dismiss all occurrences of a single correction (removes bare + indexed keys). */
  dismissCorrection: (taskId: string, correctionId: string) => void;
  /** Toggle a single occurrence. If bare key is present, transitions to per-occurrence mode. */
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

  // User pref: detect scene/paragraph breaks on upload (default off)
  detectBreaks: boolean;
  setDetectBreaks: (b: boolean) => void;

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

  // External Betty (API)
  apiKeyConfigured: boolean;
  setApiKeyConfigured: (b: boolean) => void;
  apiModel: string;
  setApiModel: (m: string) => void;
}

export const useStore = create<AppState>((set, get) => ({
  lang: "en",
  setLang: (lang) => set({ lang }),

  model: "",
  setModel: (model) => set({ model }),
  models: [],
  setModels: (models) => set({ models }),
  wordsPerChunk: 2500,
  setWordsPerChunk: (wordsPerChunk) => set({ wordsPerChunk }),
  overlapParagraphs: 1,
  setOverlapParagraphs: (overlapParagraphs) => set({ overlapParagraphs }),
  fastMode: true,
  setFastMode: (fastMode) => set({ fastMode }),
  reviewMode: true,
  setReviewMode: (reviewMode) => set({ reviewMode }),
  reviewerThreshold: 3,
  setReviewerThreshold: (reviewerThreshold) => set({ reviewerThreshold }),
  spellCheck: true,
  setSpellCheck: (spellCheck) => set({ spellCheck }),
  dualEditor: true,
  setDualEditor: (dualEditor) => set({ dualEditor }),
  parallel: 3,
  setParallel: (parallel) => set({ parallel }),

  selectedModes: ["copy_edit"],
  toggleMode: (m) =>
    set((state) => {
      const has = state.selectedModes.includes(m);
      if (has) {
        // Don't allow deselecting the last mode
        if (state.selectedModes.length <= 1) return state;
        return { selectedModes: state.selectedModes.filter((x) => x !== m) };
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
  targetLang: "English",
  setTargetLang: (targetLang) => set({ targetLang }),

  document: null,
  setDocument: (document) => set({ document }),
  documentMd: "",
  setDocumentMd: (documentMd) => set({ documentMd }),

  scopeMode: "whole_book",
  setScopeMode: (scopeMode) => set({ scopeMode }),
  selectedChapters: [0],
  setSelectedChapters: (selectedChapters) => set({ selectedChapters }),
  firstNWords: 5000,
  setFirstNWords: (firstNWords) => set({ firstNWords }),

  styleGuide: "",
  setStyleGuide: (styleGuide) => set({ styleGuide }),

  tasks: {},
  setTasks: (tasks) => {
    const pending = get().pendingTaskIds;
    if (pending.length > 0 && pending.every((id) => id in tasks)) {
      set({ tasks, submitting: false, pendingTaskIds: [] });
    }
    const state = get();
    for (const [tid, task] of Object.entries(tasks)) {
      if (
        task.status === "done" &&
        !state.acceptedCorrections[tid] &&
        task.result
      ) {
        const nonFlaggedIds = new Set(
          task.result.corrections
            .filter((c) => !c.flagged)
            .map((c) => c.id ?? "")
            .filter(Boolean),
        );
        state.acceptedCorrections[tid] = nonFlaggedIds;
      }
    }
    set({ tasks });
  },

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
      const current = state.acceptedCorrections[taskId] ?? new Set<string>();
      const next = new Set(current);
      if (next.has(correctionId)) {
        next.delete(correctionId);
      } else {
        next.add(correctionId);
      }
      return {
        acceptedCorrections: { ...state.acceptedCorrections, [taskId]: next },
      };
    }),
  acceptAll: (taskId) =>
    set((state) => {
      const task = state.tasks[taskId];
      if (!task?.result) return state;
      const ids = new Set(
        task.result.corrections.map((c) => c.id ?? "").filter(Boolean),
      );
      return {
        acceptedCorrections: { ...state.acceptedCorrections, [taskId]: ids },
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
        const ids = new Set(
          task.result.corrections.map((c) => c.id ?? "").filter(Boolean),
        );
        next[tid] = ids;
      }
      return { acceptedCorrections: next };
    }),
  acceptCorrection: (taskId, correctionId) =>
    set((state) => {
      const current = state.acceptedCorrections[taskId] ?? new Set<string>();
      const next = new Set(current);
      next.add(correctionId);
      return {
        acceptedCorrections: { ...state.acceptedCorrections, [taskId]: next },
      };
    }),
  dismissCorrection: (taskId, correctionId) =>
    set((state) => {
      const current = state.acceptedCorrections[taskId] ?? new Set<string>();
      const next = new Set(current);
      // Remove bare key
      next.delete(correctionId);
      // Remove all indexed occurrence keys for this correction
      for (const key of current) {
        if (key.startsWith(`${correctionId}:`)) next.delete(key);
      }
      return {
        acceptedCorrections: { ...state.acceptedCorrections, [taskId]: next },
      };
    }),
  toggleOccurrence: (taskId, correctionId, occIdx, totalOccurrences) =>
    set((state) => {
      const current = state.acceptedCorrections[taskId] ?? new Set<string>();
      const next = new Set(current);
      const occKey = `${correctionId}:${occIdx}`;

      if (current.has(correctionId)) {
        // Bare key is present (all accepted). Transition to per-occurrence:
        // remove bare key, add all occurrence keys EXCEPT the toggled one.
        next.delete(correctionId);
        for (let j = 0; j < totalOccurrences; j++) {
          if (j !== occIdx) next.add(`${correctionId}:${j}`);
        }
      } else if (current.has(occKey)) {
        // Individual occurrence was accepted — remove it
        next.delete(occKey);
      } else {
        // Individual occurrence was not accepted — add it
        next.add(occKey);
      }

      // Clean up: if all individual occurrences are now accepted,
      // collapse back to bare key
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
        acceptedCorrections: { ...state.acceptedCorrections, [taskId]: next },
      };
    }),

  uploading: false,
  setUploading: (uploading) => set({ uploading }),
  submitting: false,
  setSubmitting: (submitting) => set({ submitting }),
  pendingTaskIds: [],
  setPendingTaskIds: (pendingTaskIds) => set({ pendingTaskIds }),

  detectBreaks: false,
  setDetectBreaks: (detectBreaks) => set({ detectBreaks }),

  logs: [],
  setLogs: (logs) => set({ logs, unreadLogCount: 0 }),
  appendLog: (entry) =>
    set((state) => {
      // De-dup by id (server reuses ids monotonically per session)
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

  apiKeyConfigured: false,
  setApiKeyConfigured: (apiKeyConfigured) => set({ apiKeyConfigured }),
  apiModel: "",
  setApiModel: (apiModel) => set({ apiModel }),
}));
