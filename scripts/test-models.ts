#!/usr/bin/env node
/**
 * Model Benchmark Test Script
 *
 * Runs each installed model against the sample texts (copy-edit and line-edit variants)
 * and measures: corrections found, false positives on clean texts, and runtime.
 *
 * Prerequisites:
 *   - Backend server running on http://127.0.0.1:4000
 *   - At least one model installed in backend/models/
 *
 * Usage:
 *   npx tsx scripts/test-models.ts            # Resume (skip already-completed)
 *   npx tsx scripts/test-models.ts --clean    # Start fresh (wipe previous results)
 *   npx tsx scripts/test-models.ts --max-size 15  # Only run models ≤ 15 GB
 *   npx tsx scripts/test-models.ts --test     # Quick sanity check (smallest model, english_copy_edit only)
 */

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const API = "http://127.0.0.1:4000/api";
const SAMPLE_DIR = join(__dirname, "..", "sample_texts");
const RESULTS_PATH = join(SAMPLE_DIR, "benchmark_results.json");
const REPORT_PATH = join(SAMPLE_DIR, "benchmark_results.txt");

const POLL_INTERVAL = 3000;
const TASK_TIMEOUT = 3_600_000; // 1 hour

const CLEAN_RUN = process.argv.includes("--clean");
const TEST_MODE = process.argv.includes("--test");

function parseMaxSize(): number | null {
  const idx = process.argv.indexOf("--max-size");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  const val = parseFloat(process.argv[idx + 1]);
  return isNaN(val) ? null : val;
}
const MAX_SIZE_GB = parseMaxSize();

interface TestFile {
  path: string;
  filename: string;
  language: string;
  variant: "correct" | "copy_edit" | "line_edit";
}

interface TestResult {
  model: string;
  file: string;
  language: string;
  variant: string;
  mode: "copy_edit" | "line_edit";
  correctionsFound: number;
  runtimeMs: number;
  corrections: { original: string; corrected: string }[];
  errors: string[];
  runDate: string;
}

// ── Persistence ──

function loadResults(): TestResult[] {
  if (CLEAN_RUN || !existsSync(RESULTS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(RESULTS_PATH, "utf-8"));
  } catch {
    return [];
  }
}

function saveResults(results: TestResult[]): void {
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2), "utf-8");
}

function resultKey(model: string, file: string, mode: string): string {
  return `${model}::${file}::${mode}`;
}

// ── Helpers ──

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function uploadText(filename: string, content: string): Promise<string> {
  const blob = new Blob([content], { type: "text/plain" });
  const form = new FormData();
  form.append("file", blob, filename);

  const res = await fetch(`${API}/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = (await res.json()) as { id: string };
  return data.id;
}

async function waitForTask(taskId: string): Promise<{
  status: string;
  corrections: { original: string; corrected: string }[];
  errors: string[];
}> {
  const start = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - start < TASK_TIMEOUT) {
    try {
      const task = (await api("GET", `/results/${taskId}`)) as {
        status: string;
        result: {
          corrections: { original: string; corrected: string }[];
          errors: string[];
        } | null;
      };

      consecutiveErrors = 0; // reset on success

      if (task.status === "done" || task.status === "error") {
        return {
          status: task.status,
          corrections: task.result?.corrections ?? [],
          errors: task.result?.errors ?? [],
        };
      }
    } catch (err) {
      consecutiveErrors++;
      // Backend may be restarting (model load, file-watcher). Tolerate up to
      // 10 consecutive failures (~30s) before giving up.
      if (consecutiveErrors > 10) {
        throw new Error(
          `Lost connection to backend after ${consecutiveErrors} retries: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`Task ${taskId} timed out after ${TASK_TIMEOUT / 1000}s`);
}

// ── Discover sample files ──

function discoverFiles(): TestFile[] {
  const files: TestFile[] = [];
  for (const f of readdirSync(SAMPLE_DIR)) {
    if (!f.endsWith(".md")) continue;
    const parts = f.replace(".md", "").split("_");
    const language = parts[0];
    const variant = parts.slice(1).join("_") as TestFile["variant"];
    if (!["correct", "copy_edit", "line_edit"].includes(variant)) continue;
    files.push({
      path: join(SAMPLE_DIR, f),
      filename: f,
      language,
      variant,
    });
  }
  return files.sort((a, b) => a.filename.localeCompare(b.filename));
}

// ── Main ──

async function main() {
  console.log("=== Bethaniel Model Benchmark ===\n");
  console.log(
    CLEAN_RUN
      ? "Mode: CLEAN RUN (previous results wiped)"
      : "Mode: RESUME (skipping completed)",
  );
  console.log("");

  // Check server is up
  try {
    await fetch(`${API.replace("/api", "")}/health`);
  } catch {
    console.error(
      "ERROR: Backend server not reachable at http://127.0.0.1:4000",
    );
    console.error("Start it with: cd backend && npm start");
    process.exit(1);
  }

  // Get installed models — only consider models listed in the catalog JSON
  const modelData = (await api("GET", "/models")) as { models: string[] };
  const catalogData = (await api("GET", "/models/catalog")) as {
    catalog: { fileName: string }[];
  };
  const catalogFileNames = new Set(catalogData.catalog.map((c) => c.fileName));
  let models = modelData.models.filter((m) => catalogFileNames.has(m));
  if (models.length === 0) {
    console.error("ERROR: No catalog models found in backend/models/");
    process.exit(1);
  }

  const MODELS_DIR = join(__dirname, "..", "backend", "models");

  // Best-effort size lookup for non-GGUF models via Ollama tags.
  let ollamaSizes = new Map<string, number>();
  try {
    const ollamaHost = process.env.OLLAMA_HOST ?? "http://localhost:11434";
    const tagsRes = await fetch(`${ollamaHost}/api/tags`);
    if (tagsRes.ok) {
      const tagsData = (await tagsRes.json()) as {
        models: { name: string; size: number }[];
      };
      for (const m of tagsData.models) {
        ollamaSizes.set(m.name, m.size / 1024 ** 3);
      }
    }
  } catch {
    // Ollama may not be running; GGUF sizes still work from disk stats.
  }

  const modelSizeGb = (model: string): number | null => {
    const modelPath = join(MODELS_DIR, model);
    if (model.endsWith(".gguf") && existsSync(modelPath)) {
      return statSync(modelPath).size / 1024 ** 3;
    }
    if (ollamaSizes.has(model)) {
      return ollamaSizes.get(model)!;
    }
    return null;
  };

  // Always benchmark from smallest to largest so quick models finish first.
  // Unknown-size models are placed last (alphabetically) as a deterministic fallback.
  models = [...models].sort((a, b) => {
    const sa = modelSizeGb(a);
    const sb = modelSizeGb(b);
    if (sa === null && sb === null) return a.localeCompare(b);
    if (sa === null) return 1;
    if (sb === null) return -1;
    if (sa !== sb) return sa - sb;
    return a.localeCompare(b);
  });

  // Filter by size if --max-size specified
  if (MAX_SIZE_GB !== null) {
    const filtered: string[] = [];
    for (const m of models) {
      const sizeGb = modelSizeGb(m);
      if (sizeGb === null) {
        // Can't determine size — include with warning
        console.log(`  Including ${m} (size unknown)`);
        filtered.push(m);
        continue;
      }
      if (sizeGb <= MAX_SIZE_GB) {
        filtered.push(m);
      } else {
        console.log(
          `  Skipping ${m} (${sizeGb.toFixed(1)} GB > ${MAX_SIZE_GB} GB limit)`,
        );
      }
    }
    models = filtered;
    if (models.length === 0) {
      console.error(`ERROR: No models ≤ ${MAX_SIZE_GB} GB found`);
      process.exit(1);
    }
  }

  // --test: only smallest model
  if (TEST_MODE) {
    models = [models[0]];
    console.log(`TEST MODE: using smallest model only`);
  }

  console.log(`Models: ${models.join(", ")}`);
  if (MAX_SIZE_GB !== null) console.log(`  (filtered to ≤ ${MAX_SIZE_GB} GB)`);

  // Discover sample texts
  let testFiles = discoverFiles();
  // --test: only english_copy_edit.md
  if (TEST_MODE) {
    testFiles = testFiles.filter((f) => f.filename === "english_copy_edit.md");
  }

  console.log(`Sample files found: ${testFiles.length}`);
  console.log(
    `Languages: ${[...new Set(testFiles.map((f) => f.language))].join(", ")}\n`,
  );

  // Load existing results (or start fresh)
  const results: TestResult[] = loadResults();
  const completedKeys = new Set(
    results.map((r) => resultKey(r.model, r.file, r.mode)),
  );

  let skipped = 0;

  for (const model of models) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`MODEL: ${model}`);
    console.log(`${"─".repeat(60)}`);

    for (const file of testFiles) {
      const content = readFileSync(file.path, "utf-8");

      // Determine which edit mode to run:
      // - correct files: run both copy_edit and line_edit (to check false positives)
      // - copy_edit files: run copy_edit
      // - line_edit files: run line_edit
      const modesToRun: ("copy_edit" | "line_edit")[] =
        file.variant === "correct"
          ? ["copy_edit", "line_edit"]
          : file.variant === "copy_edit"
            ? ["copy_edit"]
            : ["line_edit"];

      for (const mode of modesToRun) {
        const key = resultKey(model, file.filename, mode);

        // Skip if already completed
        if (completedKeys.has(key)) {
          skipped++;
          continue;
        }

        const label = `${file.filename} [${mode}]`;
        process.stdout.write(`  ${label} ... `);

        // Upload text
        const docId = await uploadText(file.filename, content);

        // Build edit options
        const editOptions =
          mode === "copy_edit"
            ? {
                spelling: true,
                punctuation: true,
                capitalization: true,
                duplicateWords: true,
                englishDialect: "american" as const,
                oxfordComma: true,
                dialogueTags: false,
              }
            : {
                awkwardPhrasing: true,
                redundancy: true,
                weakVerbs: true,
                cliches: true,
                showDontTell: true,
                sentenceRhythm: true,
                dialogueNaturalness: true,
                tightenProse: true,
              };

        const startTime = Date.now();

        // Submit task
        const queueRes = (await api("POST", "/queue/add", {
          docId,
          units: [{ name: file.filename, original: content }],
          model,
          modes: [mode],
          editOptions,
        })) as { jobId: string; taskIds: string[] };

        const taskId = queueRes.taskIds[0];

        // Wait for completion
        const taskResult = await waitForTask(taskId);
        const elapsed = Date.now() - startTime;

        const count = taskResult.corrections.length;
        const status =
          taskResult.status === "done" ? `${count} corrections` : `ERROR`;
        console.log(`${status} (${(elapsed / 1000).toFixed(1)}s)`);

        if (taskResult.errors.length > 0) {
          console.log(`    ⚠ Errors: ${taskResult.errors.join("; ")}`);
        }

        const result: TestResult = {
          model,
          file: file.filename,
          language: file.language,
          variant: file.variant,
          mode,
          correctionsFound: count,
          runtimeMs: elapsed,
          corrections: taskResult.corrections,
          errors: taskResult.errors,
          runDate: new Date().toISOString(),
        };

        results.push(result);
        completedKeys.add(key);

        // Save after each task (incremental)
        saveResults(results);
        writeFileSync(REPORT_PATH, buildReport(results, models), "utf-8");

        // Clean up the uploaded doc
        await api("DELETE", `/documents/${docId}`).catch(() => {});
      }
    }
  }

  if (skipped > 0) {
    console.log(`\n  (Skipped ${skipped} already-completed tasks)`);
  }

  // Final report write (include models from results that may not be currently installed)
  const allModels = [...new Set([...models, ...results.map((r) => r.model)])];
  const report = buildReport(results, allModels);
  writeFileSync(REPORT_PATH, report, "utf-8");
  console.log(`\n\n${"═".repeat(60)}`);
  console.log(`Results saved to: ${REPORT_PATH}`);
  console.log(`${"═".repeat(60)}`);
  console.log(report);
}

function buildReport(results: TestResult[], models: string[]): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();
  const languages = [...new Set(results.map((r) => r.language))].sort();

  lines.push(`BETHANIEL MODEL BENCHMARK RESULTS`);
  lines.push(`Report generated: ${timestamp}`);
  lines.push(`${"═".repeat(80)}\n`);

  for (const model of models) {
    const modelResults = results.filter((r) => r.model === model);
    if (modelResults.length === 0) continue;
    lines.push(`\n${"═".repeat(80)}`);
    lines.push(`MODEL: ${model}`);
    lines.push(`${"═".repeat(80)}`);

    for (const lang of languages) {
      const langResults = modelResults.filter((r) => r.language === lang);
      if (langResults.length === 0) continue;

      lines.push(
        `\n  ┌─ ${lang.toUpperCase()} ${"─".repeat(70 - lang.length)}`,
      );
      lines.push(
        `  │ ${"File".padEnd(35)} ${"Mode".padEnd(12)} ${"Found".padEnd(7)} ${"Expected".padEnd(10)} ${"Time".padEnd(8)} ${"Run Date"}`,
      );
      lines.push(
        `  │ ${"─".repeat(35)} ${"─".repeat(12)} ${"─".repeat(7)} ${"─".repeat(10)} ${"─".repeat(8)} ${"─".repeat(19)}`,
      );

      let langCorrect = 0;
      let langFalsePos = 0;
      let langExpected = 0;
      let langTime = 0;

      for (const r of langResults) {
        const expected = r.variant === "correct" ? 0 : 10;
        const timeStr = `${(r.runtimeMs / 1000).toFixed(1)}s`;
        const dateStr = r.runDate
          ? r.runDate.slice(0, 19).replace("T", " ")
          : "unknown";
        lines.push(
          `  │ ${r.file.padEnd(35)} ${r.mode.padEnd(12)} ${String(r.correctionsFound).padEnd(7)} ${String(expected).padEnd(10)} ${timeStr.padEnd(8)} ${dateStr}`,
        );

        if (r.variant === "correct") {
          langFalsePos += r.correctionsFound;
        } else {
          langCorrect += r.correctionsFound;
          langExpected += expected;
        }
        langTime += r.runtimeMs;
      }

      lines.push(`  │`);
      lines.push(
        `  │ Corrections: ${langCorrect} / ${langExpected} expected | False positives: ${langFalsePos} | Time: ${(langTime / 1000).toFixed(1)}s`,
      );
      lines.push(`  └${"─".repeat(78)}`);
    }

    // Model-wide totals
    let totalCorrect = 0;
    let totalFalsePos = 0;
    let totalExpected = 0;
    let totalTime = 0;
    for (const r of modelResults) {
      if (r.variant === "correct") {
        totalFalsePos += r.correctionsFound;
      } else {
        totalCorrect += r.correctionsFound;
        totalExpected += r.variant === "correct" ? 0 : 10;
      }
      totalTime += r.runtimeMs;
    }

    lines.push(`\n  MODEL TOTALS:`);
    lines.push(
      `    True corrections found: ${totalCorrect} / ${totalExpected} expected`,
    );
    lines.push(`    False positives (clean texts): ${totalFalsePos}`);
    lines.push(`    Total runtime: ${(totalTime / 1000).toFixed(1)}s`);
    lines.push(
      `    Avg time per task: ${(totalTime / modelResults.length / 1000).toFixed(1)}s`,
    );
  }

  // ── Cross-model language comparison ──
  if (models.length > 1 && languages.length > 0) {
    lines.push(`\n\n${"═".repeat(80)}`);
    lines.push(`CROSS-MODEL COMPARISON BY LANGUAGE`);
    lines.push(`${"═".repeat(80)}\n`);

    lines.push(
      `  ${"Language".padEnd(12)} ${"Model".padEnd(45)} ${"Correct".padEnd(10)} ${"FP".padEnd(5)} ${"Time"}`,
    );
    lines.push(
      `  ${"─".repeat(12)} ${"─".repeat(45)} ${"─".repeat(10)} ${"─".repeat(5)} ${"─".repeat(8)}`,
    );

    for (const lang of languages) {
      for (const model of models) {
        const subset = results.filter(
          (r) => r.model === model && r.language === lang,
        );
        if (subset.length === 0) continue;
        let correct = 0,
          fp = 0,
          time = 0;
        for (const r of subset) {
          if (r.variant === "correct") fp += r.correctionsFound;
          else correct += r.correctionsFound;
          time += r.runtimeMs;
        }
        const modelShort =
          model.length > 43 ? model.slice(0, 40) + "..." : model;
        lines.push(
          `  ${lang.padEnd(12)} ${modelShort.padEnd(45)} ${String(correct).padEnd(10)} ${String(fp).padEnd(5)} ${(time / 1000).toFixed(1)}s`,
        );
      }
    }
  }

  // ── Detailed corrections list ──
  lines.push(`\n\n${"═".repeat(80)}`);
  lines.push(`DETAILED CORRECTIONS`);
  lines.push(`${"═".repeat(80)}`);

  for (const r of results) {
    if (r.corrections.length === 0) continue;
    const dateStr = r.runDate ? r.runDate.slice(0, 19).replace("T", " ") : "";
    lines.push(`\n[${r.model}] ${r.file} (${r.mode}) — ${dateStr}:`);
    for (const c of r.corrections) {
      const orig =
        c.original.length > 60 ? c.original.slice(0, 57) + "..." : c.original;
      const corr =
        c.corrected.length > 60
          ? c.corrected.slice(0, 57) + "..."
          : c.corrected;
      lines.push(`  "${orig}" → "${corr}"`);
    }
  }

  lines.push(`\n\n── END OF REPORT ──\n`);
  return lines.join("\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
