#!/usr/bin/env node
/**
 * Translation Quality Benchmark
 *
 * Translates a short English source text into Danish, German, and Spanish
 * with every installed candidate model, then judges each translation's
 * fidelity + fluency with a single, fixed judge model — reusing the app's
 * own buildTranslationReviewerPrompt rubric (the same one production
 * translate-mode uses internally to decide which paragraphs to
 * re-translate). Judging goes through POST /api/bench/judge, a small
 * dev-only backend endpoint that calls reviewCorrectionsStream on the
 * SAME already-running llama-server — it never spawns a second engine
 * process, so it can't collide with the real backend the way importing
 * llamaServer.ts directly into this script would.
 *
 * Unlike test-models.ts's copy/line-edit scoring, there is no diffable
 * ground truth for a translation (no single "correct" Danish rendering
 * exists) — quality is judge-scored, 1-5 per paragraph, same as the
 * production translation reviewer.
 *
 * Prerequisites:
 *   - Backend server running on http://127.0.0.1:4000
 *   - Candidate models + the judge model installed in backend/models/
 *
 * Usage:
 *   npx tsx scripts/test-translation.ts
 *   npx tsx scripts/test-translation.ts --judge 9b        # override judge model (default: largest installed)
 *   npx tsx scripts/test-translation.ts --source path.md  # override source text (default: sample_texts/english_correct.md)
 *   npx tsx scripts/test-translation.ts --model qwen      # only benchmark models whose filename contains "qwen"
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildTranslationReviewerPrompt } from "../backend/src/prompts.js";
import { scoreTranslation, type TranslationScore } from "../backend/src/translationQuality.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Overridable like test-models.ts's BENCH_API — the dev backend on 4000 is
// usually forked under the open Electron app, and a benchmark should be able
// to target a second backend without taking the app down.
const API = process.env.BENCH_API ?? "http://127.0.0.1:4000/api";
const SAMPLE_DIR = join(__dirname, "..", "sample_texts");
const OUT_PATH = join(SAMPLE_DIR, "translation_results.txt");

const TARGET_LANGS = ["Danish", "German", "Spanish"];
const POLL_INTERVAL = 1500;
// Translate mode is a 4-stage pipeline (translate, accuracy review +
// re-translate, monolingual polish, fluency review + re-polish) — much
// heavier per chunk than copy/line edit, especially on a 24B model.
const TASK_TIMEOUT = 15 * 60 * 1000;

function parseArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}
const JUDGE_FILTER = parseArg("--judge");
const SOURCE_OVERRIDE = parseArg("--source");
const MODEL_FILTER = parseArg("--model");

function isTransientError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("terminated") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("socket hang up") ||
    m.includes("fetch failed") ||
    m.includes("etimedout") ||
    m.includes("undici")
  );
}

// Local-inference calls (particularly /bench/judge, one long single-shot
// generation with no retry of its own) fail occasionally via transient
// network hiccups talking to llama-server — same class of error queue.ts's
// isTransientFetchError already retries in the real pipeline.
async function api(method: string, path: string, body?: unknown, attempt = 1): Promise<any> {
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(`${API}${path}`, opts);
    if (!res.ok) {
      const text = await res.text();
      if (attempt < 3 && isTransientError(text)) {
        console.log(`  (transient error on ${method} ${path}, retrying: ${text.slice(0, 100)})`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
        return api(method, path, body, attempt + 1);
      }
      throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (attempt < 3 && isTransientError(msg)) {
      console.log(`  (transient error on ${method} ${path}, retrying: ${msg.slice(0, 100)})`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return api(method, path, body, attempt + 1);
    }
    throw err;
  }
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

interface TaskOutcome {
  status: string;
  editedText?: string;
  errors: string[];
}

async function waitForTask(taskId: string): Promise<TaskOutcome> {
  const start = Date.now();
  let consecutiveErrors = 0;
  while (Date.now() - start < TASK_TIMEOUT) {
    try {
      const task = (await api("GET", `/results/${taskId}`)) as {
        status: string;
        result: { editedText?: string; errors: string[] } | null;
      };
      consecutiveErrors = 0;
      if (task.status === "done" || task.status === "error") {
        return {
          status: task.status,
          editedText: task.result?.editedText,
          errors: task.result?.errors ?? [],
        };
      }
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors > 10) {
        throw new Error(`Lost connection to backend: ${err instanceof Error ? err.message : err}`);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }
  throw new Error(`Task ${taskId} timed out after ${TASK_TIMEOUT / 1000}s`);
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

interface JudgeScore {
  index: number;
  confidence: number;
  reason: string;
}

async function judgeTranslation(
  judgeModel: string,
  sourceText: string,
  translatedText: string,
): Promise<JudgeScore[]> {
  const srcParas = splitParagraphs(sourceText);
  const tgtParas = splitParagraphs(translatedText);
  const n = Math.min(srcParas.length, tgtParas.length);
  const pairs = srcParas.slice(0, n).map((s, i) => ({ original: s, corrected: tgtParas[i] }));

  const systemPrompt = buildTranslationReviewerPrompt();
  const res = (await api("POST", "/bench/judge", {
    model: judgeModel,
    systemPrompt,
    chunkText: sourceText,
    pairs,
  })) as { scores: JudgeScore[] };
  return res.scores;
}

async function main() {
  console.log("=== Bethaniel Translation Quality Benchmark ===\n");

  try {
    await fetch(`${API.replace("/api", "")}/health`);
  } catch {
    console.error("ERROR: Backend server not reachable at http://127.0.0.1:4000");
    process.exit(1);
  }

  const modelData = (await api("GET", "/models")) as { models: string[] };
  const catalogData = (await api("GET", "/models/catalog")) as {
    catalog: { fileName: string; sizeBytes: number }[];
  };
  const catalogFileNames = new Set(catalogData.catalog.map((c) => c.fileName));
  const sizeByFile = new Map(catalogData.catalog.map((c) => [c.fileName, c.sizeBytes]));
  let models = modelData.models.filter((m) => catalogFileNames.has(m));
  if (models.length === 0) {
    console.error("ERROR: No catalog models found in backend/models/");
    process.exit(1);
  }
  if (MODEL_FILTER) {
    const needle = MODEL_FILTER.toLowerCase();
    models = models.filter((m) => m.toLowerCase().includes(needle));
  }

  // Judge model: explicit --judge filter, else the largest installed model
  // (most capable available judge — see the file header re: self-judging).
  let judgeModel: string;
  if (JUDGE_FILTER) {
    const needle = JUDGE_FILTER.toLowerCase();
    const match = modelData.models.find((m) => m.toLowerCase().includes(needle));
    if (!match) {
      console.error(`ERROR: No installed model matches --judge "${JUDGE_FILTER}"`);
      process.exit(1);
    }
    judgeModel = match;
  } else {
    judgeModel = [...models].sort(
      (a, b) => (sizeByFile.get(b) ?? 0) - (sizeByFile.get(a) ?? 0),
    )[0];
  }

  console.log(`Candidate models: ${models.join(", ")}`);
  console.log(`Judge model: ${judgeModel}`);
  console.log(`Target languages: ${TARGET_LANGS.join(", ")}\n`);

  // The parallel corpus: one source with a human reference per target. Falls
  // back to the old source when --source is passed, in which case there are no
  // references and only the judge scores run.
  const sourcePath = SOURCE_OVERRIDE ?? join(SAMPLE_DIR, "translation_source_en.md");
  const REF_FILE: Record<string, string> = {
    Danish: "translation_ref_da.md",
    German: "translation_ref_de.md",
    Spanish: "translation_ref_es.md",
  };
  const references = new Map<string, string>();
  if (!SOURCE_OVERRIDE) {
    for (const [lang, file] of Object.entries(REF_FILE)) {
      try {
        references.set(lang, readFileSync(join(SAMPLE_DIR, file), "utf-8"));
      } catch {
        console.warn(`  ! no reference translation for ${lang} (${file})`);
      }
    }
  }
  const sourceText = readFileSync(sourcePath, "utf-8");
  const sourceFilename = sourcePath.split(/[/\\]/).pop()!;
  console.log(`Source: ${sourcePath} (${sourceText.split(/\s+/).length} words)\n`);

  interface Result {
    model: string;
    targetLang: string;
    translatedText?: string;
    errors: string[];
    scores: JudgeScore[];
    /** Reference-based, deterministic. Undefined when no reference exists. */
    quality?: TranslationScore;
    elapsedMs: number;
  }
  const results: Result[] = [];

  for (const model of models) {
    for (const targetLang of TARGET_LANGS) {
      const label = `${model} → ${targetLang}`;
      console.log(`Translating: ${label}`);
      const start = Date.now();
      try {
        const docId = await uploadText(sourceFilename, sourceText);
        const queueRes = (await api("POST", "/queue/add", {
          docId,
          units: [{ name: sourceFilename, original: sourceText }],
          model,
          modes: ["translate"],
          targetLang,
          wordsPerChunk: 2000,
          overlapParagraphs: 1,
          parallel: 1,
        })) as { taskIds: string[] };

        const outcome = await waitForTask(queueRes.taskIds[0]);
        const elapsedMs = Date.now() - start;

        if (outcome.status !== "done" || !outcome.editedText) {
          console.log(`  FAILED (${(elapsedMs / 1000).toFixed(1)}s): ${outcome.errors.join("; ") || "no output"}`);
          results.push({ model, targetLang, errors: outcome.errors, scores: [], elapsedMs });
          continue;
        }

        console.log(`  Translated (${(elapsedMs / 1000).toFixed(1)}s), judging…`);
        const scores = await judgeTranslation(judgeModel, sourceText, outcome.editedText);
        const avg = scores.length
          ? scores.reduce((s, x) => s + x.confidence, 0) / scores.length
          : 0;
        console.log(`  Judged: avg ${avg.toFixed(1)}/5 across ${scores.length} paragraphs`);

        const reference = references.get(targetLang);
        const quality =
          reference && outcome.editedText
            ? scoreTranslation(outcome.editedText, sourceText, reference)
            : undefined;
        if (quality) {
          console.log(
            `  chrF ${quality.chrf.toFixed(1)}  chrF++ ${quality.chrfPlusPlus.toFixed(1)}  ` +
              `len ${quality.lengthRatio.toFixed(2)}x  leak ${(quality.sourceLeakage * 100).toFixed(1)}%`,
          );
        }

        results.push({
          model,
          targetLang,
          translatedText: outcome.editedText,
          errors: outcome.errors,
          scores,
          quality,
          elapsedMs,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  ERROR: ${msg}`);
        results.push({ model, targetLang, errors: [msg], scores: [], elapsedMs: Date.now() - start });
      }
    }
  }

  // ── Report ──
  const lines: string[] = [];
  lines.push("BETHANIEL TRANSLATION QUALITY BENCHMARK");
  lines.push(`Report generated: ${new Date().toISOString()}`);
  lines.push(`Judge model: ${judgeModel} (self-judging caveat applies to its own rows)`);
  lines.push(`Source: ${sourcePath}`);
  lines.push("=".repeat(80) + "\n");

  // ── Reference-based scorecard ──
  //
  // First, because it is the number to trust. The judge scorecard below it
  // saturates: on the previous run every model landed between 4.2 and 5.0,
  // three of nine rows at a flat 5.0, and the largest model judged its own
  // output. These figures are pure functions of the text — same answer every
  // run, no model in the loop.
  //
  // chrF is character n-gram F-score (the WMT standard, and the right choice
  // for Danish and German morphology, where a different-but-correct inflection
  // costs a word-level metric everything). A reference is ONE valid rendering,
  // so read these for ranking models against each other, never as an absolute
  // "this translation is 62% correct".
  const scored = results.filter((r) => r.quality);
  if (scored.length > 0) {
    lines.push("SCORECARD — reference-based (deterministic, no judge model)");
    lines.push("=".repeat(80));
    lines.push(
      `  ${"Model".padEnd(45)} ${"Lang".padEnd(8)} ${"chrF".padStart(6)} ${"chrF++".padStart(7)} ${"len".padStart(6)} ${"leak".padStart(6)}`,
    );
    for (const r of scored) {
      const q = r.quality!;
      lines.push(
        `  ${r.model.padEnd(45)} ${r.targetLang.padEnd(8)} ` +
          `${q.chrf.toFixed(1).padStart(6)} ${q.chrfPlusPlus.toFixed(1).padStart(7)} ` +
          `${(q.lengthRatio.toFixed(2) + "x").padStart(6)} ${((q.sourceLeakage * 100).toFixed(1) + "%").padStart(6)}`,
      );
    }
    lines.push("");
    lines.push("  chrF/chrF++  0-100, higher is better. Similarity to the reference translation.");
    lines.push("  len          hypothesis length / reference length. Far from 1.00 means it");
    lines.push("               stopped early or padded — both can still score well on chrF.");
    lines.push("  leak         share of words left untranslated from the source. A reader");
    lines.push("               notices these immediately; chrF barely does.");
    lines.push("");
  }

  lines.push("SCORECARD — judge confidence 1-5 per paragraph (rubric: fidelity + fluency)");
  lines.push("=".repeat(80));
  lines.push(
    `  ${"Model".padEnd(45)} ${"Lang".padEnd(8)} ${"Avg".padStart(5)} ${"Min".padStart(5)} ${"Flagged".padStart(9)} ${"Time".padStart(7)}`,
  );
  for (const r of results) {
    const isSelfJudge = r.model === judgeModel;
    if (r.scores.length === 0) {
      lines.push(
        `  ${r.model.padEnd(45)} ${r.targetLang.padEnd(8)} ${"FAILED".padStart(5)}${isSelfJudge ? " *" : ""}`,
      );
      continue;
    }
    const avg = r.scores.reduce((s, x) => s + x.confidence, 0) / r.scores.length;
    const min = Math.min(...r.scores.map((x) => x.confidence));
    const flagged = r.scores.filter((x) => x.confidence < 3).length;
    lines.push(
      `  ${r.model.padEnd(45)} ${r.targetLang.padEnd(8)} ${avg.toFixed(1).padStart(5)} ${String(min).padStart(5)} ${`${flagged}/${r.scores.length}`.padStart(9)} ${`${(r.elapsedMs / 1000).toFixed(0)}s`.padStart(7)}${isSelfJudge ? " *" : ""}`,
    );
  }
  lines.push("\n  * this model judged its own translation — treat with extra skepticism\n");

  lines.push("=".repeat(80));
  lines.push("DETAIL — flagged paragraphs (confidence < 3) and judge reasoning");
  lines.push("=".repeat(80));
  for (const r of results) {
    const flagged = r.scores.filter((x) => x.confidence < 3);
    if (flagged.length === 0) continue;
    lines.push(`\n[${r.model} → ${r.targetLang}]:`);
    for (const f of flagged) {
      lines.push(`  [${f.index}] confidence ${f.confidence}: ${f.reason}`);
    }
  }

  lines.push("\n\n── END OF REPORT ──\n");
  const report = lines.join("\n");
  writeFileSync(OUT_PATH, report, "utf-8");
  console.log(`\n\nResults saved to: ${OUT_PATH}\n`);
  console.log(report);

  // Also save raw translated texts for manual spot-checking.
  const rawPath = join(SAMPLE_DIR, "translation_results.json");
  writeFileSync(rawPath, JSON.stringify(results, null, 2), "utf-8");
  console.log(`Raw translations + scores saved to: ${rawPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
