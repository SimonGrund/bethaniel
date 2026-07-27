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
