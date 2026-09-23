// Recall, measured by injection.
//
// Skipped unless the corpus is present — the manuscripts are the author's own
// and are not checked in. Get them with scripts/fetch-confusable-corpus.sh.
//
// Baseline before this work (2026-09-23): 196/200 and 194/200 one-off typos
// caught, and EVERY miss was a typo injected three or more times, which the
// lexicon harvested as a coinage and the gate then deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  initSpellchecker,
  getSpellCorrections,
  collectMidSentenceCapitals,
} from "../src/spellcheck.ts";
import { isWordAnywhere } from "../src/wordKnowledge.ts";
import {
  harvestLexicon,
  protectedTermsOf,
  gateProtectedTerms,
} from "../src/lexicon.ts";

const DIR = "/tmp/quote-corpus";
const have = existsSync(`${DIR}/rage.md`) && existsSync(`${DIR}/taker.md`);

/** Deterministic PRNG — the run must be repeatable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
}

/** Everything the author would actually see, for one manuscript. */
async function findingsFor(md: string): Promise<Set<string>> {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const prot = protectedTermsOf(harvestLexicon(md, { lang: "en", isWord }));
  const names = collectMidSentenceCapitals(md, "en");
  const cs = getSpellCorrections(md, "en_US", {
    protectedNames: names,
    englishDialect: "american",
  });
  return new Set(
    gateProtectedTerms(cs, prot).kept.map((c) =>
      c.original.trim().replace(/[^\p{L}'’-]/gu, "").toLowerCase(),
    ),
  );
}

test("one-off typos: recall stays at or above 97%", { skip: !have }, async () => {
  await initSpellchecker();
  const us = isWordAnywhere("en", "american")!;
  for (const f of ["rage", "taker"]) {
    const clean = readFileSync(`${DIR}/${f}.md`, "utf8");
    const rand = rng(20260923);
    const cands = [...clean.matchAll(/\b[a-z]{5,}\b/g)];
    const injected: { from: string; to: string }[] = [];
    const used = new Set<number>();
    const edits: { at: number; from: string; to: string }[] = [];
    let guard = 0;
    while (injected.length < 100 && guard++ < 40000) {
      const pick = cands[Math.floor(rand() * cands.length)];
      if (!pick || used.has(pick.index!)) continue;
      const w = pick[0];
      const i = 1 + Math.floor(rand() * (w.length - 2));
      const bad = w.slice(0, i) + w[i] + w.slice(i); // doubled letter
      if (us(bad)) continue;
      used.add(pick.index!);
      injected.push({ from: w, to: bad });
      edits.push({ at: pick.index!, from: w, to: bad });
    }
    let dirty = clean;
    for (const e of [...edits].sort((a, b) => b.at - a.at)) {
      dirty = dirty.slice(0, e.at) + e.to + dirty.slice(e.at + e.from.length);
    }
    const found = await findingsFor(dirty);
    const hit = injected.filter((i) => found.has(i.to.toLowerCase())).length;
    assert.ok(
      hit / injected.length >= 0.97,
      `${f}: ${hit}/${injected.length} one-off typos caught`,
    );
  }
});

test("a typo repeated 3, 5 and 10 times is caught every time", { skip: !have }, async () => {
  const clean = readFileSync(`${DIR}/rage.md`, "utf8");
  for (const times of [3, 5, 10]) {
    let done = 0;
    const dirty = clean.replace(/\bwith\b/g, (m) => (done++ < times ? "woth" : m));
    const found = await findingsFor(dirty);
    assert.ok(found.has("woth"), `a typo repeated ${times} times was swallowed`);
  }
});

test("the genuine coinages are still protected", { skip: !have }, async () => {
  for (const [f, words] of [
    ["rage", ["warhammer"]],
    ["taker", ["blackwood", "snuck"]],
  ] as const) {
    const found = await findingsFor(readFileSync(`${DIR}/${f}.md`, "utf8"));
    for (const w of words) {
      assert.equal(found.has(w), false, `${w} should be the author's word`);
    }
  }
});

test("no fabricated replacement survives", { skip: !have }, async () => {
  await initSpellchecker();
  const md = readFileSync(`${DIR}/taker.md`, "utf8");
  const isWord = isWordAnywhere("en", "american")!;
  const prot = protectedTermsOf(harvestLexicon(md, { lang: "en", isWord }));
  const names = collectMidSentenceCapitals(md, "en");
  const cs = gateProtectedTerms(
    getSpellCorrections(md, "en_US", {
      protectedNames: names,
      englishDialect: "american",
    }),
    prot,
  ).kept;
  // "Tobias" -> "To bias" was the worst of them. Nothing may split a word
  // into two the way that did, and no term the other English knows may be
  // rewritten at all.
  const bad = cs.filter((c) => /^To bias/.test(c.corrected ?? ""));
  assert.deepEqual(bad, [], JSON.stringify(bad));
});
