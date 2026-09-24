// Every structural check needs a label, in every language the app ships.
//
// The panel renders `t("scan_check_" + f.check)`, and useTranslation falls
// back to the KEY when a string is missing — so a check added without its
// label shows the author the literal text "scan_check_dialect" next to a
// finding. That is exactly what shipped: the dialect check was added, its
// label was not, and nothing failed.
//
// The two halves live in different packages, which is why nothing caught it.
// This test is the join: STRUCTURAL_CHECKS is the backend's list, i18n.ts is
// the frontend's, and adding a check to one without the other fails here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { STRUCTURAL_CHECKS } from "../src/types.ts";
import TRANSLATIONS from "../../frontend/src/i18n.ts";

const LANGS = ["en", "da", "de", "es"] as const;

/** Every string the two check lists need, per check. */
const PER_CHECK_KEYS = [
  // The name beside a finding.
  "scan_check_",
  // What the check looks for, shown beside a pass in "What was checked". A
  // tick next to a name nobody recognises reassures nobody, so this one is
  // as load-bearing as the label.
  "scan_looks_for_",
] as const;

test("every structural check has a label in every language", () => {
  for (const check of STRUCTURAL_CHECKS) {
    for (const prefix of PER_CHECK_KEYS) {
      const key = `${prefix}${check}`;
      const entry = TRANSLATIONS[key];
      assert.ok(entry, `${key} is missing — the panel would show the raw key`);
      for (const lang of LANGS) {
        assert.ok(
          entry[lang]?.trim(),
          `${key} has no ${lang} translation`,
        );
      }
    }
  }
});

test("the strings the check list itself needs are present", () => {
  // Not per-check, but on the same page and equally raw-key-visible.
  for (const key of [
    "scan_checked_title",
    "scan_result_clean",
    "scan_result_found",
    "scan_result_skipped",
    "scan_skipped_note",
    "score_info_show",
    "score_info_hide",
    "score_info_density",
    "score_info_weight",
    "score_info_curve",
    "score_info_counts",
  ]) {
    const entry = TRANSLATIONS[key];
    assert.ok(entry, `${key} is missing`);
    for (const lang of LANGS) {
      assert.ok(entry[lang]?.trim(), `${key} has no ${lang} translation`);
    }
  }
});
