// Comma is the largest planted category in every non-English fixture and the
// weakest result — Spanish scored 5/16% on the ~100-error fixtures, the lowest
// figure anywhere in the benchmark.
//
// The obvious culprit was the English-only gate on the two comma directives,
// but the benchmark disproves that on its own: German scores BEST of the four
// (55/72%) with no comma directive at all, carried by LanguageTool's German
// rule set, while Spanish — which LanguageTool barely covers — scores 5/16%.
// What predicts comma recall is whether a deterministic layer already handles
// that language, so the fix is per-language rules where the gap is, not a
// translation of the English ones.
//
// Translating them would be actively wrong: English wants a serial comma and
// Spanish forbids it.

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

test("German and Danish get no comma directives", () => {
  // German needs none — LanguageTool's German rules already score it best of
  // the four. Danish is deliberately absent: it has two competing comma
  // systems (grammatisk and nyt komma) and which applies is the author's
  // choice, so enforcing one is worse than enforcing neither until a style
  // guide can say which.
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
