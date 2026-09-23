// Every confusable pattern is scored twice: it must catch its planted
// sentence, and it must fire as close to zero as possible on real prose.
//
// Skipped unless the corpora are present — they are not checked in. Get them
// with scripts/fetch-confusable-corpus.sh.
//
// The Danish corpus is 19th/early-20th century, so a zero-hit result there is
// weaker evidence than on the contemporary English manuscripts. Three
// candidate patterns were nonetheless killed by it during design; see the
// header of confusablePatterns.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import {
  CONFUSABLE_PATTERNS,
  findConfusablePatterns,
} from "../src/confusablePatterns.ts";

const DIR = "/tmp/quote-corpus";

function loadEnglish(): string[] {
  return ["rage.md", "taker.md"]
    .filter((f) => existsSync(`${DIR}/${f}`))
    .map((f) => readFileSync(`${DIR}/${f}`, "utf8"));
}

function loadDanish(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => /^da_\d+\.txt$/.test(f))
    .map((f) => readFileSync(`${DIR}/${f}`, "utf8"))
    // The Gutenberg search returns the odd English-language title; a Danish
    // text is identifiable by its æ/ø/å.
    .filter((raw) => (raw.match(/[æøåÆØÅ]/g) ?? []).length > 500);
}

const en = loadEnglish();
const da = loadDanish();

/** Total hits for one pattern id across a set of texts. */
function hitsFor(id: string, texts: string[]): number {
  let n = 0;
  for (const t of texts) {
    n += findConfusablePatterns(t, id.startsWith("da-") ? "da" : "en").filter(
      (c) => c.reason === `confusable:${id}`,
    ).length;
  }
  return n;
}

test("every pattern catches its own planted sentence", () => {
  for (const p of CONFUSABLE_PATTERNS) {
    const found = findConfusablePatterns(p.planted, p.lang);
    assert.ok(
      found.some((c) => c.reason === `confusable:${p.id}`),
      `${p.id} did not catch its planted sentence: ${p.planted}`,
    );
  }
});

test("every pattern proposes a correction that differs from the original", () => {
  for (const p of CONFUSABLE_PATTERNS) {
    for (const c of findConfusablePatterns(p.planted, p.lang)) {
      assert.notEqual(c.original, c.corrected, `${p.id} proposed a no-op`);
    }
  }
});

// The measured ceiling. English is contemporary prose, so this is the strong
// evidence: across 203,000 words the whole English table fired ONCE during
// design, on "couldn't form the words", which the modal exclusion now covers.
test("the English table is silent on 203,000 words of clean prose", { skip: en.length < 2 }, () => {
  const perPattern = new Map<string, number>();
  for (const p of CONFUSABLE_PATTERNS.filter((x) => x.lang === "en")) {
    perPattern.set(p.id, hitsFor(p.id, en));
  }
  const total = [...perPattern.values()].reduce((a, b) => a + b, 0);
  const detail = [...perPattern]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${id}:${n}`)
    .join(" ");
  assert.equal(total, 0, `English patterns fired on clean prose — ${detail}`);
});

// Danish. Weaker evidence than the English row above — the only
// public-domain Danish is 19th/early-20th century — but it is what killed
// three candidate patterns during design, so it is worth running.
//
// One pattern is expected to fire: da-i-saer hits 4 times, all archaic
// ("i sær indre Bevægelse", and a line of 17th-century spelling from Leonora
// Christina). In modern Danish "i sær" is an error, so it is kept and the
// hits are allowed for by name rather than by raising a global threshold.
const DA_ALLOWED: Record<string, number> = { "da-i-saer": 4 };

test("the Danish table is silent on 333,455 words, bar the archaic i sær", { skip: da.length < 6 }, () => {
  const offenders: string[] = [];
  for (const p of CONFUSABLE_PATTERNS.filter((x) => x.lang === "da")) {
    const n = hitsFor(p.id, da);
    const allowed = DA_ALLOWED[p.id] ?? 0;
    if (n > allowed) offenders.push(`${p.id}: ${n} hits (allowed ${allowed})`);
  }
  assert.deepEqual(offenders, [], offenders.join("; "));
});
