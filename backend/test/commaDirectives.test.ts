// Per-language comma directives.
//
// Comma is the largest planted category in every language (37-47 each) and the
// weakest result: 116 of the 186 errors the benchmark misses are commas —
// 63% of everything missed, five times the next category.
//
// The obvious culprit was the English-only gate on the two comma directives,
// and the benchmark disproves it. German scores best of the four with NO
// directive at all, carried by LanguageTool's German rules; LanguageTool covers
// 0 of 50 planted Danish commas and 0 of 41 Spanish ones. What predicts comma
// recall is whether a deterministic layer already handles the language, so
// these fill the gap where there is one rather than ungating the English rules.
//
// Translating the English rules would be actively wrong: English requires a
// serial comma and Spanish forbids it; Danish has two systems that contradict
// each other on the commonest case of all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCopyEditCorrectionsPrompt } from "../src/prompts.ts";
import { DEFAULT_COPY_EDIT_OPTIONS } from "../src/types.ts";

const spanish = () =>
  buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS, undefined, undefined, "es");

test("a Spanish manuscript gets Spanish comma directives", () => {
  const p = spanish();
  assert.ok(p.includes("inciso"), "parenthetical rule");
  assert.ok(p.includes("enumeración"), "enumeration rule");
  assert.ok(p.includes("adversativa"), "pero/sino rule");
});

test("the Spanish rules forbid the serial comma English requires", () => {
  // The reason the English directives cannot simply be translated: they are
  // opposite on this point, and importing them would plant errors.
  const p = spanish();
  assert.ok(
    p.includes('NO se pone coma antes de la "y"'),
    "must state the Spanish convention explicitly",
  );
});

test("the Spanish rules forbid a comma between subject and verb", () => {
  // The commonest Spanish comma error, and the one a rule that only says
  // "add commas" would introduce. Every other directive in this prompt pairs
  // its instruction with the misfire it must not make.
  const p = spanish();
  assert.ok(p.includes("NUNCA pongas una coma entre el sujeto y su verbo"));
});

test("the Spanish directives are written in Spanish", () => {
  // The manuscript-language block already tells the model every correction
  // must be Spanish. A rule about Spanish commas written in English asks it to
  // switch languages mid-prompt for no reason.
  const p = spanish();
  const start = p.indexOf("- Falta una coma que aísle");
  assert.ok(start > -1, "Spanish block present");
  const block = p.slice(start, p.indexOf("\n\n", start));
  assert.ok(!/\bMissing comma\b/.test(block), "no English comma rules leaked in");
});

test("English still gets the English directives, not the Spanish ones", () => {
  const p = buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS);
  assert.ok(p.includes("Missing comma between two or more COORDINATE adjectives"));
  assert.ok(!p.includes("inciso"), "Spanish rules must not reach an English manuscript");
});

test("no language gets another language's comma rules", () => {
  // German gets none of its own — LanguageTool's German rules already score it
  // best of the four, so there is no gap to fill.
  for (const lang of ["de", "da"]) {
    const p = buildCopyEditCorrectionsPrompt(
      DEFAULT_COPY_EDIT_OPTIONS, undefined, undefined, lang,
    );
    assert.ok(!p.includes("inciso"), `${lang} must not get Spanish rules`);
    assert.ok(
      !p.includes("Missing comma between two or more COORDINATE adjectives"),
      `${lang} must not get English rules`,
    );
  }
});

test("regional tags resolve to the base language", () => {
  const p = buildCopyEditCorrectionsPrompt(
    DEFAULT_COPY_EDIT_OPTIONS, undefined, undefined, "es-ES",
  );
  assert.ok(p.includes("inciso"));
});

test("turning punctuation off removes the Spanish rules too", () => {
  const p = buildCopyEditCorrectionsPrompt(
    { ...DEFAULT_COPY_EDIT_OPTIONS, punctuation: false },
    undefined, undefined, "es",
  );
  assert.ok(!p.includes("inciso"));
});

// ── Danish: two comma systems, and the author picks ─────────────────────────
//
// Danish is the one bundled language with two competing, both-correct comma
// conventions. Grammatisk komma puts a comma before every subordinate clause;
// nyt komma mostly does not. Retskrivningsordbogen sanctions both, so
// enforcing either without asking would be wrong for half of all manuscripts —
// which is why Danish comma recall (23/9%) was left alone until the option
// existed, rather than "fixed" by picking one.
//
// LanguageTool covers no Danish comma rule at all — 0 of 50 planted spans on
// the stress fixture — so unlike German there is nothing underneath these
// directives to fall back on.

const danish = (system: "grammatisk" | "nyt") =>
  buildCopyEditCorrectionsPrompt(
    { ...DEFAULT_COPY_EDIT_OPTIONS, danishComma: system },
    undefined, undefined, "da",
  );

test("grammatisk komma asks for the comma before a subordinate clause", () => {
  const p = danish("grammatisk");
  assert.ok(p.includes("Manglende komma foran en ledsætning"));
  assert.ok(p.includes("Han sagde, at han ville komme"));
});

test("nyt komma forbids the very comma grammatisk requires", () => {
  // The two systems are opposites on this exact point. A prompt that shipped
  // one of them unconditionally would be wrong for every author using the
  // other, which is the whole reason for the option.
  const p = danish("nyt");
  assert.ok(p.includes("Sæt IKKE komma foran ledsætninger"));
  assert.ok(p.includes('"Han sagde at han ville komme" er korrekt'));
  assert.ok(!p.includes("Manglende komma foran en ledsætning"));
});

test("both systems still ask for the comma between two main clauses", () => {
  // Not everything differs: the helsætning comma is required either way, and
  // dropping it from the nyt-komma branch would lose a rule that still holds.
  for (const system of ["grammatisk", "nyt"] as const) {
    assert.ok(
      danish(system).includes("Hun vendte sig, og hun gik"),
      `${system} must keep the main-clause comma`,
    );
  }
});

test("grammatisk komma forbids a comma between subject and verb", () => {
  assert.ok(danish("grammatisk").includes("ALDRIG komma mellem grundled og udsagnsled"));
});

test("the Danish directives are written in Danish", () => {
  const p = danish("grammatisk");
  const start = p.indexOf("- Manglende komma foran en ledsætning");
  const block = p.slice(start, p.indexOf("\n\n", start));
  assert.ok(!/\bMissing comma\b/.test(block), "no English comma rules leaked in");
  assert.ok(!/\binciso\b/.test(block), "no Spanish rules leaked in");
});

test("the Danish comma option does not reach other languages", () => {
  for (const lang of ["en", "de", "es"]) {
    const p = buildCopyEditCorrectionsPrompt(
      { ...DEFAULT_COPY_EDIT_OPTIONS, danishComma: "nyt" },
      undefined, undefined, lang,
    );
    assert.ok(!p.includes("ledsætning"), `${lang} must not get Danish rules`);
  }
});
