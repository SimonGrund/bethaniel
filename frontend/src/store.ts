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
  parallel: number;
  setParallel: (n: number) => void;

  // Task mode
  selectedModes: TaskMode[];
  toggleMode: (m: TaskMode) => void;
  copyEditOptions: CopyEditOptions;
  setCopyEditOption: (key: keyof CopyEditOptions, val: boolean) => void;
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
  toggleCorrection: (taskId: string, correctionId: string) => void;
  acceptAll: (taskId: string) => void;
  dismissAll: (taskId: string) => void;

  // Loading states
  uploading: boolean;
  setUploading: (b: boolean) => void;
  submitting: boolean;
  setSubmitting: (b: boolean) => void;
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
  setTasks: (tasks) => set({ tasks }),

  acceptedCorrections: {},
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

  uploading: false,
  setUploading: (uploading) => set({ uploading }),
  submitting: false,
  setSubmitting: (submitting) => set({ submitting }),
}));
