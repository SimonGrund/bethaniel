// A finding neither the dictionaries nor the model could fix gets its own
// card: accept and dismiss are both wrong for it, so the author is offered
// "add to dictionary" or a field to type the correction into.
//
// This is the join between the two packages, like publicationScanLabels.test.ts:
// useTranslation falls back to the KEY when a string is missing, so a card
// shipped without its strings shows the author the literal text
// "unfixable_add_to_dictionary".

import { test } from "node:test";
import assert from "node:assert/strict";

import TRANSLATIONS from "../../frontend/src/i18n.ts";

const LANGS = ["en", "da", "de", "es"] as const;

const KEYS = [
  "unfixable_label",
  // The scan says only what the word is; the two actions belong to the
  // copy-edit reviewer, so its wording must not invite a decision.
  "unfixable_label_scan",
  "unfixable_why_scan",
  "unfixable_why",
  "unfixable_add_to_dictionary",
  "unfixable_add_hint",
  "unfixable_correct_to",
  "unfixable_apply",
  "unfixable_added_toast",
  "unfixable_corrected_toast",
] as const;

test("every string the unfixable card renders exists in every language", () => {
  for (const key of KEYS) {
    const entry = TRANSLATIONS[key];
    assert.ok(entry, `${key} is missing — the card would show the raw key`);
    for (const lang of LANGS) {
      assert.ok(entry[lang]?.trim(), `${key} has no ${lang} translation`);
    }
  }
});

test("the scan wording does not invite an action it does not offer", () => {
  for (const lang of LANGS) {
    const scan = TRANSLATIONS.unfixable_why_scan[lang]!;
    const interactive = TRANSLATIONS.unfixable_why[lang]!;
    assert.notEqual(scan, interactive, `${lang} reuses the interactive copy`);
  }
});

test("the toasts carry the placeholders the card substitutes", () => {
  for (const lang of LANGS) {
    assert.match(
      TRANSLATIONS.unfixable_added_toast[lang]!,
      /\{term\}/,
      `added toast (${lang}) must name the word`,
    );
    assert.match(
      TRANSLATIONS.unfixable_added_toast[lang]!,
      /\{n\}/,
      `added toast (${lang}) must say how many findings were withdrawn`,
    );
    assert.match(
      TRANSLATIONS.unfixable_corrected_toast[lang]!,
      /\{term\}/,
      `corrected toast (${lang}) must name the word`,
    );
    assert.match(
      TRANSLATIONS.unfixable_corrected_toast[lang]!,
      /\{fix\}/,
      `corrected toast (${lang}) must name the replacement`,
    );
  }
});
