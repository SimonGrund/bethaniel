// ── Model configuration from modelfile ──
// Parses the Ollama-style modelfile and writes per-model JSON configs
// into the models directory. llamaServer.ts and llm.ts read these at runtime.

import * as fs from "fs";
import * as path from "path";

export interface ModelSettings {
  num_ctx: number;
  num_predict: number;
  temperature: number;
  system: string;
}

const DEFAULTS: ModelSettings = {
  num_ctx: 8192,
  num_predict: 8192,
  temperature: 0,
  system: "You are a meticulous copy editor. /no_think",
};

/**
 * Parse an Ollama-style modelfile into structured settings.
 * Supports PARAMETER and SYSTEM directives; ignores FROM and comments.
 */
export function parseModelfile(content: string): ModelSettings {
  const settings: ModelSettings = { ...DEFAULTS };

  const lines = content.split("\n");
  let inSystem = false;
  const systemLines: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();

    // Multi-line SYSTEM block: SYSTEM """..."""
    if (inSystem) {
      if (line.endsWith('"""')) {
        systemLines.push(line.slice(0, -3));
        settings.system = systemLines.join("\n").trim();
        inSystem = false;
      } else {
        systemLines.push(line);
      }
      continue;
    }

    if (line.startsWith("#") || line === "") continue;

    if (line.toUpperCase().startsWith("PARAMETER")) {
      const rest = line.slice("PARAMETER".length).trim();
      const spaceIdx = rest.indexOf(" ");
      if (spaceIdx === -1) continue;
      const key = rest.slice(0, spaceIdx).toLowerCase();
      const val = rest.slice(spaceIdx + 1).trim();

      if (key === "num_ctx")
        settings.num_ctx = parseInt(val, 10) || DEFAULTS.num_ctx;
      else if (key === "num_predict")
        settings.num_predict = parseInt(val, 10) || DEFAULTS.num_predict;
      else if (key === "temperature")
        settings.temperature = parseFloat(val) ?? DEFAULTS.temperature;
    } else if (line.toUpperCase().startsWith("SYSTEM")) {
      const rest = line.slice("SYSTEM".length).trim();
      if (rest.startsWith('"""')) {
        const afterOpen = rest.slice(3);
        if (afterOpen.endsWith('"""')) {
          // Single-line: SYSTEM """text"""
          settings.system = afterOpen.slice(0, -3).trim();
        } else {
          // Multi-line start
          inSystem = true;
          systemLines.length = 0;
          if (afterOpen) systemLines.push(afterOpen);
        }
      } else {
        // Simple: SYSTEM some text
        settings.system = rest;
      }
    }
    // Ignore FROM and unknown directives
  }

  return settings;
}

/**
 * Config JSON path for a given GGUF file.
 * E.g. "gemma-3n-E4B-it-Q4_K_M.gguf" → "gemma-3n-E4B-it-Q4_K_M.json"
 */
function configPathForModel(modelsDir: string, ggufFileName: string): string {
  const base = ggufFileName.replace(/\.gguf$/i, "");
  return path.join(modelsDir, `${base}.json`);
}

/**
 * Write model settings JSON alongside the GGUF file.
 * Called after a model is downloaded.
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
 * Read model settings for a given GGUF. Returns defaults if no config exists.
 */
export function readModelConfig(
  modelsDir: string,
  ggufFileName: string,
): ModelSettings {
  const configPath = configPathForModel(modelsDir, ggufFileName);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      num_ctx: parsed.num_ctx ?? DEFAULTS.num_ctx,
      num_predict: parsed.num_predict ?? DEFAULTS.num_predict,
      temperature: parsed.temperature ?? DEFAULTS.temperature,
      system: parsed.system ?? DEFAULTS.system,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Parse the project modelfile and write config for a model.
 * `modelfilePath` — path to the modelfile (in project root or resources).
 */
export function applyModelfile(
  modelfilePath: string,
  modelsDir: string,
  ggufFileName: string,
): ModelSettings {
  let content: string;
  try {
    content = fs.readFileSync(modelfilePath, "utf-8");
  } catch {
    console.log(
      `[modelConfig] No modelfile at ${modelfilePath}, using defaults`,
    );
    const settings = { ...DEFAULTS };
    writeModelConfig(modelsDir, ggufFileName, settings);
    return settings;
  }
  const settings = parseModelfile(content);
  writeModelConfig(modelsDir, ggufFileName, settings);
  return settings;
}
