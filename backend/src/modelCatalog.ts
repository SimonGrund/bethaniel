// ── Centralized model catalog ──
// Single source of truth for all models available in Bethaniel.
// To swap models, edit the entries below. No other file needs to change.

export interface ModelCatalogEntry {
  id: string;
  tier: "small" | "normal" | "big";
  name: string;
  description: string;
  fileName: string;
  /** "gguf" = download from url, "ollama" = pull via Ollama API */
  source: "gguf" | "ollama";
  /** HuggingFace (or other) download URL. Required for source "gguf". */
  url: string;
  /** Ollama model tag (e.g. "qwen3:32b"). Required for source "ollama". */
  ollamaTag?: string;
  sha256: string;
  sizeBytes: number;
  minRamGb: number;
  minRamAppleSiliconGb: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MODEL CATALOG — edit here to change which models Bethaniel offers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "gemma-3n-e4b",
    tier: "small",
    name: "Baby Betty",
    description: "Small, handy, and quick. But sometimes I make mistakes.",
    fileName: "gemma-3n-E4B-it-Q4_K_M.gguf",
    source: "gguf",
    url: "https://huggingface.co/unsloth/gemma-3n-E4B-it-GGUF/resolve/main/gemma-3n-E4B-it-Q4_K_M.gguf",
    sha256: "",
    sizeBytes: 3_200_000_000,
    minRamGb: 8,
    minRamAppleSiliconGb: 8,
  },
  {
    id: "mistral-small-3.2-24b",
    tier: "normal",
    name: "Basic Betty",
    description:
      "Basic Betty is excellent for most tasks. Here you get the beeeest of both worlds - Miley Cyrus",
    fileName: "Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    source: "gguf",
    url: "https://huggingface.co/bartowski/mistralai_Mistral-Small-3.2-24B-Instruct-2506-GGUF/resolve/main/mistralai_Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf",
    sha256: "",
    sizeBytes: 14_300_000_000,
    minRamGb: 24,
    minRamAppleSiliconGb: 16,
  },
  {
    id: "qwen3-32b",
    tier: "big",
    name: "Big Bad Betty",
    description:
      "Business in the front. Party in the back. Big Bad Betty knows what it's about.",
    fileName: "Qwen3-32B-Q4_K_M.gguf",
    source: "gguf",
    url: "https://huggingface.co/unsloth/Qwen3-32B-GGUF/resolve/main/Qwen3-32B-Q4_K_M.gguf",
    sha256: "",
    sizeBytes: 19_800_000_000,
    minRamGb: 32,
    minRamAppleSiliconGb: 24,
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
