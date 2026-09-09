#!/usr/bin/env node
/**
 * Generate a spelling-error plan for a clean fixture.
 *
 * Hand-writing an error plan is fine for a hundred edits across six
 * categories. It is not fine for the several hundred misspellings needed to
 * pin down spelling recall, which is the one number an author most wants to
 * trust — so this picks the sites and the corruptions, and plant-errors.ts
 * still validates every one of them before anything is written.
 *
 * What makes a generated typo trustworthy:
 *
 *   1. **The result must not be a real word.** "form" -> "from" is a
 *      wordChoice, not a misspelling, and filing it under spelling would
 *      quietly move points between the two categories we most want to
 *      separate. Every candidate is checked against the spellchecker and
 *      discarded if it lands on a real word.
 *   2. **The original must be a real word**, or we are corrupting something
 *      already wrong, and the ground-truth diff would describe a fix nobody
 *      asked for.
 *   3. **Sites stay far apart.** Ground truth is recovered by diffing against
 *      the clean twin, and two edits within ~20 characters merge into one
 *      span classified as "other" (see plant-errors.ts). This enforces a
 *      wider margin than that.
 *   4. **`find` must be unique in the text**, so the edit lands where it was
 *      meant to. The word alone rarely is, so each entry carries surrounding
 *      context and is verified to match exactly once.
 *
 * The corruptions themselves imitate how people actually mistype: doubled
 * letters, dropped letters, transposed neighbours, and a few keyboard slips.
 * Deliberately NOT homophone substitutions — those are wordChoice.
 *
 * Usage:
 *   npx tsx scripts/plan-typos.ts <lang> [--count 300] [--seed 7]
 *
 * Writes scripts/error-plans/<lang>.json, then run:
 *   npx tsx scripts/plant-errors.ts <lang>
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { getWordValidator, initSpellchecker } from "../backend/src/spellcheck.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(__dirname, "..", "sample_texts");
const PLAN_DIR = join(__dirname, "error-plans");

const lang = process.argv[2];
if (!lang) {
  console.error("usage: plan-typos.ts <lang> [--count N] [--seed N]");
  process.exit(1);
}
const arg = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const COUNT = arg("--count", 300);
const SEED = arg("--seed", 7);

/** Deterministic PRNG, so a regenerated plan is the same plan. */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const rnd = makeRng(SEED);

/** Corruptions that a typist produces, none of which are homophones. */
const CORRUPTIONS: ((w: string, r: () => number) => string | null)[] = [
  // double a letter
  (w, r) => {
    const i = 1 + Math.floor(r() * (w.length - 2));
    return w.slice(0, i) + w[i] + w.slice(i);
  },
  // drop a letter
  (w, r) => {
    const i = 1 + Math.floor(r() * (w.length - 2));
    return w.slice(0, i) + w.slice(i + 1);
  },
  // transpose neighbours
  (w, r) => {
    const i = 1 + Math.floor(r() * (w.length - 3));
    if (w[i] === w[i + 1]) return null;
    return w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
  },
  // undouble a doubled letter ("running" -> "runing")
  (w) => {
    for (let i = 1; i < w.length - 1; i++) {
      if (w[i] === w[i + 1]) return w.slice(0, i) + w.slice(i + 1);
    }
    return null;
  },
  // ie/ei swap, the classic
  (w) => {
    if (w.includes("ie")) return w.replace("ie", "ei");
    if (w.includes("ei")) return w.replace("ei", "ie");
    return null;
  },
];

async function main() {
  const cleanPath = join(SAMPLE_DIR, `${lang}_correct.md`);
  if (!existsSync(cleanPath)) {
    console.error(`No clean twin at ${cleanPath}`);
    process.exit(1);
  }
  const text = readFileSync(cleanPath, "utf8");

  await initSpellchecker();
  const isWord = getWordValidator("en");

  // Candidate words: long enough to corrupt without becoming another word,
  // lowercase so proper nouns are left alone (a corrupted name is a name
  // question, not a spelling one), and a real word to begin with.
  const seen = new Map<string, number>();
  for (const m of text.matchAll(/[a-z]{6,}/g)) {
    seen.set(m[0], (seen.get(m[0]) ?? 0) + 1);
  }

  const used: number[] = [];
  const MIN_GAP = 40;
  const plan: { find: string; replace: string; category: string }[] = [];
  const takenWords = new Set<string>();

  const matches = [...text.matchAll(/[a-z]{6,}/g)];
  // Walk in a shuffled order so the errors are spread through the text rather
  // than clustered at the front.
  const order = matches.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  for (const idx of order) {
    if (plan.length >= COUNT) break;
    const m = matches[idx];
    const word = m[0];
    const at = m.index ?? 0;

    // One corruption per distinct word, so the model cannot learn the fixture.
    if (takenWords.has(word)) continue;
    if (!isWord(word)) continue;
    if (used.some((u) => Math.abs(u - at) < MIN_GAP)) continue;

    // Try corruptions until one produces a genuine non-word.
    let bad: string | null = null;
    const shuffled = [...CORRUPTIONS].sort(() => rnd() - 0.5);
    for (const f of shuffled) {
      const cand = f(word, rnd);
      if (!cand || cand === word || cand.length < 4) continue;
      if (isWord(cand)) continue; // a real word — that is wordChoice, not spelling
      bad = cand;
      break;
    }
    if (!bad) continue;

    // Enough context that `find` is unique in the file.
    let ctx = 12;
    let find = "";
    while (ctx <= 60) {
      const start = Math.max(0, at - ctx);
      const end = Math.min(text.length, at + word.length + ctx);
      find = text.slice(start, end);
      if (!find.includes("\n") && text.split(find).length === 2) break;
      ctx += 12;
      find = "";
    }
    if (!find) continue;

    plan.push({ find, replace: find.replace(word, bad), category: "misspelling" });
    used.push(at);
    takenWords.add(word);
  }

  const out = join(PLAN_DIR, `${lang}.json`);
  writeFileSync(out, JSON.stringify(plan, null, 2) + "\n");
  console.log(
    `${plan.length} misspellings planned for ${lang} ` +
      `(asked for ${COUNT}, ${matches.length} candidate words in the text)`,
  );
  console.log(`wrote ${out}`);
  console.log(`now run: npx tsx scripts/plant-errors.ts ${lang} --dry`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
