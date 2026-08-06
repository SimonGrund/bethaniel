/**
 * bench-modes.ts — A/B benchmark for run-mode presets (Speed vs Max).
 *
 * Runs the SAME chapter through the real pipeline in two (or more) run modes
 * and compares the correction sets + wall-clock, so the "minimal quality loss"
 * claim behind Speed mode has real numbers behind it.
 *
 * This is an HTTP client — it drives the running backend exactly as the app
 * does. Start the app (or `npm run dev` in backend/) with a model available,
 * then:
 *
 *   npm run bench:modes                          # Speed vs Max, default model, fixture
 *   npm run bench:modes -- --doc ../mybook.md    # a real manuscript
 *   npm run bench:modes -- --model custom:deepseek-chat   # External Betty
 *   npm run bench:modes -- --mode speed --mode balanced --mode max
 *
 * Runs are sequential (clean wall-clock, no model-reload clashes). It compares
 * every surfaced correction keyed by (original → corrected):
 *   overlap        both modes surfaced it
 *   speed-missed   a heavier mode caught it, Speed did not  (the quality risk)
 *   speed-only     Speed surfaced it, the heavier mode did not
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { DEFAULT_MODEL_FILENAME } from "../src/modelCatalog.js";
import type { Correction, TaskState } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Args ──────────────────────────────────────────────────────────────────
type RunMode = "speed" | "balanced" | "max";
function parseArgs(argv: string[]) {
  const modes: RunMode[] = [];
  let doc = join(__dirname, "..", "test", "fixtures", "bench-chapter.md");
  let model = DEFAULT_MODEL_FILENAME;
  let base =
    process.env.BENCH_BASE ??
    `http://localhost:${process.env.BETHANIEL_PORT ?? 4000}`;
  let parallel: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") modes.push(argv[++i] as RunMode);
    else if (a === "--doc") doc = argv[++i];
    else if (a === "--model") model = argv[++i];
    else if (a === "--base") base = argv[++i];
    else if (a === "--parallel") parallel = Number(argv[++i]);
  }
  return {
    modes: modes.length ? modes : (["speed", "max"] as RunMode[]),
    doc,
    model,
    base: base.replace(/\/$/, ""),
    parallel,
  };
}

const args = parseArgs(process.argv.slice(2));
const API = `${args.base}/api`;

// ── Small HTTP helpers ──────────────────────────────────────────────────────
async function jsonFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function uploadDoc(text: string, name: string): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([text], { type: "text/markdown" }), name);
  const res = await fetch(`${API}/upload`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`upload → ${res.status} ${await res.text()}`);
  const doc = await res.json();
  return doc.id as string;
}

/** Submit one run and poll to completion. Returns the finished task. */
async function runMode(
  docId: string,
  text: string,
  mode: RunMode,
): Promise<{ task: TaskState; wallMs: number }> {
  const started = Date.now();
  const { taskIds } = await jsonFetch("/queue/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      docId,
      units: [{ name: "Bench chapter", original: text }],
      model: args.model,
      modes: ["copy_edit"],
      runMode: mode,
      // Let the preset fill the editor/reviewer/pass knobs server-side.
      ...(args.parallel != null ? { parallel: args.parallel } : {}),
    }),
  });
  const taskId = taskIds[0];
  if (!taskId) throw new Error(`no task id returned for mode ${mode}`);

  // Poll the full task until terminal.
  for (;;) {
    const task = (await jsonFetch(`/results/${taskId}`)) as TaskState;
    if (task.status === "done" || task.status === "error" || task.status === "cancelled") {
      return { task, wallMs: Date.now() - started };
    }
    await sleep(1000);
  }
}

// ── Correction-set comparison ───────────────────────────────────────────────
const key = (c: Correction) => `${c.original}→${c.corrected}`;
// Degenerate no-ops: the spell/grammar layer sometimes emits original === corrected
// (a suspect flag with no confident fix). They aren't real edits — drop them so
// the diff isn't dominated by noise.
const isReal = (c: Correction) => c.original !== c.corrected;
function surfaced(task: TaskState): Correction[] {
  const r = task.result;
  if (!r) return [];
  return (r.corrections ?? []).filter(isReal);
}
// Auto-applied (high-confidence) corrections only — the meaningful quality
// signal. Flagged corrections are surfaced for manual accept/dismiss in BOTH
// modes, so they measure "candidates generated", not applied quality.
const applied = (task: TaskState) => surfaced(task).filter((c) => !c.flagged);

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function main() {
  const text = await readFile(args.doc, "utf-8");
  console.log(`\n📖 doc:   ${args.doc}`);
  console.log(`🤖 model: ${args.model}`);
  console.log(`⚙️  modes: ${args.modes.join(", ")}`);
  console.log(`🌐 api:   ${API}\n`);

  const docId = await uploadDoc(text, "bench-chapter.md");

  const results: Record<string, { task: TaskState; wallMs: number }> = {};
  for (const mode of args.modes) {
    process.stdout.write(`▶ running ${mode}… `);
    const r = await runMode(docId, text, mode);
    results[mode] = r;
    if (r.task.status === "error") {
      console.log(`ERROR: ${r.task.result?.errors?.join("; ") ?? "unknown"}`);
    } else {
      const cs = surfaced(r.task);
      const flagged = cs.filter((c) => c.flagged).length;
      console.log(
        `${cs.length} corrections (${flagged} flagged) in ${fmtMs(r.wallMs)}` +
          (r.task.tokPerSec ? ` @ ${r.task.tokPerSec} tok/s` : ""),
      );
    }
  }

  // ── Per-mode summary table ──
  console.log("\n── Summary ─────────────────────────────────────────────");
  console.log("mode      corrections  flagged  applied   wall     tok/s");
  for (const mode of args.modes) {
    const { task, wallMs } = results[mode];
    const cs = surfaced(task);
    const flagged = cs.filter((c) => c.flagged).length;
    console.log(
      `${mode.padEnd(9)} ${String(cs.length).padStart(11)} ${String(flagged).padStart(8)} ` +
        `${String(cs.length - flagged).padStart(8)}  ${fmtMs(wallMs).padStart(6)}  ${task.tokPerSec ?? "-"}`,
    );
  }

  // ── Pairwise diff on APPLIED corrections (the quality signal) ──
  // Flagged suggestions are excluded: both modes surface them for manual
  // review, so they measure candidate volume, not applied quality.
  const ranked: RunMode[] = ["max", "balanced", "speed"].filter((m) =>
    args.modes.includes(m as RunMode),
  ) as RunMode[];
  if (ranked.length >= 2) {
    const ref = ranked[0]; // heaviest available = quality reference
    const refSet = new Map(applied(results[ref].task).map((c) => [key(c), c]));
    for (const mode of ranked.slice(1)) {
      const set = new Map(applied(results[mode].task).map((c) => [key(c), c]));
      const overlap = [...set.keys()].filter((k) => refSet.has(k));
      const missed = [...refSet.keys()].filter((k) => !set.has(k)); // ref applied, mode didn't
      const only = [...set.keys()].filter((k) => !refSet.has(k)); // mode applied, ref didn't
      const speedup = results[ref].wallMs / Math.max(1, results[mode].wallMs);

      console.log(`\n── ${mode} vs ${ref} (reference) — APPLIED only ${"─".repeat(12)}`);
      console.log(`  ${speedup.toFixed(1)}× faster than ${ref}`);
      console.log(`  applied by both:        ${overlap.length}`);
      console.log(`  ${ref}-only applied:    ${missed.length}  (${ref} applied, ${mode} did not)`);
      console.log(`  ${mode}-only applied:  ${only.length}  (${mode} applied, ${ref} did not)`);
      console.log(
        `  flagged (manual review): ${mode} ${surfaced(results[mode].task).filter((c) => c.flagged).length}` +
          ` vs ${ref} ${surfaced(results[ref].task).filter((c) => c.flagged).length}`,
      );
      if (missed.length) {
        console.log(`  — applied by ${ref} but not ${mode} —`);
        for (const k of missed.slice(0, 25)) {
          const c = refSet.get(k)!;
          console.log(`      "${c.original}" → "${c.corrected}"  [${c.reason ?? "?"}]`);
        }
        if (missed.length > 25) console.log(`      …and ${missed.length - 25} more`);
      }
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error("\n❌ bench failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
