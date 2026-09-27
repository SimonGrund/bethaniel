#!/usr/bin/env node
/**
 * Was the precision pass worth what it cost?
 *
 * Kept as the record of why that pass was REMOVED (27 September 2026) — see
 * docs/cloud-token-model.md. It reads benchmark results saved while the pass
 * still ran (they carry precisionConfidence); on results from after its
 * removal it finds nothing to score. What the pass did, and what this
 * measured against planted ground truth:
 *
 *   flag     scores 1-2 on a correction the reviewer passed → the card says
 *            "second opinion differed". Worth it if those are mostly wrong.
 *   demote   scores 1-2 on a spell-check / grammar / retext finding → it is
 *            no longer a readthrough blocker (correctionSeverity.ts). Worth it
 *            if those are mostly wrong.
 *   nudge    shifts the displayed certainty a few points (types.ts).
 *
 * Usage: npx tsx scripts/precision-pass-value.ts sample_texts/benchmark_results_cloud.json [...]
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildGroundTruth, correctionCatchesError, touchesErrorSpan, type PlantedError } from "../backend/src/benchScoring.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SAMPLE = join(ROOT, "sample_texts");

interface C { original: string; corrected: string; confidence?: number; precisionConfidence?: number; reason?: string; preApproved?: boolean; flagged?: boolean }
type Verdict = "right" | "wrongFix" | "noError";

function label(c: C, gt: PlantedError[]): Verdict {
  if (gt.some((e) => correctionCatchesError(c, e))) return "right";
  if (gt.some((e) => touchesErrorSpan(c, e))) return "wrongFix";
  return "noError";
}
const DETERMINISTIC = (r = "") => r === "spell-check" || r.startsWith("grammar:") || r.startsWith("retext:");

for (const path of process.argv.slice(2)) {
  const rows = JSON.parse(readFileSync(join(ROOT, path), "utf-8")) as { model: string; file: string; variant: string; mode: string; repeatIndex: number; corrections: C[] }[];
  const b: Record<string, Record<Verdict, number>> = {};
  const add = (k: string, v: Verdict) => { (b[k] ??= { right: 0, wrongFix: 0, noError: 0 })[v]++; };
  for (const r of rows) {
    if (r.mode !== "copy_edit" || r.repeatIndex !== 1) continue;
    const [fixture] = r.file.replace(/\.md$/, "").split("_");
    const text = readFileSync(join(SAMPLE, r.file), "utf-8");
    const gt = r.variant === "correct" ? [] : buildGroundTruth(text, readFileSync(join(SAMPLE, `${fixture}_correct.md`), "utf-8"));
    for (const c of r.corrections) {
      if (c.preApproved || c.precisionConfidence == null) { add("not scored by the pass", label(c, gt)); continue; }
      const v = label(c, gt);
      const rev = c.confidence ?? 0, pre = c.precisionConfidence;
      add(`all scored`, v);
      if (rev >= 3 && pre <= 2) add("FLAG: reviewer passed, pass doubted", v);
      if (rev >= 3 && pre >= 3) add("both passed", v);
      if (rev <= 2 && pre >= 4) add("NUDGE UP: reviewer doubted, pass confident", v);
      if (DETERMINISTIC(c.reason) && pre <= 2) add("DEMOTE: rule finding the pass doubted", v);
      if (DETERMINISTIC(c.reason) && pre >= 3) add("rule finding the pass accepted", v);
      // Would the main reviewer alone have made the same call? The pass is
      // only worth its tokens where it adds a verdict the reviewer did not.
      if (DETERMINISTIC(c.reason) && pre <= 2 && rev <= 2) add("  DEMOTE, reviewer also doubted", v);
      if (DETERMINISTIC(c.reason) && pre <= 2 && rev >= 3) add("  DEMOTE, only the pass doubted", v);
      if (DETERMINISTIC(c.reason) && rev <= 2) add("rule finding the REVIEWER doubted", v);
    }
  }
  console.log(`\n== ${rows[0]?.model}`);
  for (const [k, t] of Object.entries(b)) {
    const n = t.right + t.wrongFix + t.noError;
    console.log(`  ${k.padEnd(44)} n=${String(n).padStart(4)}   right ${String(t.right).padStart(4)} (${Math.round((100 * t.right) / n)}%)   wrong fix ${String(t.wrongFix).padStart(3)}   no error there ${String(t.noError).padStart(4)}`);
  }
}
