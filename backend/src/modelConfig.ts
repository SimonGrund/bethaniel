// ── Model configuration ──
// Defines the per-model `ModelSettings` shape. Defaults live in
// `modelCatalog.ts` (one `defaults` block per entry); a JSON sidecar in
// MODELS_DIR may override individual fields per user.
//
// `readModelConfig` returns the layered result: catalog defaults + sidecar
// overrides. `writeModelConfig` persists a full snapshot of the effective
// settings. `resetModelConfig` deletes the sidecar so defaults take over again.

import * as fs from "fs";
import * as path from "path";
import { getModelByFileName } from "./modelCatalog.js";

export interface ModelSettings {
  num_ctx: number;
  num_predict: number;
  temperature: number;
  top_p: number;
  top_k: number;
  repeat_penalty: number;
  system: string;
  no_mmap: boolean;
}

/** Fallback used only when a fileName has no catalog entry (shouldn't normally
 *  happen — routes validate against the catalog before calling these). */
const HARD_DEFAULTS: ModelSettings = {
  num_ctx: 8192,
  num_predict: 4096,
  temperature: 0.1,
  top_p: 0.8,
  top_k: 20,
  repeat_penalty: 1.05,
  system: "You are a meticulous copy editor and line editor. /no_think",
  no_mmap: false,
};

/** Catalog defaults for a given GGUF filename, or HARD_DEFAULTS if unknown. */
export function getDefaultsForFile(ggufFileName: string): ModelSettings {
  const entry = getModelByFileName(ggufFileName);
  return entry ? { ...entry.defaults } : { ...HARD_DEFAULTS };
}

/**
 * Config JSON path for a given GGUF file.
 * E.g. "Qwen3.5-4B-Q4_K_M.gguf" → "Qwen3.5-4B-Q4_K_M.json"
 */
function configPathForModel(modelsDir: string, ggufFileName: string): string {
  const base = ggufFileName.replace(/\.gguf$/i, "");
  return path.join(modelsDir, `${base}.json`);
}

/**
 * Write effective model settings JSON alongside the GGUF file.
 * Stores a full snapshot — `readModelConfig` still layers it over catalog
 * defaults so newly-added fields fall back gracefully on older sidecars.
 */
export function writeModelConfig(
  modelsDir: string,
  ggufFileName: string,
  settings: ModelSettings,
): void {
  const configPath = configPathForModel(modelsDir, ggufFileName);
  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`[modelConfig] Wrote config: ${configPath}`);
}

/**
 * Read model settings: catalog defaults overlaid with any sidecar JSON.
 * Returns catalog defaults when no sidecar exists (no write side-effect).
 */
export function readModelConfig(
  modelsDir: string,
  ggufFileName: string,
): ModelSettings {
  const defaults = getDefaultsForFile(ggufFileName);
  const configPath = configPathForModel(modelsDir, ggufFileName);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ModelSettings>;
    return {
      num_ctx: parsed.num_ctx ?? defaults.num_ctx,
      num_predict: parsed.num_predict ?? defaults.num_predict,
      temperature: parsed.temperature ?? defaults.temperature,
      top_p: parsed.top_p ?? defaults.top_p,
      top_k: parsed.top_k ?? defaults.top_k,
      repeat_penalty: parsed.repeat_penalty ?? defaults.repeat_penalty,
      system: parsed.system ?? defaults.system,
      no_mmap: parsed.no_mmap ?? defaults.no_mmap,
    };
  } catch {
    return defaults;
  }
}

/** Delete the sidecar JSON so defaults take over on next read. */
export function resetModelConfig(
  modelsDir: string,
  ggufFileName: string,
): ModelSettings {
  const configPath = configPathForModel(modelsDir, ggufFileName);
  try {
    fs.unlinkSync(configPath);
    console.log(`[modelConfig] Reset config: ${configPath}`);
  } catch {
    // already absent
  }
  return getDefaultsForFile(ggufFileName);
}
