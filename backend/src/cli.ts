#!/usr/bin/env node
// ── Bethaniel CLI ("betty") ──
// Headless, standalone command that runs the Bethaniel editing pipeline against
// a manuscript and writes one or more export formats. No Electron / Express /
// Socket.IO required — it imports the pipeline modules directly and spawns
// llama-server itself.
//
// Usage:
//   betty --model <name|id|file> --mode <copy|line|analysis|translation>... \
//     [--language <lang>] --input-doc <path> --export-format <docx|md|epub>...
//
// "Automatically accepts all changes accepted by the reviewer agent" is the
// pipeline's default behaviour: with reviewMode on, reviewer-approved
// corrections are baked into TaskResult.editedText and low-confidence ones are
// diverted to `skipped`. The CLI simply reads editedText.

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, stat, mkdir } from "node:fs/promises";

// ── CLI modes / export formats ──────────────────────────────────────────────
type CliMode = "copy" | "line" | "analysis" | "translation";
const CLI_MODES: CliMode[] = ["copy", "line", "analysis", "translation"];
type ExportFormat = "docx" | "md" | "epub";
const EXPORT_FORMATS: ExportFormat[] = ["docx", "md", "epub"];

const USAGE = `Bethaniel CLI — run the local AI copy-editor from the command line.

Usage:
  betty --model <name|id|file> --mode <mode>... \\
    [--language <lang>] --input-doc <path> --export-format <fmt>... [options]

Required:
  --model <name|id|file>   Friendly name ("Baby Betty"), catalog id, gguf
                           filename, or custom:<id> (API/Ollama)
  --mode <mode>...         One or more of: copy line analysis translation
                           (space- or comma-separated; copy+line merge into a
                           single combined edit)
  --input-doc <path>       .docx, .md, or .txt manuscript
  --export-format <fmt>... One or more of: docx md epub

Conditional:
  --language <lang>        Target language (required when 'translation' is set)

Options:
  --style-guide <path>     Style-guide text file applied to the run
  --out-dir <dir>          Output directory (default: input file's directory)
  --data-dir <dir>         Data dir holding api-config.json / the SQLite db
                           (default: the desktop app's data dir)
  --api-key <key>          API key for External Betty; saved to the data dir so
                           later runs don't need it again
  --no-review              Disable the reviewer agent (keep all editor changes)
  -h, --help               Show this help

Examples:
  betty --model Baby-betty --mode copy line --input-doc book.docx \\
    --export-format docx md
  betty --model Big-bad-betty --mode translation --language Spanish \\
    --input-doc book.md --export-format epub
`;

function fail(msg: string): never {
  console.error(`error: ${msg}\n`);
  console.error(USAGE);
  process.exit(2);
}

interface CliArgs {
  model: string;
  modes: CliMode[];
  language?: string;
  inputDoc: string;
  exportFormats: ExportFormat[];
  styleGuidePath?: string;
  outDir?: string;
  dataDir?: string;
  apiKey?: string;
  noReview: boolean;
}

// Custom parser so `--mode copy line` and `--export-format docx md` (space- or
// comma-separated) work as the user expects — node:util parseArgs only allows
// repeated flags for multi-values.
function parseCliArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const modes: string[] = [];
  const formats: string[] = [];
  let model: string | undefined;
  let language: string | undefined;
  let inputDoc: string | undefined;
  let styleGuidePath: string | undefined;
  let outDir: string | undefined;
  let dataDir: string | undefined;
  let apiKey: string | undefined;
  let noReview = false;

  let i = 0;
  const collectMulti = (target: string[]): void => {
    i++;
    while (i < argv.length && !argv[i].startsWith("-")) {
      for (const part of argv[i].split(",")) {
        const t = part.trim();
        if (t) target.push(t);
      }
      i++;
    }
  };
  const takeValue = (flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) fail(`${flag} needs a value`);
    i += 2;
    return v;
  };

  while (i < argv.length) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "--": // tolerate a lone separator (e.g. from `npm run cli -- ...`)
        i++;
        break;
      case "--no-review":
        noReview = true;
        i++;
        break;
      case "-m":
      case "--mode":
        collectMulti(modes);
        break;
      case "-f":
      case "--export-format":
        collectMulti(formats);
        break;
      case "--model":
        model = takeValue(a);
        break;
      case "--language":
        language = takeValue(a);
        break;
      case "--input-doc":
        inputDoc = takeValue(a);
        break;
      case "--style-guide":
        styleGuidePath = takeValue(a);
        break;
      case "--out-dir":
        outDir = takeValue(a);
        break;
      case "--data-dir":
        dataDir = takeValue(a);
        break;
      case "--api-key":
        apiKey = takeValue(a);
        break;
      default:
        fail(`unknown argument: ${a}`);
    }
  }

  if (!model) fail("--model is required");
  if (modes.length === 0) fail("--mode is required");
  for (const m of modes)
    if (!CLI_MODES.includes(m as CliMode))
      fail(`unknown --mode "${m}" (allowed: ${CLI_MODES.join(", ")})`);
  if (!inputDoc) fail("--input-doc is required");
  if (formats.length === 0) fail("at least one --export-format is required");
  for (const f of formats)
    if (!EXPORT_FORMATS.includes(f.toLowerCase() as ExportFormat))
      fail(`unknown --export-format "${f}" (allowed: ${EXPORT_FORMATS.join(", ")})`);

  const dedupModes = [...new Set(modes)] as CliMode[];
  if (dedupModes.includes("translation") && !language)
    fail("--language is required when --mode includes translation");

  return {
    model,
    modes: dedupModes,
    language,
    inputDoc,
    exportFormats: [...new Set(formats.map((f) => f.toLowerCase()))] as ExportFormat[],
    styleGuidePath,
    outDir,
    dataDir,
    apiKey,
    noReview,
  };
}

// ── Pipeline module bindings (populated by dynamic import after env setup) ──
// Imported lazily so MODELS_DIR / DATA_DIR / LLAMA_BIN env defaults are in
// place before the modules read them at import time.
type Pipeline = {
  initQueue: typeof import("./queue.js").initQueue;
  submitTask: typeof import("./queue.js").submitTask;
  getTasksSnapshot: typeof import("./queue.js").getTasksSnapshot;
  setConcurrency: typeof import("./queue.js").setConcurrency;
  closeQueue: typeof import("./queue.js").closeQueue;
  shutdownLlamaServer: typeof import("./llamaServer.js").shutdownLlamaServer;
  docxToMarkdown: typeof import("./conversion.js").docxToMarkdown;
  markdownToDocx: typeof import("./conversion.js").markdownToDocx;
  markdownToEpub: typeof import("./epub.js").markdownToEpub;
  findChapters: typeof import("./chapters.js").findChapters;
  PAGEBREAK_MARKER: string;
  buildCopyEditCorrectionsPrompt: typeof import("./prompts.js").buildCopyEditCorrectionsPrompt;
  buildLineEditCorrectionsPrompt: typeof import("./prompts.js").buildLineEditCorrectionsPrompt;
  buildCombinedEditPrompt: typeof import("./prompts.js").buildCombinedEditPrompt;
  buildTranslationPrompt: typeof import("./prompts.js").buildTranslationPrompt;
  buildCombinedAnalysisPrompt: typeof import("./prompts.js").buildCombinedAnalysisPrompt;
  DEFAULT_COPY_EDIT_OPTIONS: typeof import("./types.js").DEFAULT_COPY_EDIT_OPTIONS;
  DEFAULT_LINE_EDIT_OPTIONS: typeof import("./types.js").DEFAULT_LINE_EDIT_OPTIONS;
};

async function loadPipeline(): Promise<Pipeline> {
  const queue = await import("./queue.js");
  const llamaServer = await import("./llamaServer.js");
  const conversion = await import("./conversion.js");
  const epub = await import("./epub.js");
  const chapters = await import("./chapters.js");
  const prompts = await import("./prompts.js");
  const types = await import("./types.js");
  return {
    initQueue: queue.initQueue,
    submitTask: queue.submitTask,
    getTasksSnapshot: queue.getTasksSnapshot,
    setConcurrency: queue.setConcurrency,
    closeQueue: queue.closeQueue,
    shutdownLlamaServer: llamaServer.shutdownLlamaServer,
    docxToMarkdown: conversion.docxToMarkdown,
    markdownToDocx: conversion.markdownToDocx,
    markdownToEpub: epub.markdownToEpub,
    findChapters: chapters.findChapters,
    PAGEBREAK_MARKER: chapters.PAGEBREAK_MARKER,
    buildCopyEditCorrectionsPrompt: prompts.buildCopyEditCorrectionsPrompt,
    buildLineEditCorrectionsPrompt: prompts.buildLineEditCorrectionsPrompt,
    buildCombinedEditPrompt: prompts.buildCombinedEditPrompt,
    buildTranslationPrompt: prompts.buildTranslationPrompt,
    buildCombinedAnalysisPrompt: prompts.buildCombinedAnalysisPrompt,
    DEFAULT_COPY_EDIT_OPTIONS: types.DEFAULT_COPY_EDIT_OPTIONS,
    DEFAULT_LINE_EDIT_OPTIONS: types.DEFAULT_LINE_EDIT_OPTIONS,
  };
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

type Catalog = typeof import("./modelCatalog.js");

/** Resolve a user-supplied model reference (friendly name / id / tier / file). */
function resolveModel(cat: Catalog, input: string): string {
  if (input.startsWith("custom:")) return input; // API / Ollama / custom gguf
  if (cat.getModelByFileName(input)) return input; // exact catalog filename
  const withExt = input.endsWith(".gguf") ? input : `${input}.gguf`;
  if (cat.getModelByFileName(withExt)) return withExt;
  const n = normalize(input);
  const entry = cat.MODEL_CATALOG.find(
    (e) =>
      normalize(e.id) === n ||
      normalize(e.name) === n ||
      normalize(e.tier) === n ||
      normalize(e.fileName) === n ||
      normalize(e.fileName.replace(/\.gguf$/, "")) === n,
  );
  if (entry) return entry.fileName;
  return input; // pass through: arbitrary gguf filename not in catalog
}

const appDataDir = (): string =>
  path.join(homedir(), "Library/Application Support/Bethaniel/data");

/** backend/data, relative to this file (backend/src/cli.ts) — where the
 *  standalone dev server stores api-config.json / the SQLite db. */
const repoDataDir = (): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

function apiKeyIn(dir: string): boolean {
  try {
    const cfg = JSON.parse(readFileSync(path.join(dir, "api-config.json"), "utf8"));
    return Boolean(cfg?.apiKey);
  } catch {
    return false;
  }
}

/** Decide which DATA_DIR to use, preferring one that already has an API key
 *  when an API model is selected so External Betty works out of the box. */
function resolveDataDir(args: CliArgs, isApi: boolean): string {
  if (args.dataDir) return path.resolve(args.dataDir);
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const appData = appDataDir();
  if (isApi && !args.apiKey) {
    if (apiKeyIn(appData)) return appData;
    if (apiKeyIn(repoDataDir())) return repoDataDir();
  }
  return appData;
}

/** Persist an explicitly-supplied API key into the data dir's api-config.json,
 *  merging with any existing config so the model field is preserved. */
async function saveApiKey(dir: string, key: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(path.join(dir, "api-config.json"), "utf8"));
  } catch {
    /* no existing config */
  }
  const cfg = { model: "deepseek-chat", ...existing, apiKey: key };
  await writeFile(path.join(dir, "api-config.json"), JSON.stringify(cfg, null, 2));
}

/** Replicate frontend buildUnits()/shortChapterLabel for whole-book scope. */
function buildUnits(p: Pipeline, md: string): { name: string; original: string }[] {
  const chapters = p.findChapters(md);
  const strip = (t: string) =>
    t
      .replace(
        new RegExp(p.PAGEBREAK_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
        "",
      )
      .trim();
  if (chapters.length > 0) {
    return chapters.map((ch, i) => {
      const title = ch.title.trim();
      const name = title && !/^section\s+\d+$/i.test(title) ? title : `Ch${i + 1}`;
      return { name, original: strip(md.slice(ch.start, ch.end)) };
    });
  }
  return [{ name: "Manuscript", original: strip(md) }];
}

async function readManuscript(p: Pipeline, inputDoc: string, docId: string): Promise<string> {
  const buf = await readFile(inputDoc);
  if (inputDoc.toLowerCase().endsWith(".docx")) return p.docxToMarkdown(buf, { docId });
  return buf.toString("utf8");
}

// ── Effective jobs ───────────────────────────────────────────────────────────
// Mirror routes.ts: copy + line merge into a single combined_edit; analysis and
// translation are independent. Each job produces its own export file set.
interface Job {
  label: string; // used in the output filename
  taskMode: string;
  prompt: string;
  fast: boolean;
  targetLang?: string;
  editOptions?: Record<string, boolean | string>;
  isAnalysis: boolean;
}

function buildJobs(p: Pipeline, args: CliArgs, styleGuide: string | undefined): Job[] {
  const jobs: Job[] = [];
  const has = (m: CliMode) => args.modes.includes(m);
  const copyOpts = { ...p.DEFAULT_COPY_EDIT_OPTIONS };
  const lineOpts = { ...p.DEFAULT_LINE_EDIT_OPTIONS };

  if (has("copy") && has("line")) {
    jobs.push({
      label: "edit",
      taskMode: "combined_edit",
      prompt: p.buildCombinedEditPrompt(copyOpts, lineOpts, styleGuide),
      fast: true,
      editOptions: { ...copyOpts, ...lineOpts } as Record<string, boolean | string>,
      isAnalysis: false,
    });
  } else if (has("copy")) {
    jobs.push({
      label: "copy",
      taskMode: "copy_edit",
      prompt: p.buildCopyEditCorrectionsPrompt(copyOpts, styleGuide),
      fast: true,
      editOptions: { ...copyOpts } as Record<string, boolean | string>,
      isAnalysis: false,
    });
  } else if (has("line")) {
    jobs.push({
      label: "line",
      taskMode: "line_edit",
      prompt: p.buildLineEditCorrectionsPrompt(lineOpts, styleGuide),
      fast: true,
      editOptions: { ...lineOpts } as Record<string, boolean | string>,
      isAnalysis: false,
    });
  }

  if (has("analysis")) {
    jobs.push({
      label: "analysis",
      taskMode: "combined_analysis",
      prompt: p.buildCombinedAnalysisPrompt(
        ["character_catalog", "location_catalog", "timeline"] as never,
        styleGuide,
      ),
      fast: true,
      isAnalysis: true,
    });
  }

  if (has("translation")) {
    jobs.push({
      label: "translation",
      taskMode: "translate",
      prompt: p.buildTranslationPrompt(args.language!, styleGuide),
      fast: false,
      targetLang: args.language,
      isAnalysis: false,
    });
  }

  return jobs;
}

const TERMINAL = new Set(["done", "error", "cancelled"]);

/** Submit one job's tasks, wait for completion, and return the assembled markdown. */
async function runJob(
  p: Pipeline,
  job: Job,
  units: { name: string; original: string }[],
  source: string,
  model: string,
  styleGuide: string | undefined,
  noReview: boolean,
): Promise<{ finalMd: string; errors: string[] }> {
  const jobId = randomUUID();
  const taskIds: string[] = [];
  for (const unit of units) {
    const id = await p.submitTask({
      jobId,
      name: unit.name,
      source,
      original: unit.original,
      wordCount: unit.original.split(/\s+/).filter(Boolean).length,
      model,
      mode: job.taskMode as never,
      prompt: job.prompt,
      fast: job.fast,
      wpc: 2500,
      overlap: 1,
      editOptions: job.editOptions,
      targetLang: job.targetLang,
      reviewMode: !noReview,
      reviewerThreshold: 3,
      reviewerCount: 1,
      spellCheck: true,
      dualEditor: true,
      dualCount: 2,
      characterDedup: false,
      styleComplianceAgent: Boolean(styleGuide),
      styleGuide,
    });
    taskIds.push(id);
  }

  const printed = new Map<string, string>();
  const logProgress = (): void => {
    const snap = p.getTasksSnapshot();
    for (const t of Object.values(snap)) {
      if (t.jobId !== jobId) continue;
      const line = `[${job.label}] ${t.name} ${t.status} ${t.progress}% ${t.phase}`.trim();
      if (printed.get(t.id) !== line) {
        printed.set(t.id, line);
        console.log(`  ${line}`);
      }
    }
  };

  await new Promise<void>((resolve) => {
    const tick = () => {
      logProgress();
      const snap = p.getTasksSnapshot();
      const mine = taskIds.map((id) => snap[id]).filter(Boolean);
      const done = mine.length === taskIds.length && mine.every((t) => TERMINAL.has(t.status));
      if (!done) return;
      if (job.isAnalysis) {
        // The queue auto-spawns an `analysis_summary` task once the per-chapter
        // analysis tasks finish; wait for it too.
        const summary = Object.values(snap).find(
          (t) => t.jobId === jobId && t.mode === "analysis_summary",
        );
        if (!summary || !TERMINAL.has(summary.status)) return;
      }
      clearInterval(handle);
      resolve();
    };
    const handle = setInterval(tick, 1500);
    tick();
  });

  const snap = p.getTasksSnapshot();
  const errors: string[] = [];
  for (const t of taskIds.map((id) => snap[id])) {
    if (t.status === "error" || t.status === "cancelled")
      errors.push(`${job.label}/${t.name}: ${t.status}`);
    else if (t.result?.errors?.length)
      errors.push(`${job.label}/${t.name}: ${t.result.errors.join("; ")}`);
  }

  let finalMd: string;
  if (job.isAnalysis) {
    const summary = Object.values(snap).find(
      (t) => t.jobId === jobId && t.mode === "analysis_summary",
    );
    finalMd = summary?.result?.editedText ?? "";
    if (summary?.result?.errors?.length)
      errors.push(`${job.label}/summary: ${summary.result.errors.join("; ")}`);
  } else {
    finalMd = taskIds
      .map((id) => snap[id]?.result?.editedText ?? "")
      .join(`\n\n${p.PAGEBREAK_MARKER}\n\n`);
  }

  return { finalMd, errors };
}

async function main(): Promise<void> {
  const args = parseCliArgs();

  try {
    await stat(args.inputDoc);
  } catch {
    fail(`input file not found: ${args.inputDoc}`);
  }

  // Resolve the model first (catalog import is env-free) so we can decide which
  // DATA_DIR to use before the rest of the pipeline reads env at import time.
  const catalog = await import("./modelCatalog.js");
  const model = resolveModel(catalog, args.model);
  const isApi = catalog.isApiModel(model);

  // ── Env setup (must happen before importing the rest of the pipeline) ──
  const dataDir = resolveDataDir(args, isApi);
  if (args.apiKey) await saveApiKey(dataDir, args.apiKey);
  process.env.DATA_DIR = dataDir;
  if (!process.env.MODELS_DIR && process.platform === "darwin") {
    process.env.MODELS_DIR = path.join(
      homedir(),
      "Library/Application Support/Bethaniel/models",
    );
  }

  if (isApi && !apiKeyIn(dataDir)) {
    fail(
      `External Betty API key not found in ${dataDir}. ` +
        `Pass --api-key <key> (saved for next time), --data-dir <dir> pointing ` +
        `at an api-config.json, or configure it once in the desktop app.`,
    );
  }

  const p = await loadPipeline();

  let styleGuide: string | undefined;
  if (args.styleGuidePath) {
    try {
      styleGuide = (await readFile(args.styleGuidePath, "utf8")).trim() || undefined;
    } catch {
      fail(`style guide not found: ${args.styleGuidePath}`);
    }
  }

  const jobs = buildJobs(p, args, styleGuide);

  p.initQueue(null as never, 1); // broadcast() guards `if (!io) return`
  p.setConcurrency(1);

  const docId = randomUUID();
  const md = await readManuscript(p, args.inputDoc, docId);
  const units = buildUnits(p, md);
  const baseName = path.basename(args.inputDoc, path.extname(args.inputDoc));
  const source = path.basename(args.inputDoc);
  const outDir = args.outDir ?? path.dirname(path.resolve(args.inputDoc));
  await mkdir(outDir, { recursive: true });

  console.log(
    `[CLI] model=${model} jobs=${jobs.map((j) => j.label).join(",")} units=${units.length} review=${!args.noReview}${isApi ? ` data-dir=${dataDir}` : ""}`,
  );

  const allErrors: string[] = [];
  let wroteAny = false;

  for (const job of jobs) {
    const { finalMd, errors } = await runJob(
      p,
      job,
      units,
      source,
      model,
      styleGuide,
      args.noReview,
    );
    allErrors.push(...errors);

    if (!finalMd.trim()) {
      console.error(`[CLI] ${job.label}: no output produced — skipping export.`);
      continue;
    }
    for (const fmt of args.exportFormats) {
      const outPath = path.join(outDir, `${baseName}.${job.label}.${fmt}`);
      if (fmt === "md") await writeFile(outPath, finalMd, "utf8");
      else if (fmt === "docx") await writeFile(outPath, await p.markdownToDocx(finalMd));
      else await writeFile(outPath, await p.markdownToEpub(finalMd, { title: baseName }));
      console.log(`[CLI] wrote ${outPath}`);
      wroteAny = true;
    }
  }

  if (allErrors.length) {
    console.error("\n[CLI] errors:");
    for (const e of allErrors) console.error(`  - ${e}`);
  }

  await p.closeQueue();
  await p.shutdownLlamaServer();
  process.exit(allErrors.length || !wroteAny ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
