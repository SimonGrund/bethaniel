// Tests for the LanguageTool client's pure match parser. The parser turns a
// LanguageTool /v2/check response into context-anchored Corrections, without
// needing a live server. Fiction-noisy categories are filtered out.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseLanguageToolMatches,
  mapLangToLanguageTool,
  type LanguageToolMatch,
} from "../src/languageTool.ts";
import { applyCorrections } from "../src/llm.ts";

const grammarMatch = (
  offset: number,
  length: number,
  replacement: string,
  categoryId = "GRAMMAR",
): LanguageToolMatch => ({
  message: "test",
  offset,
  length,
  replacements: [{ value: replacement }],
  rule: { id: "TEST_RULE", category: { id: categoryId, name: categoryId } },
});

test("maps a grammar match to a context-anchored correction and fixes the text", () => {
  const text = "Its a nice day.";
  const cs = parseLanguageToolMatches(text, [grammarMatch(0, 3, "It's")]);
  assert.equal(cs.length, 1);
  assert.ok(cs[0].original.length > 3, "original must carry context, not bare 'Its'");
  const [out] = applyCorrections(text, cs);
  assert.equal(out, "It's a nice day.");
});

test("skips matches with no replacements", () => {
  const text = "This is fine.";
  const cs = parseLanguageToolMatches(text, [
    { message: "no fix", offset: 0, length: 4, replacements: [], rule: { id: "X", category: { id: "GRAMMAR", name: "G" } } },
  ]);
  assert.deepEqual(cs, []);
});

test("skips noisy fiction categories (TYPOGRAPHY handled elsewhere)", () => {
  const text = "He said - hello.";
  const cs = parseLanguageToolMatches(text, [grammarMatch(8, 1, "—", "TYPOGRAPHY")]);
  assert.deepEqual(cs, []);
});

test("tags corrections with a grammar reason", () => {
  const cs = parseLanguageToolMatches("Its a nice day.", [grammarMatch(0, 3, "It's")]);
  assert.ok((cs[0].reason ?? "").startsWith("grammar"));
});

// Benchmarking found LanguageTool's own suggestions hit the same hallucination
// patterns as the LLM's (a "typos" rule renaming an unfamiliar proper noun to
// its nearest dictionary word; a "repetitions_style" rule inserting a
// connective) — and since LanguageTool corrections skip reviewer scoring
// entirely ("not scored by reviewer — verify manually"), the deterministic
// filter is the only backstop for them. Confirms it's wired in here too.
test("drops a LanguageTool 'typos' match that renames a proper noun's letters", () => {
  const text = "Thaddeus Okafor arrived.";
  const cs = parseLanguageToolMatches(
    text,
    [grammarMatch(text.indexOf("Okafor"), "Okafor".length, "Orator", "TYPOS")],
    { lang: "en" },
  );
  assert.deepEqual(cs, []);
});

test("drops a LanguageTool 'repetitions_style' match that inserts a connective word", () => {
  const text = "Forever. He would come Tuesday.";
  const cs = parseLanguageToolMatches(
    text,
    [grammarMatch(text.indexOf("He"), "He".length, "Furthermore, he", "REPETITIONS_STYLE")],
    { lang: "en" },
  );
  assert.deepEqual(cs, []);
});

test("keeps a genuine LanguageTool grammar fix", () => {
  const text = "Its a nice day.";
  const cs = parseLanguageToolMatches(text, [grammarMatch(0, 3, "It's")], { lang: "en" });
  assert.equal(cs.length, 1);
});

test("mapLangToLanguageTool maps manuscript codes to LT language codes", () => {
  assert.equal(mapLangToLanguageTool("en", "american"), "en-US");
  assert.equal(mapLangToLanguageTool("en", "british"), "en-GB");
  assert.equal(mapLangToLanguageTool("da"), "da-DK");
  assert.equal(mapLangToLanguageTool("de"), "de-DE");
  assert.equal(mapLangToLanguageTool("es"), "es");
});

test("mapLangToLanguageTool returns null for unsupported free-text languages", () => {
  assert.equal(mapLangToLanguageTool("Klingon"), null);
});

// ── disabledRules / introductory-comma gating ──

import { buildCheckParams, INTRODUCTORY_COMMA_RULES } from "../src/languageTool.ts";

test("INTRODUCTORY_COMMA_RULES lists the LanguageTool intro-comma rule ids", () => {
  assert.ok(INTRODUCTORY_COMMA_RULES.includes("MISSING_COMMA_AFTER_INTRODUCTORY_PHRASE"));
  assert.ok(INTRODUCTORY_COMMA_RULES.includes("SENT_START_CONJUNCTIVE_LINKING_ADVERB_COMMA"));
});

test("buildCheckParams sets text, language, and enabledOnly=false", () => {
  const p = buildCheckParams("Hello there.", "en-US");
  assert.equal(p.get("text"), "Hello there.");
  assert.equal(p.get("language"), "en-US");
  assert.equal(p.get("enabledOnly"), "false");
  assert.equal(p.get("disabledRules"), null);
});

// Picky is LanguageTool's second rule tier and is almost all comma and
// confusion rules — the categories the benchmark showed as weakest. Measured
// across all five bundled fixtures it raised comma recall 19% -> 30% on
// stress100, changed nothing on the other four, and added no false positives
// on any clean text. Dropping this parameter silently gives back that recall,
// so it is asserted rather than left to a comment.
test("buildCheckParams asks for the picky rule level", () => {
  assert.equal(buildCheckParams("x", "en-US").get("level"), "picky");
  assert.equal(
    buildCheckParams("x", "da-DK", { disabledRules: ["FOO"] }).get("level"),
    "picky",
    "picky must not be dropped when other options are passed",
  );
});

test("buildCheckParams passes disabledRules as a comma-joined list", () => {
  const p = buildCheckParams("x", "en-US", { disabledRules: INTRODUCTORY_COMMA_RULES });
  assert.equal(
    p.get("disabledRules"),
    "MISSING_COMMA_AFTER_INTRODUCTORY_PHRASE,SENT_START_CONJUNCTIVE_LINKING_ADVERB_COMMA",
  );
});

test("buildCheckParams omits disabledRules when the list is empty", () => {
  assert.equal(buildCheckParams("x", "en-US", { disabledRules: [] }).get("disabledRules"), null);
});
