// ── Scan findings, said in the reader's language ──
//
// The scan's findings used to be English sentences built in the backend, so
// a Danish author read "Chapter is suspiciously short (12 words)." under a
// Danish heading. Each finding now also carries its template's key and
// values, and the interface renders them from i18n.ts.
//
// Two packages, one sentence: SCAN_MESSAGES (backend) fills the English that
// the PDF and old results use, and i18n.ts holds the same template for every
// language. These tests are the join — the English must render identically
// both ways, and no translation may lose or invent a slot.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPublicationScan,
  SCAN_LABELS_EN,
  SCAN_MESSAGES,
  type ScanUnit,
} from "../src/publicationScan.ts";
import TRANSLATIONS, { useTranslation } from "../../frontend/src/i18n.ts";
import { localiseFinding } from "../../frontend/src/scanFinding.ts";

const LANGS = ["en", "da", "de", "es"] as const;
const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("every scan message has a translation with the same slots", () => {
  for (const [key, english] of Object.entries(SCAN_MESSAGES)) {
    const entry = TRANSLATIONS[key];
    assert.ok(entry, `${key} is missing from i18n.ts`);
    assert.equal(entry.en, english, `${key}: the English differs between backend and i18n.ts`);
    for (const lang of LANGS) {
      assert.ok(entry[lang]?.trim(), `${key} has no ${lang} translation`);
      assert.deepEqual(slots(entry[lang]), slots(english), `${key} (${lang}) changes the slots`);
    }
  }
  for (const [key, english] of Object.entries(SCAN_LABELS_EN)) {
    assert.equal(TRANSLATIONS[key]?.en, english, key);
    for (const lang of LANGS) assert.ok(TRANSLATIONS[key]?.[lang]?.trim(), `${key} (${lang})`);
  }
});

// ── A book with something wrong in nearly every way the scan can see ──

const CLEAN = [
  `“She didn’t answer,” he said. “It wasn’t Tobias’s place to ask.”`,
  `The harbour was quiet… and the tide was going out. She waited…`,
  `“We should go,” Bria said. “Before the captain’s watch ends.”`,
  `The chapter ended the way the others had, with nothing settled at all.`,
].join("\n\n");

function brokenBook(): ScanUnit[] {
  return [
    { name: "Chapter 1", original: CLEAN },
    { name: "Chapter 2", original: CLEAN.replace("settled at all.", "settled.\n\nTODO: add the storm.") },
    // The same number twice, then a gap, then out of order.
    { name: "Chapter 2", original: `${CLEAN}\n\n“And us? We just escape?” Bria asked.” Bria asked.` },
    { name: "Chapter 5", original: `${CLEAN}\n\n“She said it wasn't so,” and left.` },
    { name: "Chapter 4", original: `${CLEAN}\n\nThen she said it... quietly. And she walked out into the rain without` },
    { name: "Chapter 6", original: "Nothing here." },
    { name: "Chapter 7", original: "A handful of words, far too few for a chapter of a novel." },
    { name: "Chapter 8", original: `${CLEAN}\n\n“This line of dialogue never closes, he thought.` },
    { name: "Chapter 9", original: CLEAN },
    { name: "Chapter 10", original: CLEAN.replace("settled at all.", "settled at all.,” she said.") },
  ];
}

const MOSTLY_AMERICAN = `
  The color of the harbor had not changed. She saw the gray light. He
  walked to the theater in the center of town. His neighbor apologized.
  The defense was ready. Her favorite color was gray. The armor was gray.
  But the colour of the harbour was grey, and her neighbour knew it.
`.repeat(3);

function allFindings() {
  return [
    ...buildPublicationScan(brokenBook(), { manuscriptLang: "en" }).findings,
    ...buildPublicationScan([{ name: "Chapter One", original: MOSTLY_AMERICAN }], {
      englishDialect: "british",
    }).findings,
    ...buildPublicationScan([{ name: "Chapter One", original: MOSTLY_AMERICAN }]).findings,
  ];
}

test("every finding carries its key, and its English renders the same both ways", () => {
  const en = useTranslation("en");
  const findings = allFindings();
  const covered = new Set<string>();
  for (const f of findings) {
    assert.ok(f.messageKey, `no key on: ${f.message}`);
    covered.add(f.messageKey!);
    const said = localiseFinding(f, en);
    assert.equal(said.message, f.message);
    assert.equal(said.detail, f.detail);
  }
  // The fixtures above are there to reach these; if one stops firing, the
  // check it exercises is no longer covered here.
  for (const key of [
    "scan_msg_duplicate_chapter",
    "scan_msg_empty",
    "scan_msg_short",
    "scan_msg_number_reused",
    "scan_msg_number_gap",
    "scan_msg_number_order",
    "scan_msg_repetition",
    "scan_msg_truncation",
    "scan_msg_placeholder",
    "scan_msg_punctuation_pair",
    "scan_msg_dialect_declared",
    "scan_msg_dialect_majority",
  ])
    assert.ok(covered.has(key), `no fixture produced ${key}`);
});

test("in Danish, no finding is left in English or with a slot unfilled", () => {
  const en = useTranslation("en");
  const da = useTranslation("da");
  for (const f of allFindings()) {
    const said = localiseFinding(f, da);
    assert.notEqual(said.message, localiseFinding(f, en).message, f.messageKey);
    assert.doesNotMatch(said.message, /\{\w+\}/, f.messageKey);
    if (f.detail) assert.doesNotMatch(said.detail ?? "", /\{\w+\}/, f.detailKey);
  }
});

test("the dialect's name is translated inside the sentence", () => {
  const [finding] = buildPublicationScan([{ name: "Chapter One", original: MOSTLY_AMERICAN }], {
    englishDialect: "british",
  }).findings.filter((f) => f.check === "dialect");
  const said = localiseFinding(finding, useTranslation("da"));
  assert.match(said.message, /amerikansk stavning/);
  assert.match(said.message, /sat til britisk/);
  assert.equal(said.location, "Manuskript");
});

test("a finding saved before keys existed is shown as it was", () => {
  const old = { location: "Chapter 3", message: "Chapter is suspiciously short (12 words)." };
  assert.deepEqual(localiseFinding(old, useTranslation("da")), { ...old, detail: undefined });
});

test("a single invisible character is listed where it is, not counted", () => {
  const units: ScanUnit[] = [
    { name: "Chapter 1", original: `${CLEAN}\n\nShe left\u00A0early.` },
    { name: "Chapter 2", original: CLEAN },
  ];
  const [invisible] = buildPublicationScan(units).findings.filter(
    (f) => f.check === "invisible_character",
  );
  assert.equal(invisible.messageKey, "scan_msg_invisible_at");
  assert.equal(invisible.location, "Chapter 1");
  assert.match(invisible.message, /left⍽early/);
});
