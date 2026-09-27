#!/usr/bin/env node
/**
 * The figures the website's Performance page shows, computed from benchmark
 * results rather than read off a report by hand.
 *
 * The page's numbers used to be transcribed from benchmark_results.txt, and
 * nothing recorded how — which categories count, whether a figure is out of
 * the planted errors or out of the ones Betty found. Written down here, they
 * are re-derived after every run, per engine, and the page cannot quietly
 * change what a number means.
 *
 * Usage:
 *   npx tsx scripts/performance-summary.ts \
 *     local=sample_texts/benchmark_results_local.json \
 *     cloud=sample_texts/benchmark_results_cloud.json
 *
 * Writes sample_texts/performance_summary.json and prints the same table.
 *
 * DEFINITIONS (copy edit only — the page is about finding errors):
 *
 *   shown      a correction the author is actually shown. Betty holds back
 *              one the reviewer scored 1 (displayed as 10%, or 18% when the
 *              second check disagrees): it is right about 6% of the time.
 *              See frontend/src/deckProgress.ts. Everything below counts
 *              shown corrections only.
 *   surfaced   a shown correction landed on the planted error's span, right
 *              fix or not — the author's attention is drawn to it.
 *              Percent of planted errors.
 *   correct fix  of the SURFACED errors, how many carried the right text —
 *              "Betty suggested the correct fix". Percent of surfaced, not of
 *              planted, so a category is not punished twice for a miss.
 *   false alarm  a shown correction where nothing was planted: on an
 *              error-planted text, one that touches no planted error; on a
 *              clean text, every one. Sorted into the same categories by the
 *              classifier that sorts planted errors (a comma added is a
 *              comma false alarm, a word inserted a missing-word one).
 *   commas     scored as reconstructing the text the fixture was planted
 *              from — one right answer per comma — which understates a
 *              pass that places commas differently but defensibly.
 *
 * The dropped-word fixtures (missing*) supply the "missing word" row only; the
 * other rows come from every other copy-edit fixture.
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  buildGroundTruth,
  classifyPlantedError,
  recallByCategory,
  scoreCorrections,
  type WordChecks,
} from "../backend/src/benchScoring.js";
import { getWordValidator, initSpellchecker } from "../backend/src/spellcheck.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SAMPLE_DIR = process.env.PERF_SAMPLE_DIR ?? join(ROOT, "sample_texts");

/** Fixture name → ISO language. Mirrors LANG_CODE in test-models.ts. */
const LANG: Record<string, string> = {
  english: "en", danish: "da", german: "de", spanish: "es",
  stress100: "en", stress100b: "en", stress300en: "en",
  stress100da: "da", stress100de: "de", stress100es: "es", stress100fr: "fr",
  missing300en: "en", missingda: "da", missingde: "de", missinges: "es", missingfr: "fr",
};

/** The table's rows, in the page's order. "spelling" (no dictionary) folds
 *  into misspelling; "other" is several planted errors merged into one span. */
const ROWS = [
  "misspelling", "wordChoice", "dialect", "capitalization", "duplicateWord",
  "punctuation", "comma", "missingWord", "other",
] as const;
type RowName = (typeof ROWS)[number];
const rowOf = (cat: string): RowName => (cat === "spelling" ? "misspelling" : (cat as RowName));

interface Correction { original: string; corrected: string; flagged?: boolean; confidence?: number; reason?: string }
interface Row {
  model: string;
  file: string;
  variant: string;
  mode: string;
  repeatIndex: number;
  corrections: Correction[];
  errors: string[];
  runtimeMs: number;
  runDate?: string;
}

/** Held back by default: the reviewer's 1 (deckProgress.ts) — except a
 *  dialect conversion, which is a setting the author chose and is applied as
 *  chosen whatever the reviewer scored (ReviewExport.tsx). */
const shown = (c: Correction) => c.reason === "dialect" || c.confidence !== 1;

const checksCache = new Map<string, WordChecks | null>();
function checksFor(lang: string): WordChecks | null {
  if (!checksCache.has(lang)) {
    const own = getWordValidator(lang, lang === "en" ? { englishDialect: "american" } : undefined);
    const other = lang === "en" ? getWordValidator("en", { englishDialect: "british" }) : null;
    checksCache.set(lang, own ? { isKnownWord: own, isKnownInOtherDialect: other ?? undefined } : null);
  }
  return checksCache.get(lang)!;
}
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const pct = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);

interface Tally { planted: number; surfaced: number; correctFix: number; falseAlarms: number }
const empty = (): Tally => ({ planted: 0, surfaced: 0, correctFix: 0, falseAlarms: 0 });
const view = (t: Tally) => ({
  ...t,
  surfacedPct: pct(t.surfaced, t.planted),
  correctFixOfSurfacedPct: pct(t.correctFix, t.surfaced),
});

function summarise(rows: Row[]) {
  const table = new Map<RowName, Tally>(ROWS.map((r) => [r, empty()]));
  const byLanguage = new Map<string, Tally>();
  const missingByLanguage = new Map<string, Tally>();
  let wrongFix = 0, damaging = 0, heldBack = 0, shownTotal = 0;
  let textWords = 0, cleanWords = 0, copyWords = 0, copyMs = 0, erroredRuns = 0;

  const falseAlarm = (c: Correction, lang: string) => {
    const cat = rowOf(classifyPlantedError({ wrong: c.original, right: c.corrected }, checksFor(lang)));
    (table.get(cat) ?? table.get("other")!).falseAlarms++;
  };

  for (const r of rows) {
    if (r.mode !== "copy_edit" || r.repeatIndex !== 1) continue;
    if (r.errors.length > 0) erroredRuns++;
    const [fixture] = r.file.replace(/\.md$/, "").split("_");
    const lang = LANG[fixture] ?? "en";
    const text = readFileSync(join(SAMPLE_DIR, r.file), "utf-8");
    const visible = r.corrections.filter(shown);
    heldBack += r.corrections.length - visible.length;
    shownTotal += visible.length;
    textWords += words(text);

    if (r.variant === "correct") {
      cleanWords += words(text);
      for (const c of visible) falseAlarm(c, lang);
      continue;
    }
    if (r.variant !== "copy_edit") continue;
    copyWords += words(text);
    copyMs += r.runtimeMs;

    const gt = buildGroundTruth(text, readFileSync(join(SAMPLE_DIR, `${fixture}_correct.md`), "utf-8"));
    const checks = checksFor(lang) ?? undefined;
    const sc = scoreCorrections(visible, gt, checks);
    wrongFix += sc.falsePositiveBreakdown.wrongFix.length;
    damaging += sc.falsePositiveBreakdown.wrongFixDamaging.length;
    for (const c of sc.falsePositiveBreakdown.hallucination) falseAlarm(c, lang);

    const isMissing = fixture.startsWith("missing");
    for (const c of recallByCategory(gt, sc.missedErrors, checks, visible)) {
      if (c.planted === 0) continue;
      // The dropped-word fixtures feed only their own row.
      if (isMissing && c.category !== "missingWord") continue;
      const t = table.get(rowOf(c.category))!;
      t.planted += c.planted; t.surfaced += c.surfaced; t.correctFix += c.caught;
      const byLang = isMissing ? missingByLanguage : byLanguage;
      const l = byLang.get(lang) ?? empty();
      l.planted += c.planted; l.surfaced += c.surfaced; l.correctFix += c.caught;
      byLang.set(lang, l);
    }
  }

  const all = [...table.values()].reduce((a, t) => {
    a.planted += t.planted; a.surfaced += t.surfaced; a.correctFix += t.correctFix; a.falseAlarms += t.falseAlarms;
    return a;
  }, empty());
  const noCommas = [...table].filter(([k]) => k !== "comma").reduce((a, [, t]) => {
    a.planted += t.planted; a.surfaced += t.surfaced; a.correctFix += t.correctFix; a.falseAlarms += t.falseAlarms;
    return a;
  }, empty());

  return {
    model: rows[0]?.model ?? "?",
    measured: (rows.map((r) => r.runDate).filter(Boolean).sort().pop() ?? "").slice(0, 10),
    table: Object.fromEntries([...table].map(([k, t]) => [k, view(t)])),
    all: view(all),
    allExceptCommas: view(noCommas),
    byLanguage: Object.fromEntries([...byLanguage].map(([k, t]) => [k, view(t)])),
    missingWordByLanguage: Object.fromEntries([...missingByLanguage].map(([k, t]) => [k, view(t)])),
    wrongSuggestions: { total: wrongFix, damaging, damagingPct: pct(damaging, wrongFix) },
    words: { checked: textWords, clean: cleanWords },
    heldBack: { corrections: heldBack, ofAll: pct(heldBack, heldBack + shownTotal) },
    speed: { wordsPerMinute: copyMs > 0 ? Math.round(copyWords / (copyMs / 60000)) : null },
    runsWithErrors: erroredRuns,
  };
}

const LABEL: Record<RowName, string> = {
  misspelling: "Misspelling", wordChoice: "Wrong word", dialect: "Dialect",
  capitalization: "Capitalisation", duplicateWord: "Doubled word", punctuation: "Punctuation",
  comma: "Comma", missingWord: "Missing word", other: "Several at once",
};

async function main() {
  await initSpellchecker();
  const inputs = process.argv.slice(2).map((a) => a.split("=") as [string, string]);
  if (inputs.length === 0) {
    console.error("usage: performance-summary.ts label=results.json [label=results.json ...]");
    process.exit(1);
  }
  const engines: Record<string, ReturnType<typeof summarise>> = {};
  for (const [label, path] of inputs) {
    engines[label] = summarise(JSON.parse(readFileSync(join(ROOT, path), "utf-8")) as Row[]);
  }
  const out = { generated: new Date().toISOString(), definitions: "see the header of scripts/performance-summary.ts", engines };
  writeFileSync(join(SAMPLE_DIR, "performance_summary.json"), JSON.stringify(out, null, 2) + "\n");

  const fmt = (v: number | null) => (v === null ? "  —  " : `${v.toFixed(1).padStart(5)}%`);
  for (const [label, e] of Object.entries(engines)) {
    console.log(`\n══ ${label}: ${e.model} (measured ${e.measured}) — ${e.words.checked} words checked ══`);
    console.log(`${"".padEnd(17)}${"planted".padStart(8)}  surfaced  correct fix  false alarms`);
    const line = (name: string, t: ReturnType<typeof view>) =>
      console.log(`${name.padEnd(17)}${String(t.planted).padStart(8)}   ${fmt(t.surfacedPct)}     ${fmt(t.correctFixOfSurfacedPct)}   ${String(t.falseAlarms).padStart(6)}`);
    for (const k of ROWS) line(LABEL[k], e.table[k]);
    line("All but commas", e.allExceptCommas);
    line("All", e.all);
    console.log(`by language: ${Object.entries(e.byLanguage).map(([k, t]) => `${k} ${t.surfacedPct}%/${t.correctFixOfSurfacedPct}%`).join(" · ")}`);
    console.log(`missing words: ${Object.entries(e.missingWordByLanguage).map(([k, t]) => `${k} ${t.surfacedPct}%/${t.correctFixOfSurfacedPct}%`).join(" · ")}`);
    console.log(`wrong suggestions ${e.wrongSuggestions.total}, damaging ${e.wrongSuggestions.damaging} (${e.wrongSuggestions.damagingPct}%) · held back ${e.heldBack.corrections} (${e.heldBack.ofAll}%) · ${e.speed.wordsPerMinute} words/min · runs with errors ${e.runsWithErrors}`);
  }
}

void main();
