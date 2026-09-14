#!/usr/bin/env node
/**
 * Are the reviewer and the precision pass worth listening to when they
 * disagree?
 *
 * Every LLM correction reaches the author with two verdicts: the reviewer's
 * confidence (1-5, `confidence`) and the precision pass's (`precisionConfidence`).
 * When both are high the fix is shown ticked; when the reviewer doubts it
 * (<3) it is folded away; when only the precision pass doubts it, it is shown
 * unticked. What this script asks is how often each combination is RIGHT,
 * against planted ground truth — and, for the two cells where the passes
 * disagree outright (1-2 vs 4-5), what hiding them would do to precision and
 * recall overall.
 *
 * Runs the English copy-edit fixtures through the running backend exactly as
 * the app does (review on, spell-check on; LanguageTool as installed), scores
 * each correction with backend/src/benchScoring.ts, and prints the grid.
 *
 * Usage:
 *   npx tsx scripts/bench-verdicts.ts                 # Local Betty, all English fixtures
 *   npx tsx scripts/bench-verdicts.ts --model 9b       # a model whose file name contains "9b"
 *   npx tsx scripts/bench-verdicts.ts --file stress100 # one fixture
 *   npx tsx scripts/bench-verdicts.ts --grammar-off    # do not require LanguageTool
 *
 * Prerequisite: backend on http://127.0.0.1:4000 with a model installed.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  buildGroundTruth,
  correctionCatchesError,
  type PlantedError,
} from "../backend/src/benchScoring.js";
import { DEFAULT_COPY_EDIT_OPTIONS } from "../backend/src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const API = "http://127.0.0.1:4000/api";
const SAMPLES = join(ROOT, "sample_texts");

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const modelFilter = (flag("--model") ?? "4b").toLowerCase();
const fileFilter = flag("--file");
const grammarOff = args.includes("--grammar-off");

const FIXTURES = ["english", "stress100", "stress100b", "stress300en"].filter(
  (f) => !fileFilter || f.includes(fileFilter),
);

interface Correction {
  id?: string;
  original: string;
  corrected: string;
  reason?: string;
  confidence?: number;
  precisionConfidence?: number;
  flagged?: boolean;
  preApproved?: boolean;
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function upload(name: string, content: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "text/markdown" }), name);
  const res = await fetch(`${API}/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload: HTTP ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function waitFor(taskId: string): Promise<Correction[]> {
  for (;;) {
    const task = (await api("GET", `/results/${taskId}`)) as {
      status: string;
      result?: { corrections: Correction[] };
    };
    if (task.status === "done") return task.result?.corrections ?? [];
    if (task.status === "error" || task.status === "cancelled") throw new Error(`task ${task.status}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

type Cell = { right: number; wrong: number; examples: string[] };
const cell = (): Cell => ({ right: 0, wrong: 0, examples: [] });

/** Which cell a correction lands in, by its two verdicts. */
function bucketOf(c: Correction): string {
  const r = c.confidence;
  const p = c.precisionConfidence;
  const band = (x: number | undefined) => (x == null ? "none" : x <= 2 ? "low" : x >= 4 ? "high" : "mid");
  return `reviewer ${band(r)} / precision ${band(p)}`;
}

async function main() {
  const installed = (await api("GET", "/models/installed")) as { installed: { fileName: string }[] };
  const model = installed.installed.find((m) => m.fileName.toLowerCase().includes(modelFilter))?.fileName;
  if (!model) throw new Error(`no installed model matching "${modelFilter}"`);
  console.log(`model: ${model}\nfixtures: ${FIXTURES.join(", ")}\n`);

  const cells = new Map<string, Cell>();
  let totalRight = 0;
  let totalWrong = 0;
  let totalPlanted = 0;
  const all: { fixture: string; c: Correction; right: boolean }[] = [];

  for (const fixture of FIXTURES) {
    const errored = readFileSync(join(SAMPLES, `${fixture}_copy_edit.md`), "utf8");
    const correct = readFileSync(join(SAMPLES, `${fixture}_correct.md`), "utf8");
    const truth: PlantedError[] = buildGroundTruth(errored, correct);
    totalPlanted += truth.length;

    const docId = await upload(`${fixture}_copy_edit.md`, errored);
    const job = (await api("POST", "/queue/add", {
      docId,
      units: [{ name: fixture, original: errored }],
      model,
      modes: ["copy_edit"],
      wordsPerChunk: 2500,
      overlapParagraphs: 1,
      parallel: 1,
      editOptions: { ...DEFAULT_COPY_EDIT_OPTIONS, englishDialect: "british" },
      manuscriptLang: "en",
      reviewMode: true,
      spellCheck: true,
      grammarCheck: !grammarOff,
      retextCheck: true,
      runMode: "speed",
    })) as { taskIds: string[] };
    process.stdout.write(`${fixture}: ${truth.length} planted errors — running… `);
    const t0 = Date.now();
    const corrections = await waitFor(job.taskIds[0]);
    console.log(`${corrections.length} corrections in ${Math.round((Date.now() - t0) / 1000)} s`);

    // A correction is right when it catches a planted error nobody else
    // claimed first (the same greedy rule as scoreCorrections).
    const claimed = new Set<number>();
    for (const c of corrections) {
      if (c.reason === "dialect") continue;
      const hit = truth.findIndex((err, i) => !claimed.has(i) && correctionCatchesError(c, err));
      const right = hit >= 0;
      if (right) claimed.add(hit);
      const key = bucketOf(c);
      const cl = cells.get(key) ?? cell();
      if (right) cl.right++;
      else cl.wrong++;
      if (!right && cl.examples.length < 3) cl.examples.push(`${c.original} → ${c.corrected}`);
      cells.set(key, cl);
      if (right) totalRight++;
      else totalWrong++;
      all.push({ fixture, c, right });
    }
  }

  const pct = (a: number, b: number) => (b === 0 ? "—" : `${Math.round((100 * a) / b)}%`);
  console.log(`\nOverall: ${totalRight} right, ${totalWrong} wrong of ${totalRight + totalWrong} shown; ` +
    `precision ${pct(totalRight, totalRight + totalWrong)}, recall ${pct(totalRight, totalPlanted)} of ${totalPlanted} planted\n`);
  console.log("By verdict pair (low = 1-2, mid = 3, high = 4-5):");
  const rows = [...cells.entries()].sort((a, b) => b[1].right + b[1].wrong - (a[1].right + a[1].wrong));
  for (const [key, cl] of rows) {
    const n = cl.right + cl.wrong;
    console.log(`  ${key.padEnd(36)} n=${String(n).padStart(3)}  right ${pct(cl.right, n).padStart(4)}` +
      (cl.wrong ? `   e.g. ${cl.examples.join(" | ")}` : ""));
  }

  // What hiding a cell would do to the whole.
  console.log("\nIf a cell were hidden:");
  for (const [key, cl] of rows) {
    const n = cl.right + cl.wrong;
    if (n < 3) continue;
    const r = totalRight - cl.right;
    const w = totalWrong - cl.wrong;
    console.log(`  hide ${key.padEnd(36)} → precision ${pct(r, r + w)} (from ${pct(totalRight, totalRight + totalWrong)}), ` +
      `recall ${pct(r, totalPlanted)} (from ${pct(totalRight, totalPlanted)})`);
  }

  const out = join(SAMPLES, "verdict_bench_results.json");
  writeFileSync(out, JSON.stringify({ model, runDate: new Date().toISOString(), fixtures: FIXTURES, corrections: all }, null, 1));
  console.log(`\nsaved ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
