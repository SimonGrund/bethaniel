/**
 * bench-chapters.ts — per-chapter A/B benchmark for run-mode presets.
 *
 * Like bench-modes.ts, but treats EVERY chapter of a book as its own sample so
 * the Speed-vs-Max quality comparison has many data points instead of one. Runs
 * each mode over all chapters (fanned out through the queue), then diffs the
 * auto-applied corrections chapter-by-chapter.
 *
 *   npm run bench:chapters -- --doc "/path/Original.docx" --model custom:deepseek-chat
 *
 * Handles .docx (uploaded as binary, converted server-side) and .md. Per-chapter
 * PROCESSING time uses each task's own started/finished stamps (clean under
 * concurrency); per-mode WALL-CLOCK is the batch throughput.
 */

import { readFile } from "fs/promises";
import { basename, extname } from "path";
import { FALLBACK_MODEL_FILENAME } from "../src/modelCatalog.js";
import type { Correction, TaskState, DocumentMeta } from "../src/types.js";

type RunMode = "speed" | "balanced" | "max";
function parseArgs(argv: string[]) {
  const modes: RunMode[] = [];
  let doc = "";
  let model = FALLBACK_MODEL_FILENAME;
  let base =
    process.env.BENCH_BASE ??
    `http://localhost:${process.env.BETHANIEL_PORT ?? 4000}`;
  let parallel = 8;
  let limit = Infinity; // cap chapters (safety for paid APIs)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") modes.push(argv[++i] as RunMode);
    else if (a === "--doc") doc = argv[++i];
    else if (a === "--model") model = argv[++i];
    else if (a === "--base") base = argv[++i];
    else if (a === "--parallel") parallel = Number(argv[++i]);
    else if (a === "--limit") limit = Number(argv[++i]);
  }
  if (!doc) throw new Error("--doc <path> is required");
  return {
    modes: modes.length ? modes : (["speed", "max"] as RunMode[]),
    doc,
    model,
    base: base.replace(/\/$/, ""),
    parallel,
    limit,
  };
}

const args = parseArgs(process.argv.slice(2));
const API = `${args.base}/api`;

async function jsonFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${API}${path}`, init);
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const terminal = (s: string) => s === "done" || s === "error" || s === "cancelled";

// ── Correction helpers (mirror bench-modes.ts) ──
const key = (c: Correction) => `${c.original}→${c.corrected}`;
const isReal = (c: Correction) => c.original !== c.corrected;
const surfaced = (t: TaskState) => (t.result?.corrections ?? []).filter(isReal);
const applied = (t: TaskState) => surfaced(t).filter((c) => !c.flagged);
const flaggedCount = (t: TaskState) => surfaced(t).filter((c) => c.flagged).length;

async function uploadDoc(path: string): Promise<{ id: string; name: string }> {
  const buf = await readFile(path);
  const name = basename(path);
  const isDocx = extname(path).toLowerCase() === ".docx";
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([buf], {
      type: isDocx
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "text/markdown",
    }),
    name,
  );
  const res = await fetch(`${API}/upload`, { method: "POST", body: fd });
  if (!res.ok) throw new Error(`upload → ${res.status} ${await res.text()}`);
  const d = await res.json();
  return { id: d.id, name: d.name };
}

/** Build one unit per chapter from the stored document markdown. */
function chapterUnits(doc: DocumentMeta): { name: string; original: string }[] {
  const chs = doc.chapters ?? [];
  if (chs.length === 0) return [{ name: "Manuscript", original: doc.md.trim() }];
  return chs.map((ch: any, i: number) => ({
    name: `Ch${String(i + 1).padStart(2, "0")}: ${ch.title || "(untitled)"}`.slice(0, 60),
    original: doc.md.slice(ch.start, ch.end).trim(),
  }));
}

/** Submit all chapters for one mode, poll every task to completion. */
async function runModeAllChapters(
  docId: string,
  units: { name: string; original: string }[],
  mode: RunMode,
): Promise<{ tasks: TaskState[]; wallMs: number }> {
  const started = Date.now();
  const { taskIds } = await jsonFetch("/queue/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      docId,
      units,
      model: args.model,
      modes: ["copy_edit"],
      runMode: mode,
      parallel: args.parallel,
    }),
  });
  const ids: string[] = taskIds;
  // Poll until every task is terminal.
  for (;;) {
    const tasks = (await Promise.all(
      ids.map((id) => jsonFetch(`/results/${id}`) as Promise<TaskState>),
    )) as TaskState[];
    const done = tasks.filter((t) => terminal(t.status)).length;
    process.stdout.write(`\r  ${mode}: ${done}/${ids.length} chapters done   `);
    if (done === ids.length) {
      process.stdout.write("\n");
      return { tasks, wallMs: Date.now() - started };
    }
    await sleep(3000);
  }
}

function procMs(t: TaskState): number {
  if (t.startedAt && t.finishedAt) return t.finishedAt - t.startedAt;
  return 0;
}
const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtMin = (ms: number) => `${(ms / 60000).toFixed(1)}min`;

async function main() {
  console.log(`\n📖 doc:   ${args.doc}`);
  console.log(`🤖 model: ${args.model}`);
  console.log(`⚙️  modes: ${args.modes.join(", ")}   parallel=${args.parallel}`);
  console.log(`🌐 api:   ${API}\n`);

  const up = await uploadDoc(args.doc);
  const doc = (await jsonFetch(`/documents/${up.id}`)) as DocumentMeta;
  let units = chapterUnits(doc);
  if (units.length > args.limit) {
    console.log(`⚠️  capping ${units.length} → ${args.limit} chapters (--limit)`);
    units = units.slice(0, args.limit);
  }
  console.log(`📚 ${units.length} chapters, ${doc.wordCount} words total\n`);

  const perMode: Record<string, { tasks: TaskState[]; wallMs: number }> = {};
  for (const mode of args.modes) {
    perMode[mode] = await runModeAllChapters(up.id, units, mode);
  }

  // ── Per-mode totals ──
  console.log("\n── Per-mode totals ─────────────────────────────────────");
  console.log("mode      applied  flagged   errors   wall-clock");
  for (const mode of args.modes) {
    const { tasks, wallMs } = perMode[mode];
    const ap = tasks.reduce((s, t) => s + applied(t).length, 0);
    const fl = tasks.reduce((s, t) => s + flaggedCount(t), 0);
    const er = tasks.filter((t) => t.status === "error").length;
    console.log(
      `${mode.padEnd(9)} ${String(ap).padStart(7)} ${String(fl).padStart(8)} ${String(er).padStart(8)}   ${fmtMin(wallMs)}`,
    );
  }

  // ── Per-chapter applied diff: heaviest available mode = reference ──
  const ranked = (["max", "balanced", "speed"] as RunMode[]).filter((m) =>
    args.modes.includes(m),
  );
  if (ranked.length >= 2) {
    const ref = ranked[0];
    const cmp = ranked[ranked.length - 1]; // lightest = the one we worry about
    const refT = perMode[ref].tasks;
    const cmpT = perMode[cmp].tasks;

    console.log(`\n── Per-chapter APPLIED diff: ${cmp} vs ${ref} (reference) ──`);
    console.log(
      `chapter                          ${cmp}  ${ref}  both  ${ref}-only  ${cmp}-only   ${cmp}-time  ${ref}-time`,
    );
    let tBoth = 0, tRefOnly = 0, tCmpOnly = 0, tRefApplied = 0, tCmpApplied = 0;
    let tCmpProc = 0, tRefProc = 0;
    for (let i = 0; i < refT.length; i++) {
      const rc = new Set(applied(refT[i]).map(key));
      const cc = new Set(applied(cmpT[i]).map(key));
      const both = [...cc].filter((k) => rc.has(k)).length;
      const refOnly = [...rc].filter((k) => !cc.has(k)).length;
      const cmpOnly = [...cc].filter((k) => !rc.has(k)).length;
      tBoth += both; tRefOnly += refOnly; tCmpOnly += cmpOnly;
      tRefApplied += rc.size; tCmpApplied += cc.size;
      tCmpProc += procMs(cmpT[i]); tRefProc += procMs(refT[i]);
      const label = (cmpT[i].name || refT[i].name || `ch${i}`).padEnd(32).slice(0, 32);
      console.log(
        `${label} ${String(cc.size).padStart(4)} ${String(rc.size).padStart(4)} ${String(both).padStart(5)} ` +
          `${String(refOnly).padStart(7)} ${String(cmpOnly).padStart(8)}   ${fmtMs(procMs(cmpT[i])).padStart(7)} ${fmtMs(procMs(refT[i])).padStart(8)}`,
      );
    }
    console.log("─".repeat(96));
    const n = refT.length;
    console.log(
      `TOTALS (${n} chapters)              ${String(tCmpApplied).padStart(4)} ${String(tRefApplied).padStart(4)} ${String(tBoth).padStart(5)} ` +
        `${String(tRefOnly).padStart(7)} ${String(tCmpOnly).padStart(8)}   ${fmtMs(tCmpProc).padStart(7)} ${fmtMs(tRefProc).padStart(8)}`,
    );
    const overlapPct = tRefApplied ? ((tBoth / tRefApplied) * 100).toFixed(0) : "—";
    const procSpeedup = tCmpProc ? (tRefProc / tCmpProc).toFixed(1) : "—";
    console.log(`\n  ${cmp} reproduced ${overlapPct}% of ${ref}'s applied corrections`);
    console.log(`  ${cmp} applied ${tCmpApplied} vs ${ref} ${tRefApplied}  (${ref}-only: ${tRefOnly}, ${cmp}-only: ${tCmpOnly})`);
    console.log(`  compute time: ${cmp} ${fmtMin(tCmpProc)} vs ${ref} ${fmtMin(tRefProc)}  → ${procSpeedup}× less compute`);
    console.log(`  wall-clock:   ${cmp} ${fmtMin(perMode[cmp].wallMs)} vs ${ref} ${fmtMin(perMode[ref].wallMs)}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("\n❌ bench failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
