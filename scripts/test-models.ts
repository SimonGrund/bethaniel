#!/usr/bin/env node
/**
 * Model Benchmark Test Script
 *
 * Runs each installed model against the sample texts (copy-edit and line-edit
 * variants) and scores it on RECALL (did it catch the deliberately planted
 * errors?), PRECISION (did it invent problems that aren't there?), a
 * false-positive rate on already-clean text, consistency across repeated
 * runs of the same task, and a time score — combined into one overall
 * weighted score per mode (copy_edit / line_edit) and per model.
 *
 * Ground truth is NOT hardcoded. sample_texts/{lang}_correct.md and
 * {lang}_{copy_edit,line_edit}.md are near-identical prose except for
 * deliberately planted errors — buildGroundTruth (backend/src/benchScoring.ts)
 * diffs each pair once to recover the exact planted-error set, replacing the
 * old "assume every non-clean file has 10 errors" guess.
 *
 * Prerequisites:
 *   - Backend server running on http://127.0.0.1:4000
 *   - At least one model installed in backend/models/
 *
 * Usage:
 *   npx tsx scripts/test-models.ts            # Resume (skip already-completed)
 *   npx tsx scripts/test-models.ts --clean    # Start fresh (wipe previous results)
 *   npx tsx scripts/test-models.ts --max-size 15  # Only run models ≤ 15 GB
 *   npx tsx scripts/test-models.ts --model 9b     # Only run models whose filename contains "9b" (case-insensitive)
 *   npx tsx scripts/test-models.ts --max-parallel 1  # Cap concurrent task dispatch (avoids batched-decode variance/reload contention)
 *   npx tsx scripts/test-models.ts --test     # Quick sanity check (smallest model, english_copy_edit only)
 *   npx tsx scripts/test-models.ts --en        # Only run English texts
 *   npx tsx scripts/test-models.ts --da --de   # Only Danish and German
 *   npx tsx scripts/test-models.ts --repeat 1  # Skip the consistency re-run (faster, no consistency score)
 *   npx tsx scripts/test-models.ts --report-only  # Recompute + reprint the report from saved results, no new runs
 *   npx tsx scripts/test-models.ts --mode line_edit  # Only run line_edit (skips *_copy_edit.md entirely)
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
import {
  buildGroundTruth,
  recallByCategory,
  scoreCorrections,
  consistencyScore,
  timeScore as computeTimeScore,
  falsePositiveCleanScore,
  overallScore,
  type PlantedError,
  type ScoredCorrection,
  type WordChecks,
} from "../backend/src/benchScoring.js";
import { getWordValidator } from "../backend/src/spellcheck.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Overridable so a benchmark can target a second backend on another port —
// the dev backend on 4000 is usually forked under the open Electron app, and
// restarting it to pick up a change takes the app down with it.
const API = process.env.BENCH_API ?? "http://127.0.0.1:4000/api";
const SAMPLE_DIR = join(__dirname, "..", "sample_texts");
const RESULTS_PATH = join(SAMPLE_DIR, "benchmark_results.json");
const REPORT_PATH = join(SAMPLE_DIR, "benchmark_results.txt");

const POLL_INTERVAL = 3000;
const TASK_TIMEOUT = 3_600_000; // 1 hour

const CLEAN_RUN = process.argv.includes("--clean");
const TEST_MODE = process.argv.includes("--test");
const REPORT_ONLY = process.argv.includes("--report-only");

function parseRepeat(): number {
  const idx = process.argv.indexOf("--repeat");
  if (idx === -1 || idx + 1 >= process.argv.length) return 2;
  const val = parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(val) && val >= 1 ? val : 2;
}
// Repeat >1 is what makes the consistency score possible — the seeding work
// (deriveSeed in llm.ts) should make local models converge on the SAME
// corrections across repeats; a low consistency score here means the
// quality numbers above it were a lucky/unlucky roll, not something to trust.
const REPEAT = TEST_MODE ? 1 : parseRepeat();

const LANG_FLAGS: Record<string, string> = {
  "--en": "english",
  "--da": "danish",
  "--de": "german",
  "--es": "spanish",
  // Not a real language — a separate, larger English stress fixture
  // (stress100_correct.md / stress100_copy_edit.md) with 100 planted
  // copy-edit errors across every category the copy-edit prompt covers, for
  // a higher-confidence recall read than the ~9-15-error standard fixtures.
  "--stress": "stress100",
};
const SELECTED_LANGS = Object.entries(LANG_FLAGS)
  .filter(([flag]) => process.argv.includes(flag))
  .map(([, lang]) => lang);
// Empty means all languages

/** Map sample-text language name to ISO code for the manuscriptLang API param. */
const LANG_CODE: Record<string, string> = {
  english: "en",
  danish: "da",
  german: "de",
  spanish: "es",
  stress100: "en",
};

function parseMaxSize(): number | null {
  const idx = process.argv.indexOf("--max-size");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  const val = parseFloat(process.argv[idx + 1]);
  return isNaN(val) ? null : val;
}
const MAX_SIZE_GB = parseMaxSize();

function parseModel(): string | null {
  const idx = process.argv.indexOf("--model");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}
// Case-insensitive substring match against the catalog fileName — lets you
// pass a short name ("4b", "9b") instead of the full .gguf filename.
const MODEL_FILTER = parseModel();

function parseMaxParallel(): number | null {
  const idx = process.argv.indexOf("--max-parallel");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  const val = parseInt(process.argv[idx + 1], 10);
  return Number.isFinite(val) && val >= 1 ? val : null;
}
// Caps concurrent submissions below the backend's own recommendation — useful
// if a heavier model (e.g. a 24B model) is crashing/becoming unreachable
// under the backend's recommended parallel slot count on this machine.
const MAX_PARALLEL = parseMaxParallel();

function parseModeFilter(): "copy_edit" | "line_edit" | null {
  const idx = process.argv.indexOf("--mode");
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  const val = process.argv[idx + 1];
  return val === "copy_edit" || val === "line_edit" ? val : null;
}
// Restrict to one mode (e.g. --mode line_edit) — skips the *_copy_edit.md
// fixture entirely and only runs the *_correct.md / *_line_edit.md pair,
// useful when benchmarking line-edit quality specifically.
const MODE_FILTER = parseModeFilter();

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
  repeatIndex: number;
  correctionsFound: number;
  runtimeMs: number;
  corrections: ScoredCorrection[];
  errors: string[];
  runDate: string;
}

// ── Persistence ──

function loadResults(): TestResult[] {
  if (CLEAN_RUN || !existsSync(RESULTS_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(RESULTS_PATH, "utf-8")) as TestResult[];
    // Back-compat: results saved before --repeat existed have no repeatIndex.
    return raw.map((r) => ({ repeatIndex: 1, ...r }));
  } catch {
    return [];
  }
}

function saveResults(results: TestResult[]): void {
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2), "utf-8");
}

function resultKey(model: string, file: string, mode: string, repeatIndex: number): string {
  return `${model}::${file}::${mode}::${repeatIndex}`;
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

// Tier-aware default words-per-chunk. Matches the auto-tune logic in
// frontend/src/components/ModelSelector.tsx so the benchmark exercises the
// same per-slot context budget as the real UI.
function wordsPerChunkForModel(fileName: string): number {
  const f = fileName.toLowerCase();
  // 20B+ parameter models (e.g. a custom GGUF) — smaller chunks keep prompt +
  // verbose JSON output comfortably within the per-slot context window.
  if (/24b|27b|32b|34b/.test(f)) return 1500;
  return 2000;
}

async function waitForTask(taskId: string): Promise<{
  status: string;
  corrections: ScoredCorrection[];
  errors: string[];
  editedText?: string;
}> {
  const start = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - start < TASK_TIMEOUT) {
    try {
      const task = (await api("GET", `/results/${taskId}`)) as {
        status: string;
        result: {
          corrections: ScoredCorrection[];
          errors: string[];
          editedText?: string;
        } | null;
      };

      consecutiveErrors = 0; // reset on success

      if (task.status === "done" || task.status === "error") {
        return {
          status: task.status,
          corrections: task.result?.corrections ?? [],
          errors: task.result?.errors ?? [],
          editedText: task.result?.editedText,
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

/** True for the "backend process is unreachable" family of errors — as
 *  opposed to e.g. a 4xx from the API, which is a real bug worth seeing. */
function isConnectionError(msg: string): boolean {
  return (
    msg.includes("ECONNREFUSED") ||
    msg.includes("fetch failed") ||
    msg.includes("Lost connection to backend")
  );
}

async function isBackendHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${API.replace("/api", "")}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Poll until the backend answers /health again, or give up after maxWaitMs. */
async function waitForBackendRecovery(maxWaitMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isBackendHealthy()) return true;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/** Write the final report and print it — shared by the normal completion
 *  path and the early-stop-on-dead-backend path. */
function writeFinalReport(results: TestResult[], allModels: string[]): void {
  const report = buildReport(results, allModels);
  writeFileSync(REPORT_PATH, report, "utf-8");
  console.log(`\n\n${"═".repeat(60)}`);
  console.log(`Results saved to: ${REPORT_PATH}`);
  console.log(`${"═".repeat(60)}`);
  console.log(report);
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

// ── Ground truth (diff-based, cached per language+mode) ──

const groundTruthCache = new Map<string, PlantedError[]>();

/** Planted errors for one (language, mode) pair — [] for the clean fixture. */
function groundTruthFor(
  language: string,
  mode: "copy_edit" | "line_edit",
): PlantedError[] {
  const cacheKey = `${language}:${mode}`;
  const cached = groundTruthCache.get(cacheKey);
  if (cached) return cached;

  const correctPath = join(SAMPLE_DIR, `${language}_correct.md`);
  const erroredPath = join(SAMPLE_DIR, `${language}_${mode}.md`);
  if (!existsSync(correctPath) || !existsSync(erroredPath)) {
    groundTruthCache.set(cacheKey, []);
    return [];
  }
  const correct = readFileSync(correctPath, "utf-8");
  const errored = readFileSync(erroredPath, "utf-8");
  const truth = buildGroundTruth(errored, correct);
  groundTruthCache.set(cacheKey, truth);
  return truth;
}

// ── Main ──

async function main() {
  console.log("=== Bethaniel Model Benchmark ===\n");

  if (REPORT_ONLY) {
    const results = loadResults();
    if (results.length === 0) {
      console.error(`ERROR: no saved results at ${RESULTS_PATH} to report on.`);
      process.exit(1);
    }
    const allModels = [...new Set(results.map((r) => r.model))];
    const report = buildReport(results, allModels);
    writeFileSync(REPORT_PATH, report, "utf-8");
    console.log(report);
    return;
  }

  console.log(
    CLEAN_RUN
      ? "Mode: CLEAN RUN (previous results wiped)"
      : "Mode: RESUME (skipping completed)",
  );
  console.log(
    REPEAT > 1
      ? `Repeats per task: ${REPEAT} (enables the consistency score)`
      : `Repeats per task: 1 (no consistency score — pass --repeat 2 to enable it)`,
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
    catalog: { fileName: string; sizeBytes: number }[];
  };
  const catalogFileNames = new Set(catalogData.catalog.map((c) => c.fileName));
  const catalogSizeGb = new Map(
    catalogData.catalog
      .filter((c) => c.sizeBytes > 0)
      .map((c) => [c.fileName, c.sizeBytes / 1024 ** 3]),
  );
  let models = modelData.models.filter((m) => catalogFileNames.has(m));
  if (models.length === 0) {
    console.error("ERROR: No catalog models found in backend/models/");
    process.exit(1);
  }

  const MODELS_DIR =
    process.env.MODELS_DIR ?? join(__dirname, "..", "backend", "models");

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
    // Catalog sizeBytes is the reliable source — it doesn't depend on
    // guessing where MODELS_DIR actually points (e.g. Electron's userData
    // dir vs. this script's backend/models fallback, which are usually
    // different and previously caused every model to look "unknown size"
    // and sort alphabetically instead of smallest-first).
    if (catalogSizeGb.has(model)) {
      return catalogSizeGb.get(model)!;
    }
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

  // Filter by name if --model specified (case-insensitive substring match)
  if (MODEL_FILTER !== null) {
    const needle = MODEL_FILTER.toLowerCase();
    const filtered = models.filter((m) => m.toLowerCase().includes(needle));
    if (filtered.length === 0) {
      console.error(
        `ERROR: No model filename contains "${MODEL_FILTER}". Available: ${models.join(", ")}`,
      );
      process.exit(1);
    }
    models = filtered;
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
  } else if (SELECTED_LANGS.length > 0) {
    testFiles = testFiles.filter((f) => SELECTED_LANGS.includes(f.language));
  }
  if (MODE_FILTER !== null) {
    const otherMode = MODE_FILTER === "copy_edit" ? "line_edit" : "copy_edit";
    testFiles = testFiles.filter((f) => f.variant !== otherMode);
  }

  console.log(`Sample files found: ${testFiles.length}`);
  console.log(
    `Languages: ${[...new Set(testFiles.map((f) => f.language))].join(", ")}\n`,
  );

  // Load existing results (or start fresh)
  const results: TestResult[] = loadResults();
  const completedKeys = new Set(
    results.map((r) => resultKey(r.model, r.file, r.mode, r.repeatIndex)),
  );

  let skipped = 0;

  for (const model of models) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`MODEL: ${model}`);
    console.log(`${"─".repeat(60)}`);

    // Fetch recommended parallel slots for this model from the backend
    let recommendedParallel = 1;
    try {
      const rec = (await api(
        "GET",
        `/system/recommend?model=${encodeURIComponent(model)}`,
      )) as { recommendedParallel: number };
      recommendedParallel = rec.recommendedParallel;
    } catch {
      // Fallback to 1 if endpoint unavailable
    }
    if (MAX_PARALLEL !== null && MAX_PARALLEL < recommendedParallel) {
      recommendedParallel = MAX_PARALLEL;
    }
    console.log(`  Parallel slots: ${recommendedParallel}`);

    // Collect all tasks to run for this model
    const pendingTasks: {
      file: TestFile;
      mode: "copy_edit" | "line_edit";
      repeatIndex: number;
      label: string;
    }[] = [];

    for (const file of testFiles) {
      let modesToRun: ("copy_edit" | "line_edit")[] =
        file.variant === "correct"
          ? ["copy_edit", "line_edit"]
          : file.variant === "copy_edit"
            ? ["copy_edit"]
            : ["line_edit"];
      if (MODE_FILTER !== null) {
        modesToRun = modesToRun.filter((m) => m === MODE_FILTER);
      }

      for (const mode of modesToRun) {
        // Repeats only matter for files with real content to converge on;
        // a clean file's "right answer" is always zero corrections, so one
        // run is enough to measure its false-positive rate.
        const repeats = file.variant === "correct" ? 1 : REPEAT;
        for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex++) {
          const key = resultKey(model, file.filename, mode, repeatIndex);
          if (completedKeys.has(key)) {
            skipped++;
            continue;
          }
          pendingTasks.push({
            file,
            mode,
            repeatIndex,
            label: `${file.filename} [${mode}]${repeats > 1 ? ` (run ${repeatIndex}/${repeats})` : ""}`,
          });
        }
      }
    }

    if (pendingTasks.length === 0) continue;

    // Process tasks in batches of recommendedParallel
    for (let i = 0; i < pendingTasks.length; i += recommendedParallel) {
      const batch = pendingTasks.slice(i, i + recommendedParallel);
      console.log(
        `\n  Batch ${Math.floor(i / recommendedParallel) + 1}: ${batch.map((t) => t.label).join(", ")}`,
      );

      // Submit all tasks in the batch. Upload/queue-add can fail exactly like
      // polling can (backend restarting, crashed, network blip) — wrapped the
      // same way as waitForTask below so a submission failure becomes a
      // recorded error result instead of an uncaught rejection that kills
      // the whole benchmark (and every task after it) via Promise.all.
      const submissions = await Promise.all(
        batch.map(async (task) => {
          const startTime = Date.now();
          try {
            const content = readFileSync(task.file.path, "utf-8");
            const docId = await uploadText(task.file.filename, content);

            const editOptions =
              task.mode === "copy_edit"
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

            const queueRes = (await api("POST", "/queue/add", {
              docId,
              units: [{ name: task.file.filename, original: content }],
              model,
              modes: [task.mode],
              fast: true,
              wordsPerChunk: wordsPerChunkForModel(model),
              overlapParagraphs: 1,
              parallel: recommendedParallel,
              editOptions,
              manuscriptLang: LANG_CODE[task.file.language] ?? undefined,
            })) as { jobId: string; taskIds: string[] };

            return {
              ok: true as const,
              task,
              docId,
              taskId: queueRes.taskIds[0],
              startTime,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { ok: false as const, task, error: msg, startTime };
          }
        }),
      );

      // Wait for all tasks in the batch to complete. A per-task timeout or
      // network failure must NOT abort the whole benchmark — record it as a
      // failed result and move on so the remaining models still run.
      const batchResults = await Promise.all(
        submissions.map(async (sub) => {
          if (!sub.ok) {
            return {
              task: sub.task,
              docId: undefined as string | undefined,
              startTime: sub.startTime,
              elapsed: Date.now() - sub.startTime,
              taskResult: {
                status: "error",
                corrections: [] as ScoredCorrection[],
                errors: [sub.error],
                editedText: undefined as string | undefined,
              },
            };
          }
          try {
            const taskResult = await waitForTask(sub.taskId);
            const elapsed = Date.now() - sub.startTime;
            return { ...sub, taskResult, elapsed };
          } catch (err) {
            const elapsed = Date.now() - sub.startTime;
            const msg = err instanceof Error ? err.message : String(err);
            const taskResult = {
              status: "error",
              corrections: [] as ScoredCorrection[],
              errors: [msg],
              editedText: undefined as string | undefined,
            };
            return { ...sub, taskResult, elapsed };
          }
        }),
      );

      // Process results
      for (const br of batchResults) {
        const count = br.taskResult.corrections.length;
        const status =
          br.taskResult.status === "done" ? `${count} corrections` : `ERROR`;
        console.log(
          `    ${br.task.label}: ${status} (${(br.elapsed / 1000).toFixed(1)}s)`,
        );

        if (br.taskResult.errors.length > 0) {
          console.log(`      ⚠ Errors: ${br.taskResult.errors.join("; ")}`);
        }

        const result: TestResult = {
          model,
          file: br.task.file.filename,
          language: br.task.file.language,
          variant: br.task.file.variant,
          mode: br.task.mode,
          repeatIndex: br.task.repeatIndex,
          correctionsFound: count,
          runtimeMs: br.elapsed,
          corrections: br.taskResult.corrections,
          errors: br.taskResult.errors,
          runDate: new Date().toISOString(),
        };

        results.push(result);
        completedKeys.add(
          resultKey(model, br.task.file.filename, br.task.mode, br.task.repeatIndex),
        );

        // Clean up the uploaded doc (nothing to clean up if submission
        // itself failed before a doc existed).
        if (br.docId) {
          await api("DELETE", `/documents/${br.docId}`).catch(() => {});
        }
      }

      // Save after each batch (incremental)
      saveResults(results);
      writeFileSync(REPORT_PATH, buildReport(results, models), "utf-8");

      // If the backend just died mid-batch, every remaining task — this
      // model and every model after it — will fail the exact same way.
      // Burning through the whole remaining task list logging identical
      // "connection refused" errors wastes time and pollutes the results
      // with noise. Give it a short window to come back (a restart-on-crash
      // supervisor, if any, needs a moment); if it doesn't, stop cleanly
      // with what's already been saved rather than grinding on or crashing.
      const batchHadConnectionFailure = batchResults.some((br) =>
        br.taskResult.errors.some(isConnectionError),
      );
      if (batchHadConnectionFailure && !(await isBackendHealthy())) {
        console.log(
          `\n⚠ Backend at ${API.replace("/api", "")} appears to be down. Waiting up to 60s for it to come back…`,
        );
        const recovered = await waitForBackendRecovery(60_000);
        if (!recovered) {
          console.error(
            `\n❌ Backend did not come back within 60s. Stopping here — results so far are saved.\n` +
              `   Restart the backend and re-run the same command; already-completed tasks are skipped automatically.`,
          );
          writeFinalReport(results, [...new Set([...models, ...results.map((r) => r.model)])]);
          process.exit(1);
        }
        console.log("✓ Backend is back — resuming.\n");
      }
    }
  }

  if (skipped > 0) {
    console.log(`\n  (Skipped ${skipped} already-completed tasks)`);
  }

  // Final report write (include models from results that may not be currently installed)
  writeFinalReport(results, [...new Set([...models, ...results.map((r) => r.model)])]);
}

// ── Scoring ──

interface ModeScorecard {
  mode: "copy_edit" | "line_edit";
  recall: number | null;
  precision: number;
  f1: number;
  falsePositiveClean: number;
  consistency: number | null;
  timeScoreValue: number;
  overall: number;
  avgRuntimeMs: number;
  /** Avg false positives per run that landed on a real error's span but proposed the wrong fix — reviewer-catchable. */
  avgWrongFix: number;
  /** Avg false positives per run that touched text with no planted error at all. */
  avgHallucination: number;
  /**
   * Mean of the production reviewer's own 1-5 confidence score across every
   * correction, rescaled to 0-100. Diff-based precision judges a correction
   * against ONE gold rewrite, which unfairly penalizes a different-but-valid
   * line edit — this instead reuses the same "is this actually a good edit"
   * judgment the app itself already makes (no extra LLM calls: the score is
   * already on each correction from the real review pass). null when no
   * correction in the run carries a confidence score.
   */
  avgReviewerConfidence: number | null;
  /** Share of SCORED corrections the reviewer flagged (confidence below its own threshold). Excludes unscored ones — see unscoredRate. */
  flaggedRate: number | null;
  /** Share of corrections the reviewer never scored at all (a coverage gap, not a quality judgment). */
  unscoredRate: number | null;
}

/**
 * Score one model's results for one mode, across every language tested.
 * Recall/precision/F1 average across languages AND repeats (each repeat is
 * an independent sample); consistency compares repeat 1 against repeat 2 of
 * the SAME (language, file) task, averaged across languages; the
 * false-positive-clean score comes from the *_correct.md runs specifically.
 */
function scoreModelMode(
  results: TestResult[],
  model: string,
  mode: "copy_edit" | "line_edit",
  fastestAvgMs: number,
): ModeScorecard | null {
  const erroredResults = results.filter(
    (r) => r.model === model && r.mode === mode && r.variant !== "correct" && r.errors.length === 0,
  );
  const cleanResults = results.filter(
    (r) => r.model === model && r.mode === mode && r.variant === "correct" && r.errors.length === 0,
  );
  if (erroredResults.length === 0 && cleanResults.length === 0) return null;

  // ── Recall / precision / F1, averaged per-run against that run's own
  // language's ground truth ──
  const perRunScores = erroredResults.map((r) =>
    scoreCorrections(r.corrections, groundTruthFor(r.language, mode)),
  );
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const recalls = perRunScores.map((s) => s.recall).filter((r): r is number => r !== null);
  const recall = recalls.length ? avg(recalls) : null;
  const precision = perRunScores.length ? avg(perRunScores.map((s) => s.precision)) : 100;
  const f1 = perRunScores.length ? avg(perRunScores.map((s) => s.f1)) : precision;
  const avgWrongFix = perRunScores.length
    ? avg(perRunScores.map((s) => s.falsePositiveBreakdown.wrongFix.length))
    : 0;
  const avgHallucination = perRunScores.length
    ? avg(perRunScores.map((s) => s.falsePositiveBreakdown.hallucination.length))
    : 0;

  // ── Reviewer's own confidence score, reused (not recomputed) from the
  // real review pass each correction already went through. Scoped to
  // corrections the reviewer actually SCORED — a correction can be flagged
  // for two very different reasons (the reviewer scored it low, or the
  // reviewer never got to it at all, e.g. LanguageTool/spell-check items
  // competing with a large correction list for attention) and conflating
  // them would make "100/100 avg confidence, 85% flagged" look like a
  // contradiction instead of what it actually is: most items unscored. ──
  const allCorrections = erroredResults.flatMap((r) => r.corrections) as unknown as {
    confidence?: number;
    flagged?: boolean;
  }[];
  const scored = allCorrections.filter(
    (c): c is { confidence: number; flagged?: boolean } => typeof c.confidence === "number",
  );
  const avgReviewerConfidence = scored.length
    ? ((avg(scored.map((c) => c.confidence)) - 1) / 4) * 100
    : null;
  const flaggedRate = scored.length
    ? (scored.filter((c) => c.flagged === true).length / scored.length) * 100
    : null;
  const unscoredRate = allCorrections.length
    ? ((allCorrections.length - scored.length) / allCorrections.length) * 100
    : null;

  // ── False positives on already-clean text ──
  const cleanFpCounts = cleanResults.map((r) => r.correctionsFound);
  const avgCleanFp = cleanFpCounts.length ? avg(cleanFpCounts) : 0;
  const fpClean = falsePositiveCleanScore(avgCleanFp);

  // ── Consistency: repeat 1 vs repeat 2+ of the same (language, file) ──
  const byLangFile = new Map<string, TestResult[]>();
  for (const r of erroredResults) {
    const k = `${r.language}:${r.file}`;
    (byLangFile.get(k) ?? byLangFile.set(k, []).get(k)!).push(r);
  }
  const consistencyScores: number[] = [];
  for (const runs of byLangFile.values()) {
    const byRepeat = [...runs].sort((a, b) => a.repeatIndex - b.repeatIndex);
    for (let i = 1; i < byRepeat.length; i++) {
      consistencyScores.push(consistencyScore(byRepeat[0].corrections, byRepeat[i].corrections));
    }
  }
  const consistency = consistencyScores.length ? avg(consistencyScores) : null;

  // ── Time ──
  const allRuntimes = [...erroredResults, ...cleanResults].map((r) => r.runtimeMs);
  const avgRuntimeMs = allRuntimes.length ? avg(allRuntimes) : 0;
  const timeScoreValue = computeTimeScore(avgRuntimeMs, fastestAvgMs);

  const overall = overallScore(f1, timeScoreValue);

  return {
    mode,
    recall,
    precision,
    f1,
    falsePositiveClean: fpClean,
    consistency,
    timeScoreValue,
    overall,
    avgRuntimeMs,
    avgWrongFix,
    avgHallucination,
    avgReviewerConfidence,
    flaggedRate,
    unscoredRate,
  };
}

function fmtPct(v: number | null): string {
  return v === null ? "  n/a" : `${v.toFixed(0).padStart(4)}%`;
}
function fmtScore(v: number | null): string {
  return v === null ? " n/a" : v.toFixed(0).padStart(4);
}

/** Dictionary checks for one fixture language, so the spelling bucket splits
 *  into misspelling / word choice / dialect. Null when that language has no
 *  bundled dictionary — the report then says so instead of guessing. */
const wordChecksCache = new Map<string, WordChecks | null>();
function wordChecksFor(language: string): WordChecks | null {
  const cached = wordChecksCache.get(language);
  if (cached !== undefined) return cached;
  const code = LANG_CODE[language] ?? "en";
  const own = getWordValidator(code, code === "en" ? { englishDialect: "american" } : undefined);
  // The dialect axis is English-only; every other language splits two ways.
  const other = code === "en" ? getWordValidator("en", { englishDialect: "british" }) : null;
  const checks = own ? { isKnownWord: own, isKnownInOtherDialect: other ?? undefined } : null;
  wordChecksCache.set(language, checks);
  return checks;
}

/**
 * Per-language breakdown. The headline scorecards average every language
 * together, which hides the thing most worth knowing: the deterministic
 * layers are not equally strong in every language. LanguageTool's Danish rule
 * set is thin, and the comma and dialect rules in the copy-edit prompt are
 * gated to English — so a low Danish comma number is not the same finding as
 * a low English one, and averaging them says neither.
 */
function buildLanguageSection(results: TestResult[], models: string[]): string[] {
  const lines: string[] = [];
  const languages = [...new Set(results.map((r) => r.language))].sort();
  const shortName = (m: string) => m.replace(/-Q\d.*$/, "").replace(/\.gguf$/, "");

  lines.push(`\n${"═".repeat(80)}`);
  lines.push(`BY LANGUAGE`);
  lines.push(`${"═".repeat(80)}`);
  lines.push(
    `Averaged across languages, a weak deterministic layer in one of them is`,
  );
  lines.push(`invisible. Split out, it is the first thing you see.`);

  for (const mode of ["copy_edit", "line_edit"] as const) {
    const anyForMode = results.some((r) => r.mode === mode && r.errors.length === 0);
    if (!anyForMode) continue;
    lines.push(`\n${"─".repeat(80)}`);
    lines.push(`${mode}`);
    lines.push(`${"─".repeat(80)}`);

    for (const language of languages) {
      const truth = groundTruthFor(language, mode);
      if (truth.length === 0) continue;
      lines.push(`\n  ${language} — ${truth.length} planted errors`);
      lines.push(
        `    ${"model".padEnd(26)} ${"recall".padStart(7)} ${"prec.".padStart(7)} ${"clean flags".padStart(12)}`,
      );

      const present: string[] = [];
      for (const model of models) {
        const runs = results.filter(
          (r) => r.model === model && r.language === language && r.mode === mode &&
            r.variant !== "correct" && r.errors.length === 0,
        );
        if (runs.length === 0) continue;
        present.push(model);
        const scored = runs.map((r) => scoreCorrections(r.corrections, truth));
        const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
        const recall = avg(scored.map((s) => s.recall ?? 0));
        const precision = avg(scored.map((s) => s.precision));
        const cleanRuns = results.filter(
          (r) => r.model === model && r.language === language && r.mode === mode &&
            r.variant === "correct" && r.errors.length === 0,
        );
        const cleanFlags = cleanRuns.length
          ? avg(cleanRuns.map((r) => r.corrections.filter((c) => c.original !== c.corrected).length))
          : null;
        lines.push(
          `    ${shortName(model).padEnd(26)} ${`${recall.toFixed(0)}%`.padStart(7)} ${`${precision.toFixed(0)}%`.padStart(7)} ` +
            `${(cleanFlags === null ? "n/a" : cleanFlags.toFixed(1)).padStart(12)}`,
        );
      }

      // Category split, copy_edit only — the line-edit fixtures are dense
      // paraphrasing whose planted spans all merge into one bucket, so the
      // breakdown there would be a single uninformative row.
      if (mode !== "copy_edit" || present.length === 0) continue;
      const checks = wordChecksFor(language);
      const perModel = present.map((model) => {
        const run = results.find(
          (r) => r.model === model && r.language === language && r.mode === mode &&
            r.variant !== "correct" && r.errors.length === 0,
        )!;
        return {
          model,
          rows: recallByCategory(truth, scoreCorrections(run.corrections, truth).missedErrors, checks),
        };
      });
      lines.push(
        `    ${"recall by error type".padEnd(26)} ${"planted".padStart(7)}` +
          perModel.map((m) => shortName(m.model).slice(-9).padStart(11)).join(""),
      );
      for (let i = 0; i < perModel[0].rows.length; i++) {
        const { category, planted } = perModel[0].rows[i];
        if (planted === 0) continue;
        lines.push(
          `      ${category.padEnd(24)} ${String(planted).padStart(7)}` +
            perModel.map((m) => `${(m.rows[i].recall ?? 0).toFixed(0)}%`.padStart(11)).join(""),
        );
      }
      if (!checks) {
        lines.push(`      (no dictionary for ${language} — spelling is one combined row)`);
      }
    }
  }
  return lines;
}

function buildReport(results: TestResult[], models: string[]): string {
  const lines: string[] = [];
  const timestamp = new Date().toISOString();
  const languages = [...new Set(results.map((r) => r.language))].sort();

  lines.push(`BETHANIEL MODEL BENCHMARK RESULTS`);
  lines.push(`Report generated: ${timestamp}`);
  lines.push(`${"═".repeat(80)}\n`);

  // ── Scorecards ──
  // Time score needs a reference point: the fastest model's own average
  // runtime, computed once across everything so both modes share one scale.
  const avgRuntimeByModel = new Map<string, number>();
  for (const model of models) {
    const times = results.filter((r) => r.model === model && r.errors.length === 0).map((r) => r.runtimeMs);
    if (times.length) avgRuntimeByModel.set(model, times.reduce((a, b) => a + b, 0) / times.length);
  }
  const fastestAvgMs = Math.min(...[...avgRuntimeByModel.values(), Infinity]);

  lines.push(`SCORECARDS`);
  lines.push(`${"═".repeat(80)}`);
  lines.push(
    `Weighting: overall = 80% F1(recall, precision) + 20% time score.`,
  );
  lines.push(
    `False-positive-clean and consistency are reported separately, not folded`,
  );
  lines.push(`into "overall" — they're diagnostic, not part of the headline number.\n`);

  const modelOveralls: { model: string; overall: number }[] = [];

  for (const model of models) {
    const modelResults = results.filter((r) => r.model === model);
    if (modelResults.length === 0) continue;

    lines.push(`${"─".repeat(80)}`);
    lines.push(`MODEL: ${model}`);
    lines.push(`${"─".repeat(80)}`);
    lines.push(
      `  ${"Mode".padEnd(10)} ${"Recall".padStart(6)} ${"Prec.".padStart(6)} ${"F1".padStart(5)} ${"Time".padStart(5)} ${"FP-clean".padStart(9)} ${"Consist.".padStart(9)} ${"OVERALL".padStart(8)}`,
    );

    const cards: ModeScorecard[] = [];
    for (const mode of ["copy_edit", "line_edit"] as const) {
      const card = scoreModelMode(modelResults, model, mode, fastestAvgMs);
      if (!card) continue;
      cards.push(card);
      lines.push(
        `  ${mode.padEnd(10)} ${fmtPct(card.recall)} ${fmtPct(card.precision)} ${fmtScore(card.f1)} ${fmtScore(card.timeScoreValue)} ${fmtScore(card.falsePositiveClean).padStart(9)} ${fmtScore(card.consistency).padStart(9)} ${fmtScore(card.overall).padStart(8)}`,
      );
      if (card.avgWrongFix > 0 || card.avgHallucination > 0) {
        lines.push(
          `             false positives: avg ${card.avgWrongFix.toFixed(1)} wrong-fix (right spot, wrong guess — reviewer-catchable) + avg ${card.avgHallucination.toFixed(1)} hallucinated (no error there at all)`,
        );
      }
      if (card.avgReviewerConfidence !== null) {
        // For line_edit especially: precision above judges against ONE gold
        // rewrite and unfairly penalizes a different-but-valid edit. This
        // reuses the production reviewer's own better-vs-worse judgment on
        // every correction instead — a fairer read on subjective quality.
        // Scoped to corrections the reviewer actually scored; unscoredRate
        // is reported alongside so a coverage gap doesn't masquerade as a
        // quality signal (see the field's doc comment on ModeScorecard).
        const unscored = card.unscoredRate ?? 0;
        lines.push(
          `             reviewer quality: ${card.avgReviewerConfidence.toFixed(0)}/100 avg confidence, ${(card.flaggedRate ?? 0).toFixed(0)}% of SCORED flagged` +
            (unscored > 0 ? ` (${unscored.toFixed(0)}% went unscored — reviewer didn't get to them)` : ""),
        );
      }
    }

    if (cards.length > 0) {
      const modelOverall = Math.round(
        cards.reduce((s, c) => s + c.overall, 0) / cards.length,
      );
      lines.push(`  ${"─".repeat(76)}`);
      lines.push(`  MODEL OVERALL (mean of the modes above): ${modelOverall}`);
      modelOveralls.push({ model, overall: modelOverall });
    }
    lines.push("");
  }

  lines.push(...buildLanguageSection(results, models));

  // ── Ranked summary ──
  if (modelOveralls.length > 1) {
    lines.push(`${"═".repeat(80)}`);
    lines.push(`RANKED — model overall score, highest first`);
    lines.push(`${"═".repeat(80)}`);
    for (const { model, overall } of [...modelOveralls].sort((a, b) => b.overall - a.overall)) {
      lines.push(`  ${String(overall).padStart(4)}  ${model}`);
    }
    lines.push("");
  }

  // ── Missed errors / false positives detail, per model+mode ──
  lines.push(`${"═".repeat(80)}`);
  lines.push(`DETAIL — missed planted errors and false positives (run 1 of each task)`);
  lines.push(`${"═".repeat(80)}`);
  for (const model of models) {
    for (const mode of ["copy_edit", "line_edit"] as const) {
      const runs = results.filter(
        (r) => r.model === model && r.mode === mode && r.variant !== "correct" && r.repeatIndex === 1 && r.errors.length === 0,
      );
      if (runs.length === 0) continue;
      for (const r of runs) {
        const truth = groundTruthFor(r.language, mode);
        const scored = scoreCorrections(r.corrections, truth);
        if (scored.missedErrors.length === 0 && scored.falsePositiveCorrections.length === 0) continue;
        lines.push(`\n[${model}] ${r.file} (${mode}):`);
        for (const m of scored.missedErrors.slice(0, 10)) {
          lines.push(`  MISSED:  "${m.wrong}" → "${m.right}"`);
        }
        if (scored.missedErrors.length > 10) lines.push(`  …and ${scored.missedErrors.length - 10} more missed`);
        const { wrongFix, hallucination } = scored.falsePositiveBreakdown;
        for (const fp of wrongFix.slice(0, 10)) {
          lines.push(`  WRONG-FIX:    "${fp.original}" → "${fp.corrected}" (right spot, wrong guess)`);
        }
        if (wrongFix.length > 10) lines.push(`  …and ${wrongFix.length - 10} more wrong-fix`);
        for (const fp of hallucination.slice(0, 10)) {
          lines.push(`  HALLUCINATED: "${fp.original}" → "${fp.corrected}" (no error there)`);
        }
        if (hallucination.length > 10) lines.push(`  …and ${hallucination.length - 10} more hallucinated`);
      }
    }
  }

  lines.push(`\n\n── END OF REPORT ──\n`);
  return lines.join("\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
