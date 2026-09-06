#!/usr/bin/env node
/**
 * Build an error-planted fixture from its clean twin.
 *
 * Ground truth for the benchmark is recovered by diffing `{lang}_correct.md`
 * against `{lang}_copy_edit.md` (see buildGroundTruth in benchScoring.ts), so a
 * fixture is only as good as that diff. Two failure modes make a hand-planted
 * fixture lie about itself:
 *
 *   1. Two errors planted within ~20 characters merge into ONE diff span. A
 *      merged span touches several words, and classifyPlantedError files
 *      anything multi-word under "other" — so a carefully planted comma and
 *      misspelling silently become one uncategorised blob.
 *   2. An edit can land as a different category than intended (a "misspelling"
 *      whose wrong form is a real word is really a wordChoice).
 *
 * Both make the per-category chart wrong in a way no one would notice. So each
 * edit is applied only if it provably adds exactly one planted error, of
 * exactly the intended category. Edits that fail are reported and skipped
 * rather than quietly corrupting the fixture.
 *
 * Usage:
 *   npx tsx scripts/plant-errors.ts <lang>          # write the fixture
 *   npx tsx scripts/plant-errors.ts <lang> --dry    # report only
 *
 * Edit lists live in scripts/error-plans/<lang>.json as
 *   [{ "find": "...", "replace": "...", "category": "comma" }, ...]
 */
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  buildGroundTruth,
  classifyPlantedError,
  type PlantedErrorCategory,
  type WordChecks,
} from "../backend/src/benchScoring.js";
import { getWordValidator } from "../backend/src/spellcheck.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(__dirname, "..", "sample_texts");
const PLAN_DIR = join(__dirname, "error-plans");

interface PlannedEdit {
  find: string;
  replace: string;
  category: PlantedErrorCategory;
  /** Free-text note; ignored by the tool, kept so the plan reads as documentation. */
  note?: string;
}

/** ISO code per fixture name, for the dictionary that splits spelling three ways. */
const LANG_CODE: Record<string, string> = {
  stress100: "en",
  stress100da: "da",
  stress100de: "de",
  stress100es: "es",
};

function checksFor(lang: string): WordChecks | null {
  const code = LANG_CODE[lang] ?? "en";
  const own = getWordValidator(
    code,
    code === "en" ? { englishDialect: "american" } : undefined,
  );
  const other = code === "en" ? getWordValidator("en", { englishDialect: "british" }) : null;
  return own ? { isKnownWord: own, isKnownInOtherDialect: other ?? undefined } : null;
}

/** Category counts for a candidate text against its clean twin. */
function distribution(
  errored: string,
  correct: string,
  checks: WordChecks | null,
): Map<PlantedErrorCategory, number> {
  const counts = new Map<PlantedErrorCategory, number>();
  for (const err of buildGroundTruth(errored, correct)) {
    const cat = classifyPlantedError(err, checks);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return counts;
}

const total = (m: Map<PlantedErrorCategory, number>) =>
  [...m.values()].reduce((a, b) => a + b, 0);

function main(): void {
  const lang = process.argv[2];
  const dryRun = process.argv.includes("--dry");
  if (!lang) {
    console.error("usage: plant-errors.ts <lang> [--dry]");
    process.exit(1);
  }

  const correct = readFileSync(join(SAMPLE_DIR, `${lang}_correct.md`), "utf-8");
  const plan: PlannedEdit[] = JSON.parse(
    readFileSync(join(PLAN_DIR, `${lang}.json`), "utf-8"),
  );
  const checks = checksFor(lang);
  if (!checks) {
    console.warn(
      `  ! no dictionary for ${lang} — spelling will not split into ` +
        `misspelling/wordChoice, and those categories cannot be verified.`,
    );
  }

  let text = correct;
  let counts = distribution(text, correct, checks);
  const kept: PlannedEdit[] = [];
  const skipped: { edit: PlannedEdit; why: string }[] = [];

  for (const edit of plan) {
    const hits = text.split(edit.find).length - 1;
    if (hits !== 1) {
      skipped.push({ edit, why: `${hits} matches in the text, need exactly 1` });
      continue;
    }
    const candidate = text.replace(edit.find, edit.replace);
    const next = distribution(candidate, correct, checks);

    if (total(next) !== total(counts) + 1) {
      // Merged into a neighbouring error, or produced no diff at all.
      skipped.push({
        edit,
        why: `planted ${total(next) - total(counts)} spans, need exactly 1 ` +
          `(too close to another error — they merged)`,
      });
      continue;
    }
    const got = (next.get(edit.category) ?? 0) - (counts.get(edit.category) ?? 0);
    if (got !== 1) {
      const landed = [...next.entries()]
        .filter(([c, n]) => n > (counts.get(c) ?? 0))
        .map(([c]) => c);
      skipped.push({
        edit,
        why: `landed as ${landed.join("/") || "nothing"}, wanted ${edit.category}`,
      });
      continue;
    }
    text = candidate;
    counts = next;
    kept.push(edit);
  }

  console.log(`\n${lang}: kept ${kept.length} of ${plan.length} planned edits`);
  if (skipped.length) {
    console.log(`\n  skipped ${skipped.length}:`);
    for (const { edit, why } of skipped) {
      console.log(`    [${edit.category}] ${why}`);
      console.log(`        ${JSON.stringify(edit.find.slice(0, 70))}`);
    }
  }

  const order: PlantedErrorCategory[] = [
    "misspelling", "wordChoice", "dialect", "spelling", "comma",
    "capitalization", "duplicateWord", "punctuation", "other",
  ];
  console.log(`\n  final ground truth — ${total(counts)} planted:`);
  for (const cat of order) {
    const n = counts.get(cat);
    if (n) console.log(`    ${cat.padEnd(16)} ${String(n).padStart(3)}`);
  }

  if (dryRun) {
    console.log("\n  (--dry: nothing written)");
    return;
  }
  const dst = join(SAMPLE_DIR, `${lang}_copy_edit.md`);
  writeFileSync(dst, text, "utf-8");
  console.log(`\n  wrote ${dst}`);
}

main();
