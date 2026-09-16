// Every line a task card can show about a promo code needs a string, in every
// language the app ships. useTranslation falls back to the KEY when one is
// missing, so the failure mode is an author reading "cloud_code_runs_card_one"
// next to their manuscript — the same way scan_check_dialect shipped.
//
// Same join as publicationScanLabels.test.ts: the keys are declared in the
// frontend module that uses them, the strings live in i18n.ts, and adding one
// without the other fails here.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BALANCE_NOTE_KEYS,
  BALANCE_CAP_KEY,
} from "../../frontend/src/codeBalanceNote.ts";
import TRANSLATIONS from "../../frontend/src/i18n.ts";

const LANGS = ["en", "da", "de", "es"] as const;

test("every promo-code note has a string in every language", () => {
  for (const key of [...BALANCE_NOTE_KEYS, BALANCE_CAP_KEY]) {
    const entry = TRANSLATIONS[key];
    assert.ok(entry, `${key} is missing — the card would show the raw key`);
    for (const lang of LANGS) {
      assert.ok(entry[lang]?.trim(), `${key} has no ${lang} translation`);
    }
  }
});

test("the plural notes interpolate a count, the singular ones do not", () => {
  // "1 free runs left" is the bug this pins.
  for (const lang of LANGS) {
    assert.match(TRANSLATIONS.cloud_code_runs_shared[lang], /\{n\}/);
    assert.match(TRANSLATIONS.cloud_code_runs_card[lang], /\{n\}/);
    assert.doesNotMatch(TRANSLATIONS.cloud_code_runs_shared_one[lang], /\{n\}/);
    assert.doesNotMatch(TRANSLATIONS.cloud_code_runs_card_one[lang], /\{n\}/);
  }
});

test("the word-cap clause interpolates the cap", () => {
  for (const lang of LANGS) {
    assert.match(TRANSLATIONS[BALANCE_CAP_KEY][lang], /\{words\}/);
  }
});
