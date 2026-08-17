// ── Model configuration ──
// Defines the per-model `ModelSettings` shape. Defaults live in
// `modelCatalog.ts` (one `defaults` block per entry); a JSON sidecar in
// MODELS_DIR may override individual fields per user.
//
// `readModelConfig` returns the layered result: catalog defaults + sidecar
// overrides. `writeModelConfig` persists a full snapshot of the effective
// settings. `resetModelConfig` deletes the sidecar so defaults take over again.
//
// For API models (source "api"), configuration (API key, model name, tuning
// overrides) is stored in a single api-config.json in DATA_DIR.

import * as fs from "fs";
import * as path from "path";
import {
  getModelByFileName,
  isLegacySystemPrompt,
  BASE_SYSTEM_PROMPT,
} from "./modelCatalog.js";

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

/** API model configuration stored in DATA_DIR/api-config.json. */
export interface ApiConfig {
  apiKey: string;
  model: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  num_predict?: number;
}

/** Custom GGUF model configuration stored in DATA_DIR/custom-gguf-config.json. */
export interface CustomGgufConfig {
  ggufPath: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  repeat_penalty?: number;
  num_predict?: number;
  num_ctx?: number;
  no_mmap?: boolean;
}

const DATA_DIR =
  process.env.DATA_DIR ??
  path.resolve(path.dirname(new URL(import.meta.url).pathname), "../data");
const API_CONFIG_PATH = path.join(DATA_DIR, "api-config.json");
const CUSTOM_GGUF_CONFIG_PATH = path.join(DATA_DIR, "custom-gguf-config.json");

/** Fallback used only when a fileName has no catalog entry (shouldn't normally
 *  happen — routes validate against the catalog before calling these). */
const HARD_DEFAULTS: ModelSettings = {
  num_ctx: 8192,
  num_predict: 4096,
  temperature: 0.1,
  top_p: 0.8,
  top_k: 20,
  repeat_penalty: 1.05,
  system: BASE_SYSTEM_PROMPT,
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
export function configPathForModel(
  modelsDir: string,
  ggufFileName: string,
): string {
  const base = ggufFileName.replace(/\.gguf$/i, "");
  return path.join(modelsDir, `${base}.json`);
}

// ── API config persistence ──

function ensureDataDir(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch {}
}

/** Read API model configuration from disk. Returns null if not configured. */
export function readApiConfig(): ApiConfig | null {
  try {
    const raw = fs.readFileSync(API_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as ApiConfig;
  } catch {
    return null;
  }
}

/** Write API model configuration to disk. */
export function writeApiConfig(config: ApiConfig): void {
  ensureDataDir();
  const existing = readApiConfig();
  const merged: ApiConfig = { ...existing, ...config };
  fs.writeFileSync(API_CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n");
}

/** Check whether any API model is configured. */
export function hasApiConfig(): boolean {
  const cfg = readApiConfig();
  return !!cfg?.apiKey;
}

/** Delete the API config file entirely. */
export function deleteApiConfig(): void {
  try {
    fs.unlinkSync(API_CONFIG_PATH);
  } catch {}
}

// ── Custom GGUF config persistence ──

/** Read Custom GGUF model configuration from disk. Returns null if not configured. */
export function readCustomGgufConfig(): CustomGgufConfig | null {
  try {
    const raw = fs.readFileSync(CUSTOM_GGUF_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as CustomGgufConfig;
  } catch {
    return null;
  }
}

/** Write Custom GGUF model configuration to disk. */
export function writeCustomGgufConfig(config: Partial<CustomGgufConfig>): void {
  ensureDataDir();
  const existing = readCustomGgufConfig();
  const merged: CustomGgufConfig = {
    ...existing,
    ...config,
  } as CustomGgufConfig;
  fs.writeFileSync(
    CUSTOM_GGUF_CONFIG_PATH,
    JSON.stringify(merged, null, 2) + "\n",
  );
}

/** Check whether a custom GGUF model is configured. */
export function hasCustomGgufConfig(): boolean {
  const cfg = readCustomGgufConfig();
  if (!cfg?.ggufPath) return false;
  try {
    return fs.existsSync(cfg.ggufPath);
  } catch {
    return false;
  }
}

/** Delete the Custom GGUF config file entirely. */
export function deleteCustomGgufConfig(): void {
  try {
    fs.unlinkSync(CUSTOM_GGUF_CONFIG_PATH);
  } catch {}
}

/** Get the resolved GGUF file path for a custom GGUF model, or null if not configured. */
export function getCustomGgufPath(): string | null {
  const cfg = readCustomGgufConfig();
  if (!cfg?.ggufPath) return null;
  return cfg.ggufPath;
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
  const entry = getModelByFileName(ggufFileName);
  if (entry?.source === "api") {
    const apiCfg = readApiConfig() || { apiKey: "", model: "deepseek-chat" };
    writeApiConfig({
      ...apiCfg,
      temperature: settings.temperature,
      top_p: settings.top_p,
      top_k: settings.top_k,
      repeat_penalty: settings.repeat_penalty,
      num_predict: settings.num_predict,
    });
    return;
  }
  if (entry?.source === "custom_gguf") {
    writeCustomGgufConfig({
      temperature: settings.temperature,
      top_p: settings.top_p,
      top_k: settings.top_k,
      repeat_penalty: settings.repeat_penalty,
      num_predict: settings.num_predict,
      num_ctx: settings.num_ctx,
      no_mmap: settings.no_mmap,
    });
    return;
  }
  const configPath = configPathForModel(modelsDir, ggufFileName);
  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`[modelConfig] Wrote config: ${configPath}`);
}

/**
 * Read model settings: catalog defaults overlaid with any sidecar JSON.
 * Returns catalog defaults when no sidecar exists (no write side-effect).
 * For API models, reads from api-config.json overlaid on catalog defaults.
 */
export function readModelConfig(
  modelsDir: string,
  ggufFileName: string,
): ModelSettings {
  const entry = getModelByFileName(ggufFileName);
  if (entry?.source === "api") {
    const defaults = entry.defaults;
    const apiCfg = readApiConfig();
    return {
      num_ctx: defaults.num_ctx,
      num_predict: apiCfg?.num_predict ?? defaults.num_predict,
      temperature: apiCfg?.temperature ?? defaults.temperature,
      top_p: apiCfg?.top_p ?? defaults.top_p,
      top_k: apiCfg?.top_k ?? defaults.top_k,
      repeat_penalty: apiCfg?.repeat_penalty ?? defaults.repeat_penalty,
      system: defaults.system,
      no_mmap: false,
    };
  }

  if (entry?.source === "custom_gguf") {
    const defaults = entry.defaults;
    const cfg = readCustomGgufConfig();
    return {
      num_ctx: cfg?.num_ctx ?? defaults.num_ctx,
      num_predict: cfg?.num_predict ?? defaults.num_predict,
      temperature: cfg?.temperature ?? defaults.temperature,
      top_p: cfg?.top_p ?? defaults.top_p,
      top_k: cfg?.top_k ?? defaults.top_k,
      repeat_penalty: cfg?.repeat_penalty ?? defaults.repeat_penalty,
      system: defaults.system,
      no_mmap: cfg?.no_mmap ?? defaults.no_mmap,
    };
  }

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
      // A pinned copy of a former default must not outlive it; a prompt the
      // user actually wrote is theirs to keep.
      system: isLegacySystemPrompt(parsed.system)
        ? defaults.system
        : (parsed.system ?? defaults.system),
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
  const entry = getModelByFileName(ggufFileName);
  if (entry?.source === "api") {
    const apiCfg = readApiConfig();
    if (apiCfg) {
      writeApiConfig({
        apiKey: apiCfg.apiKey,
        model: apiCfg.model,
      });
    }
    return getDefaultsForFile(ggufFileName);
  }

  if (entry?.source === "custom_gguf") {
    const cfg = readCustomGgufConfig();
    if (cfg?.ggufPath) {
      writeCustomGgufConfig({ ggufPath: cfg.ggufPath });
    }
    return getDefaultsForFile(ggufFileName);
  }

  const configPath = configPathForModel(modelsDir, ggufFileName);
  try {
    fs.unlinkSync(configPath);
    console.log(`[modelConfig] Reset config: ${configPath}`);
  } catch {
    // already absent
  }
  return getDefaultsForFile(ggufFileName);
}
