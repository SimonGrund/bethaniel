// ── The target-language dropdown ──
//
// targetLang is interpolated straight into the prompt ("Translate the
// following text into ${targetLang}", prompts.ts), so any language has always
// worked. A fixed list would quietly take that away, which is why OTHER is
// part of the list rather than an afterthought — the dropdown is a shortcut
// for the common case, not a restriction.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TRANSLATION_LANGUAGES,
  OTHER_LANGUAGE,
} from "../../frontend/src/translationLanguages.ts";

test("the list is offered in alphabetical order", () => {
  const sorted = [...TRANSLATION_LANGUAGES].sort((a, b) => a.localeCompare(b));
  assert.deepEqual([...TRANSLATION_LANGUAGES], sorted);
});

test("no language is listed twice", () => {
  assert.equal(
    new Set(TRANSLATION_LANGUAGES).size,
    TRANSLATION_LANGUAGES.length,
  );
});

test("the languages Bethaniel has measured are all offered", () => {
  // docs/language-quality-roadmap.md benchmarks these; a dropdown that
  // omitted one would hide the work.
  for (const lang of ["Danish", "English", "German", "Spanish"]) {
    assert.ok(
      TRANSLATION_LANGUAGES.includes(lang),
      `${lang} has measured translation quality and must be offered`,
    );
  }
});

test("the escape hatch is not itself a language", () => {
  // It is a sentinel the card swaps for a text box. Sending it to the prompt
  // would ask the model to translate the manuscript into "other".
  assert.ok(!TRANSLATION_LANGUAGES.includes(OTHER_LANGUAGE));
  assert.match(OTHER_LANGUAGE, /^__/);
});

test("every entry is a language name, not a code", () => {
  // The prompt reads it as prose, so "da" would be a worse instruction than
  // "Danish" — and the author reads it too.
  for (const lang of TRANSLATION_LANGUAGES) {
    assert.match(lang, /^[A-Z][a-z]+$/, `${lang} should be a plain name`);
  }
});
