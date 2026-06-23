// ── Centralized model catalog ──
// Single source of truth for all models available in Bethaniel — including
// their default runtime settings. To swap models or tweak defaults, edit the
// entries below. No other file needs to change.

import type { ModelSettings } from "./modelConfig.js";

export interface ModelCatalogEntry {
  id: string;
  tier: "small" | "normal" | "big" | "custom";
  name: string;
  description: string;
  fileName: string;
  /** "gguf" = download from url, "ollama" = pull via Ollama API, "api" = external API model, "custom_gguf" = user-specified GGUF file path */
  source: "gguf" | "ollama" | "api" | "custom_gguf";
  /** HuggingFace (or other) download URL. Required for source "gguf". */
  url: string | "";
  /** Ollama model tag (e.g. "qwen3:32b"). Required for source "ollama". */
  ollamaTag?: string;
  sha256: string;
  sizeBytes: number;
  minRamGb: number;
  minRamAppleSiliconGb: number;
  /** Per-model default runtime settings. User overrides are layered on top
   *  via the per-model JSON sidecar in MODELS_DIR. */
  defaults: ModelSettings;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Shared SYSTEM prompt — base instruction prepended to every task prompt.
//  Edit here to adjust Betty's persona globally for all models.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const BASE_SYSTEM_PROMPT =
  "You are a meticulous copy editor and line editor. /no_think";

// Shared default tuning. Per-entry overrides below can refine these values.
const COMMON_DEFAULTS: Omit<ModelSettings, "system"> = {
  num_ctx: 8192,
  num_predict: 4096,
  temperature: 0.1,
  top_p: 0.8,
  top_k: 20,
  repeat_penalty: 1.05,
  no_mmap: false,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MODEL CATALOG — edit here to change which models Bethaniel offers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "qwen3.5-4b",
    tier: "small",
    name: "Baby Betty",
    description: "Small, handy, and quick. But sometimes I make mistakes.",
    fileName: "Qwen3.5-4B-Q4_K_M.gguf",
    source: "gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-4B-MTP-GGUF/resolve/main/Qwen3.5-4B-Q4_K_M.gguf",
    sha256: "",
    sizeBytes: 2_830_000_000,
    minRamGb: 8,
    minRamAppleSiliconGb: 8,
    defaults: { ...COMMON_DEFAULTS, system: BASE_SYSTEM_PROMPT },
  },
  {
    id: "qwen3.5-9b",
    tier: "normal",
    name: "Basic Betty",
    description:
      "Basic Betty is excellent for most tasks. Here you get the beeeest of both worlds - Miley Cyrus",
    fileName: "Qwen3.5-9B-Q4_K_M.gguf",
    source: "gguf",
    url: "https://huggingface.co/unsloth/Qwen3.5-9B-MTP-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf",
    sha256: "",
    sizeBytes: 5_870_000_000,
    minRamGb: 16,
    minRamAppleSiliconGb: 12,
    defaults: { ...COMMON_DEFAULTS, system: BASE_SYSTEM_PROMPT },
  },
  {
    id: "mistral-small-3.2-24b",
    tier: "big",
    name: "Big Bad Betty",
    description:
      "Business in the front. Party in the back. Big Bad Betty knows what it's about.",
    fileName: "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    source: "gguf",
    url: "https://huggingface.co/bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF/resolve/main/mistralai_Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    sha256: "",
    sizeBytes: 14_300_000_000,
    minRamGb: 24,
    minRamAppleSiliconGb: 16,
    // Larger ctx + output budget so a ~2k-token prompt plus a verbose JSON
    // corrections response comfortably fits per slot (prompt + output must
    // share num_ctx). detectParallelSlots already accounts for KV cost.
    defaults: {
      ...COMMON_DEFAULTS,
      num_ctx: 12288,
      num_predict: 6144,
      system: BASE_SYSTEM_PROMPT,
    },
  },
  {
    id: "custom-gguf",
    tier: "custom",
    name: "Custom Betty",
    description:
      "Point to any GGUF file on your computer. Your model, your rules.",
    fileName: "custom:gguf",
    source: "custom_gguf",
    url: "",
    sha256: "",
    sizeBytes: 0,
    minRamGb: 0,
    minRamAppleSiliconGb: 0,
    defaults: {
      ...COMMON_DEFAULTS,
      system: BASE_SYSTEM_PROMPT,
    },
  },
  {
    id: "custom-deepseek",
    tier: "custom",
    name: "External Betty",
    description:
      "Connect your own DeepSeek API key. You choose the model. Your manuscript is sent to DeepSeek's servers.",
    fileName: "custom:deepseek-chat",
    source: "api",
    url: "",
    sha256: "",
    sizeBytes: 0,
    minRamGb: 0,
    minRamAppleSiliconGb: 0,
    defaults: {
      ...COMMON_DEFAULTS,
      num_ctx: 131072,
      num_predict: 8192,
      system: BASE_SYSTEM_PROMPT,
    },
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Default model — used when no model is explicitly selected
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const DEFAULT_MODEL_FILENAME = MODEL_CATALOG.at(-1)!.fileName;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TIER_RANK: Record<string, number> = { small: 1, normal: 2, big: 3 };

export function getModelById(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((e) => e.id === id);
}

export function getModelByFileName(
  fileName: string,
): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((e) => e.fileName === fileName);
}

/** Filenames ordered by tier descending (biggest first) — for auto-selection. */
export function getPreferredOrder(): string[] {
  return [...MODEL_CATALOG]
    .sort((a, b) => (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0))
    .map((e) => e.fileName);
}

/** Whether this catalog entry is obtained via Ollama (vs. direct GGUF download). */
export function isOllamaModel(entry: ModelCatalogEntry): boolean {
  return entry.source === "ollama";
}

/** Whether this catalog entry uses an external API (vs. local GGUF / Ollama). */
export function isApiModelEntry(entry: ModelCatalogEntry): boolean {
  return entry.source === "api";
}

/** Quick check: is this model identifier a user-specified GGUF path? */
export function isCustomGgufModel(fileName: string): boolean {
  return fileName.startsWith("custom:gguf");
}

/** Quick check: is this model identifier an external API model? */
export function isApiModel(fileName: string): boolean {
  return fileName.startsWith("custom:") && !isCustomGgufModel(fileName);
}
