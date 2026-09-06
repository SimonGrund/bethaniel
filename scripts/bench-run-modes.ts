#!/usr/bin/env node
/**
 * Speed vs Max run-mode benchmark — copy_edit and line_edit, local models only.
 *
 * Answers: does Max mode (3 editors + 2 reviewers + thorough 2nd pass) buy
 * meaningfully better copy-edit/line-edit quality than Speed (1 editor + style
 * agent + 1 reviewer) on Baby Betty (4B) and Big Bad Betty (9B) — the two
 * local models Bethaniel ships? `docs/run-modes.md` already argues Speed wins
 * on weak/local models using an applied-corrections diff; this script instead
 * scores against real ground truth (buildGroundTruth/scoreCorrections, same
 * machinery as scripts/test-models.ts) for a recall/precision read, plus a
 * clean-text false-positive check per mode — the thing raw applied-diff can't
 * see (Max generating more hallucinated "fixes" on prose that had no error).
 *
 * HTTP client — drives the running backend exactly as the app does.
 *
 * HISTORICAL NOTE: this ran while Max still existed as a real preset
 * (`backend/src/runModePresets.ts`) and its result is what got Max removed
 * from the app entirely — see docs/run-modes.md. Max is no longer a
 * resolvable preset server-side, so re-running this script's "max" leg now
 * falls through to whatever knobs the request omits defaulting to, NOT a
 * real 3-editor/2-reviewer/2nd-pass run — don't mistake a future re-run
 * showing "no difference" for confirming the old finding.
 *
 * Prerequisites:
 *   - Backend server running on http://127.0.0.1:4000
 *   - Both Qwen3.5-4B-Q4_K_M.gguf and Qwen3.5-9B-Q4_K_M.gguf installed
 *
 * Usage:
 *   npx tsx scripts/bench-run-modes.ts                 # full grid (2 models × 2 task modes × speed/max)
 *   npx tsx scripts/bench-run-modes.ts --model 4b       # Baby Betty only
 *   npx tsx scripts/bench-run-modes.ts --model cloud --run-mode speed
 *   npx tsx scripts/bench-run-modes.ts --task line_edit # line_edit only
 *   npx tsx scripts/bench-run-modes.ts --skip-clean     # skip the clean-text FP runs (half the calls)
 *   npx tsx scripts/bench-run-modes.ts --clean          # wipe previous results, start fresh
 *   npx tsx scripts/bench-run-modes.ts --report-only    # recompute + reprint from saved results
 *
 * BETTY IN THE CLOUD: the "cloud" model is opt-in (`--model cloud`) and never
 * part of the default grid, because every run of it spends real money at
 * OVHcloud. It needs the backend configured with a cloud credential and only
 * makes sense with `--run-mode speed` — cloud jobs are forced to the Speed
 * preset server-side (`cloudRunKnobs` in backend/src/cloudEstimate.ts), so a
 * "max" leg would silently be a second Speed run charged twice.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  buildGroundTruth,
  recallByCategory,
  scoreCorrections,
  type PlantedError,
  type ScoredCorrection,
} from "../backend/src/benchScoring.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable so a run can target a second backend on another port — the dev
// backend is usually forked under the open Electron app, and restarting it to
// pick up a prompt change would take the app down with it.
const API = process.env.BENCH_API ?? "http://127.0.0.1:4000/api";
const SAMPLE_DIR = join(__dirname, "..", "sample_texts");
const RESULTS_PATH = join(SAMPLE_DIR, "run_mode_bench_results.json");
const REPORT_PATH = join(SAMPLE_DIR, "run_mode_bench_results.txt");

/** buildGroundTruth's default `mergeGapChars` — quoted in the report so the
 *  "other" category's contents are explicable rather than mysterious. */
const MERGE_GAP_CHARS = 20;

const POLL_INTERVAL = 3000;
const TASK_TIMEOUT = 3_600_000; // 1 hour — Max on the 9B can be slow

const CLEAN_RUN = process.argv.includes("--clean");
const REPORT_ONLY = process.argv.includes("--report-only");
const SKIP_CLEAN = process.argv.includes("--skip-clean");

function parseFlag(name: string): string | null {
  const idx = process.argv.indexOf(name);
  return idx === -1 || idx + 1 >= process.argv.length ? null : process.argv[idx + 1];
}
const MODEL_FILTER = parseFlag("--model")?.toLowerCase() ?? null;
const TASK_FILTER = parseFlag("--task") as "copy_edit" | "line_edit" | null;
const RUN_MODE_FILTER = parseFlag("--run-mode")?.toLowerCase() ?? null;

interface ModelSpec {
  fileName: string;
  label: string;
  /** Costs real money per run, so it is never in the default grid — you have
   *  to name it with --model. */
  optIn?: boolean;
}
const ALL_MODELS: ModelSpec[] = [
  { fileName: "Qwen3.5-4B-Q4_K_M.gguf", label: "Baby Betty" },
  { fileName: "Qwen3.5-9B-Q4_K_M.gguf", label: "Big Bad Betty" },
  {
    // The catalog fileName for the "bethaniel-cloud" entry — an `source:"api"`
    // pseudo-model, so nothing needs to be installed locally. What it actually
    // reaches is whatever baseUrl the backend's api-config.json has for that
    // entry (the Worker), which is what makes this measure the shipped path
    // and not a direct provider call.
    fileName: "custom:bethaniel-cloud",
    label: "Betty in the Cloud",
    optIn: true,
  },
];
const MODELS = MODEL_FILTER
  ? ALL_MODELS.filter(
      (m) =>
        m.fileName.toLowerCase().includes(MODEL_FILTER) ||
        m.label.toLowerCase().includes(MODEL_FILTER),
    )
  : ALL_MODELS.filter((m) => !m.optIn);

interface TaskSpec {
  mode: "copy_edit" | "line_edit";
  erroredFile: string;
  correctFile: string;
  label: string;
}
// stress100 for copy_edit: 100 planted errors across every category the
// copy-edit prompt covers — a higher-confidence recall read than the smaller
// standard fixture. No equivalent stress fixture exists for line_edit, so
// that one uses the standard english fixture (dense paraphrasing, ~544 words).
const ALL_TASKS: TaskSpec[] = [
  {
    mode: "copy_edit",
    erroredFile: "stress100_copy_edit.md",
    correctFile: "stress100_correct.md",
    label: "copy_edit (stress100, 100 planted errors)",
  },
  {
    mode: "line_edit",
    erroredFile: "english_line_edit.md",
    correctFile: "english_correct.md",
    label: "line_edit (english fixture)",
  },
];
const TASKS = TASK_FILTER ? ALL_TASKS.filter((t) => t.mode === TASK_FILTER) : ALL_TASKS;

const ALL_RUN_MODES = ["speed", "max"] as const;
type RunModeName = (typeof ALL_RUN_MODES)[number];
const RUN_MODES: readonly RunModeName[] = RUN_MODE_FILTER
  ? ALL_RUN_MODES.filter((m) => m === RUN_MODE_FILTER)
  : ALL_RUN_MODES;

interface RunResult {
  model: string;
  taskMode: "copy_edit" | "line_edit";
  runMode: RunModeName;
  variant: "errored" | "clean";
  wallMs: number;
  tokPerSec: string | null;
  corrections: (ScoredCorrection & { confidence?: number; flagged?: boolean })[];
  errors: string[];
  runDate: string;
}

// ── Persistence ──
function loadResults(): RunResult[] {
  if (CLEAN_RUN || !existsSync(RESULTS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(RESULTS_PATH, "utf-8")) as RunResult[];
  } catch {
    return [];
  }
}
function saveResults(results: RunResult[]): void {
  writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2), "utf-8");
}
function resultKey(r: Pick<RunResult, "model" | "taskMode" | "runMode" | "variant">): string {
  return `${r.model}::${r.taskMode}::${r.runMode}::${r.variant}`;
}

// ── HTTP helpers ──
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) throw new Error(`${method} ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function uploadText(filename: string, content: string): Promise<string> {
  const blob = new Blob([content], { type: "text/plain" });
  const form = new FormData();
  form.append("file", blob, filename);
  const res = await fetch(`${API}/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function waitForTask(taskId: string): Promise<{
  status: string;
  corrections: (ScoredCorrection & { confidence?: number; flagged?: boolean })[];
  errors: string[];
  tokPerSec: string | null;
}> {
  const start = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - start < TASK_TIMEOUT) {
    try {
      const task = (await api("GET", `/results/${taskId}`)) as {
        status: string;
        tokPerSec?: string;
        result: { corrections: any[]; errors: string[] } | null;
      };
      consecutiveErrors = 0;
      if (task.status === "done" || task.status === "error" || task.status === "cancelled") {
        return {
          status: task.status,
          corrections: task.result?.corrections ?? [],
          errors: task.result?.errors ?? [],
          tokPerSec: task.tokPerSec ?? null,
        };
      }
    } catch (err) {
      consecutiveErrors++;
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

// ── Ground truth (cached) ──
const groundTruthCache = new Map<string, PlantedError[]>();
function groundTruthFor(task: TaskSpec): PlantedError[] {
  const cached = groundTruthCache.get(task.label);
  if (cached) return cached;
  const correct = readFileSync(join(SAMPLE_DIR, task.correctFile), "utf-8");
  const errored = readFileSync(join(SAMPLE_DIR, task.erroredFile), "utf-8");
  const truth = buildGroundTruth(errored, correct);
  groundTruthCache.set(task.label, truth);
  return truth;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ── Main ──
async function main() {
  console.log("=== Bethaniel Run-Mode Benchmark ===\n");

  if (REPORT_ONLY) {
    const results = loadResults();
    if (results.length === 0) {
      console.error(`ERROR: no saved results at ${RESULTS_PATH}`);
      process.exit(1);
    }
    const report = buildReport(results);
    writeFileSync(REPORT_PATH, report, "utf-8");
    console.log(report);
    return;
  }

  try {
    await fetch(`${API.replace("/api", "")}/health`);
  } catch {
    console.error(`ERROR: Backend not reachable at ${API}. Start it with \`npm run dev\` in backend/, or set BENCH_API.`);
    process.exit(1);
  }

  console.log(`Models: ${MODELS.map((m) => `${m.label} (${m.fileName})`).join(", ")}`);
  console.log(`Tasks:  ${TASKS.map((t) => t.label).join(", ")}`);
  console.log(`Modes:  ${RUN_MODES.join(", ")}`);
  console.log(`Clean-text FP runs: ${SKIP_CLEAN ? "skipped" : "included"}\n`);

  const results: RunResult[] = loadResults();
  const done = new Set(results.map(resultKey));

  for (const model of MODELS) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`MODEL: ${model.label} (${model.fileName})`);
    console.log(`${"─".repeat(70)}`);

    for (const task of TASKS) {
      for (const runMode of RUN_MODES) {
        const variants: { variant: "errored" | "clean"; file: string }[] = [
          { variant: "errored", file: task.erroredFile },
        ];
        if (!SKIP_CLEAN) variants.push({ variant: "clean", file: task.correctFile });

        for (const v of variants) {
          const key = resultKey({ model: model.fileName, taskMode: task.mode, runMode, variant: v.variant });
          if (done.has(key)) {
            console.log(`  [skip] ${task.mode}/${runMode}/${v.variant} — already have a result`);
            continue;
          }

          const label = `${task.mode}/${runMode}/${v.variant}`;
          process.stdout.write(`  ${label}… `);
          const startTime = Date.now();
          let docId: string | undefined;
          try {
            const content = readFileSync(join(SAMPLE_DIR, v.file), "utf-8");
            docId = await uploadText(v.file, content);
            const { taskIds } = (await api("POST", "/queue/add", {
              docId,
              units: [{ name: v.file, original: content }],
              model: model.fileName,
              modes: [task.mode],
              runMode,
              parallel: 1,
              manuscriptLang: "en",
            })) as { taskIds: string[] };

            const taskResult = await waitForTask(taskIds[0]);
            const wallMs = Date.now() - startTime;
            console.log(
              `${taskResult.corrections.length} corrections in ${fmtMs(wallMs)}` +
                (taskResult.tokPerSec ? ` @ ${taskResult.tokPerSec} tok/s` : "") +
                (taskResult.status === "error" ? ` ERROR: ${taskResult.errors.join("; ")}` : ""),
            );

            results.push({
              model: model.fileName,
              taskMode: task.mode,
              runMode,
              variant: v.variant,
              wallMs,
              tokPerSec: taskResult.tokPerSec,
              corrections: taskResult.corrections,
              errors: taskResult.errors,
              runDate: new Date().toISOString(),
            });
            done.add(key);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`ERROR: ${msg}`);
            results.push({
              model: model.fileName,
              taskMode: task.mode,
              runMode,
              variant: v.variant,
              wallMs: Date.now() - startTime,
              tokPerSec: null,
              corrections: [],
              errors: [msg],
              runDate: new Date().toISOString(),
            });
            done.add(key);
          }
          saveResults(results);
          if (docId) await api("DELETE", `/documents/${docId}`).catch(() => {});
        }
      }
    }
  }

  const report = buildReport(results);
  writeFileSync(REPORT_PATH, report, "utf-8");
  console.log(`\n\n${"═".repeat(70)}`);
  console.log(`Results saved to: ${REPORT_PATH}`);
  console.log(`${"═".repeat(70)}`);
  console.log(report);
}

// ── Report ──
function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function buildReport(results: RunResult[]): string {
  const lines: string[] = [];
  lines.push("BETHANIEL RUN-MODE BENCHMARK (Speed vs Max; local models + opt-in cloud)");
  lines.push(`Report generated: ${new Date().toISOString()}`);
  lines.push("═".repeat(78) + "\n");

  const models = [...new Set(results.map((r) => r.model))];
  const modelLabel = (fileName: string) =>
    ALL_MODELS.find((m) => m.fileName === fileName)?.label ?? fileName;

  for (const model of models) {
    lines.push("─".repeat(78));
    lines.push(`MODEL: ${modelLabel(model)} (${model})`);
    lines.push("─".repeat(78));

    for (const taskMode of ["copy_edit", "line_edit"] as const) {
      const task = ALL_TASKS.find((t) => t.mode === taskMode);
      if (!task) continue;
      const truth = groundTruthFor(task);

      // Which legs exist is a property of the saved results, not of this
      // run's flags — --report-only has to print a file that may hold more
      // (or fewer) modes than the last invocation asked for.
      const erroredFor = (runMode: RunModeName) =>
        results.find(
          (r) =>
            r.model === model &&
            r.taskMode === taskMode &&
            r.runMode === runMode &&
            r.variant === "errored",
        );
      const speedErr = erroredFor("speed");
      const maxErr = erroredFor("max");
      if (!speedErr && !maxErr) continue;

      lines.push(`\n  ${task.label}`);
      lines.push(
        `  ${"mode".padEnd(6)} ${"recall".padStart(7)} ${"prec.".padStart(7)} ${"f1".padStart(6)} ${"wrongFix".padStart(9)} ${"halluc.".padStart(8)} ${"wall".padStart(8)} ${"tok/s".padStart(7)} ${"conf/100".padStart(9)} ${"flagged".padStart(8)}`,
      );

      for (const r of [speedErr, maxErr]) {
        // A missing leg is normal now that Max is gone and cloud runs are
        // Speed-only — say nothing rather than printing an empty row.
        if (!r) continue;
        if (r.errors.length > 0 && r.corrections.length === 0) {
          lines.push(`  ${r.runMode.padEnd(6)} ERROR: ${r.errors.join("; ")}`);
          continue;
        }
        const scored = scoreCorrections(r.corrections, truth);
        const scoredConf = r.corrections.filter(
          (c): c is ScoredCorrection & { confidence: number; flagged?: boolean } =>
            typeof c.confidence === "number",
        );
        const avgConf = scoredConf.length ? ((avg(scoredConf.map((c) => c.confidence)) - 1) / 4) * 100 : null;
        const flaggedRate = scoredConf.length
          ? (scoredConf.filter((c) => c.flagged === true).length / scoredConf.length) * 100
          : null;
        lines.push(
          `  ${r.runMode.padEnd(6)} ${fmtPct(scored.recall)} ${fmtPct(scored.precision)} ${fmtNum(scored.f1)} ` +
            `${String(scored.falsePositiveBreakdown.wrongFix.length).padStart(9)} ${String(scored.falsePositiveBreakdown.hallucination.length).padStart(8)} ` +
            `${fmtMs(r.wallMs).padStart(8)} ${(r.tokPerSec ?? "-").padStart(7)} ${fmtNum(avgConf).padStart(9)} ${fmtPctPlain(flaggedRate).padStart(8)}`,
        );
      }

      // Recall split by what KIND of error was missed. The headline number
      // hides the difference between a model that cannot spell and one that
      // cannot punctuate, and those are not the same product problem.
      const measured = [speedErr, maxErr].filter(
        (r): r is RunResult => !!r && r.corrections.length > 0,
      );
      if (measured.length > 0) {
        const perMode = measured.map((r) => ({
          runMode: r.runMode,
          rows: recallByCategory(truth, scoreCorrections(r.corrections, truth).missedErrors),
        }));
        lines.push(
          `\n  recall by error type${" ".repeat(6)}planted` +
            perMode.map((m) => m.runMode.padStart(8)).join(""),
        );
        for (let i = 0; i < perMode[0].rows.length; i++) {
          const { category, planted } = perMode[0].rows[i];
          if (planted === 0) continue; // this fixture plants none of these
          lines.push(
            `    ${category.padEnd(24)}${String(planted).padStart(7)}` +
              perMode.map((m) => fmtPctPlain(m.rows[i].recall).padStart(8)).join(""),
          );
        }
        lines.push(
          `    (merged spans — two errors within ${MERGE_GAP_CHARS} characters — count once, under "other")`,
        );
      }

      // Clean-text false positives, if present.
      const speedClean = results.find(
        (r) => r.model === model && r.taskMode === taskMode && r.runMode === "speed" && r.variant === "clean",
      );
      const maxClean = results.find(
        (r) => r.model === model && r.taskMode === taskMode && r.runMode === "max" && r.variant === "clean",
      );
      if (speedClean || maxClean) {
        lines.push(`\n  Clean-text false positives (should be 0):`);
        for (const r of [speedClean, maxClean]) {
          if (!r) continue;
          const real = r.corrections.filter((c) => c.original !== c.corrected);
          lines.push(`    ${r.runMode.padEnd(6)} ${real.length} false positive(s) in ${fmtMs(r.wallMs)}`);
          for (const c of real.slice(0, 8)) {
            lines.push(`             "${c.original}" → "${c.corrected}"`);
          }
        }
      }

      // Verdict: is Max's recall gain worth its time cost? Only meaningful
      // when both legs were actually run.
      if (speedErr && maxErr && speedErr.corrections && maxErr.corrections) {
        const sScore = scoreCorrections(speedErr.corrections, truth);
        const mScore = scoreCorrections(maxErr.corrections, truth);
        const recallGain = (mScore.recall ?? 0) - (sScore.recall ?? 0);
        const timeCost = speedErr.wallMs > 0 ? maxErr.wallMs / speedErr.wallMs : 1;
        const hallucGain =
          mScore.falsePositiveBreakdown.hallucination.length - sScore.falsePositiveBreakdown.hallucination.length;
        lines.push(
          `\n  → Max vs Speed: ${recallGain >= 0 ? "+" : ""}${recallGain.toFixed(1)}pt recall, ` +
            `${timeCost.toFixed(1)}× wall-clock, ${hallucGain >= 0 ? "+" : ""}${hallucGain} hallucinated FP` +
            ` — ${recallGain > 5 ? "Max meaningfully improves recall" : "Max's recall gain is within noise"}.`,
        );
      }
      lines.push("");
    }
  }

  lines.push("\n── END OF REPORT ──\n");
  return lines.join("\n");
}

function fmtPct(v: number | null): string {
  return v === null ? "   n/a" : `${v.toFixed(0).padStart(5)}%`;
}
function fmtPctPlain(v: number | null): string {
  return v === null ? "n/a" : `${v.toFixed(0)}%`;
}
function fmtNum(v: number | null): string {
  return v === null ? "  n/a" : v.toFixed(0).padStart(4);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
