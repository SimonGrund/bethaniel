// ── A translation is not a list of corrections ──
//
// Tested from here because the frontend has no runner, the same reach-across
// codeBalanceNote.test.ts uses.
//
// The reason this exists: a translation that could not replace some paragraphs
// used to warn about "472 change(s)" and show a table of "replace X with Y",
// each row a whole English paragraph beside a whole French one, with a CSV to
// apply them by hand. A translation produces no corrections at all, so the
// author went looking for a review screen with nothing in it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { exportWarningFor } from "../../frontend/src/exportWarningCopy.ts";

test("nothing refused and nothing flattened means no warning at all", () => {
  assert.equal(exportWarningFor({ skipped: 0, flattened: 0, isTranslation: false }), null);
  assert.equal(exportWarningFor({ skipped: 0, flattened: 0, isTranslation: true }), null);
});

test("an edit keeps its corrections table", () => {
  const v = exportWarningFor({ skipped: 5, flattened: 0, isTranslation: false });
  assert.deepEqual(v?.parts, [{ key: "surgical_partial", count: 5 }]);
  assert.equal(v?.showUnapplied, true);
});

test("a translation never shows the corrections table", () => {
  for (const [skipped, flattened] of [
    [472, 0],
    [0, 106],
    [472, 106],
  ]) {
    const v = exportWarningFor({ skipped, flattened, isTranslation: true });
    assert.equal(
      v?.showUnapplied,
      false,
      `showed a replace-X-with-Y table for a translation (${skipped}/${flattened})`,
    );
  }
});

test("a translation speaks in paragraphs, not changes", () => {
  const v = exportWarningFor({ skipped: 472, flattened: 0, isTranslation: true });
  assert.deepEqual(v?.parts, [
    { key: "surgical_partial_translation", count: 472 },
  ]);
  // The edit key would call them "change(s)" and invite a hunt for corrections.
  assert.ok(!v?.parts.some((p) => p.key === "surgical_partial"));
});

test("a translation that both refused and flattened says both", () => {
  // Losing paragraphs and losing emphasis are different harms. Reporting only
  // the louder one leaves the author to find the other by reading the book.
  const v = exportWarningFor({ skipped: 9, flattened: 106, isTranslation: true });
  assert.deepEqual(v?.parts, [
    { key: "surgical_partial_translation", count: 9 },
    { key: "surgical_flattened", count: 106 },
  ]);
});

test("an edit that only flattened says so without a table", () => {
  const v = exportWarningFor({ skipped: 0, flattened: 3, isTranslation: false });
  assert.deepEqual(v?.parts, [{ key: "surgical_flattened", count: 3 }]);
  assert.equal(v?.showUnapplied, false);
});

test("every key it can return exists in all four languages", async () => {
  const { default: TRANSLATIONS } = await import("../../frontend/src/i18n.ts");
  const keys = new Set<string>();
  for (const isTranslation of [true, false])
    for (const skipped of [0, 7])
      for (const flattened of [0, 7]) {
        const v = exportWarningFor({ skipped, flattened, isTranslation });
        for (const p of v?.parts ?? []) keys.add(p.key);
      }
  for (const k of keys) {
    const entry = (TRANSLATIONS as Record<string, Record<string, string>>)[k];
    assert.ok(entry, `missing i18n key: ${k}`);
    for (const lang of ["en", "da", "de", "es"])
      assert.ok(entry[lang], `key ${k} missing ${lang}`);
    assert.ok(entry.en.includes("{count}"), `key ${k} has no {count} placeholder`);
  }
});
