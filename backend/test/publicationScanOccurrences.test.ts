// ── Findings an author can act on: where, not just how many ──
//
// The typography checks reported one line per kind for the whole book —
// "6 ellipses typed as three dots… 2 invisible characters…" — with the
// first example and no chapter. An author could not find the other five,
// and could not find the invisible characters at all: the excerpt collapsed
// whitespace, so the non-breaking space it was showing vanished from it.
//
// Now each one is its own finding, with its chapter and its sentence — up to
// twenty of the same kind. Past twenty a list stops helping, and the line
// says how many and names the copy edit that fixes them all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPublicationScan, type ScanUnit } from "../src/publicationScan.ts";
import { useTranslation } from "../../frontend/src/i18n.ts";
import { localiseFinding } from "../../frontend/src/scanFinding.ts";

// Curly apostrophes and real ellipses, so both conventions are clear.
const CLEAN = [
  "“She didn’t answer,” he said. “It wasn’t Tobias’s place to ask.”",
  "The harbour was quiet… and the tide was going out. She waited…",
  "“We couldn’t stay,” Bria said. “The captain’s watch was ending…”",
  "Nobody said a thing… and the chapter ended the way the others had.",
].join("\n\n");

const scan = (units: ScanUnit[]) => buildPublicationScan(units, { manuscriptLang: "en" }).findings;
const ofCheck = (units: ScanUnit[], check: string) => scan(units).filter((f) => f.check === check);

test("each off-style ellipsis is listed with its chapter and sentence", () => {
  const found = ofCheck(
    [
      { name: "Chapter 1", original: CLEAN },
      { name: "Chapter 2", original: `${CLEAN}\n\nI saw it myself... They had arrows.` },
      { name: "Chapter 3", original: `${CLEAN}\n\nWait... no. Not yet... not now.` },
    ],
    "ellipsis_style",
  );
  assert.deepEqual(
    found.map((f) => f.location),
    ["Chapter 2", "Chapter 3", "Chapter 3"],
  );
  assert.match(found[0].message, /myself\.\.\. They had arrows/);
  assert.equal(found[0].wholeManuscript, undefined);
  assert.equal(found[0].unitIndex, 1);
});

test("an invisible character is shown where it is", () => {
  const found = ofCheck(
    [
      { name: "Chapter 1", original: CLEAN },
      { name: "Chapter 2", original: `${CLEAN}\n\nShe fought for Karim, not for herself.` },
    ],
    "invisible_character",
  );
  assert.equal(found.length, 1);
  assert.equal(found[0].location, "Chapter 2");
  assert.match(found[0].message, /fought for⍽Karim/);
});

test("a placeholder is placed in its chapter", () => {
  const [found] = ofCheck(
    [
      { name: "Chapter 1", original: CLEAN },
      { name: "Chapter 2", original: `${CLEAN}\n\nThe room is here. TODO: describe it.` },
    ],
    "placeholder",
  );
  assert.equal(found.location, "Chapter 2");
  assert.match(found.message, /\(TODO\): ".*TODO: describe it/);
});

// ── Twenty of the same kind ──

function withStraight(n: number): ScanUnit[] {
  // A curly book (the CLEAN chapters) with n straight apostrophes in one.
  const lines = Array.from({ length: n }, (_, i) => `Line ${i}: it's here.`).join("\n\n");
  return [
    ...Array.from({ length: 12 }, (_, i) => ({ name: `Chapter ${i + 1}`, original: CLEAN })),
    { name: "Chapter 13", original: lines },
  ];
}

test("twenty of one kind are still listed one by one", () => {
  const found = ofCheck(withStraight(20), "apostrophe_style");
  assert.equal(found.length, 20);
  assert.ok(found.every((f) => f.location === "Chapter 13"));
});

test("past twenty, one line says how many and names the copy edit that fixes them", () => {
  const found = ofCheck(withStraight(21), "apostrophe_style");
  assert.equal(found.length, 1);
  assert.equal(found[0].wholeManuscript, true);
  assert.equal(found[0].params?.n, 21);
  assert.match(found[0].detail ?? "", /“Find errors \(copy edits\)” fixes them all/);
  // In Danish, the card is named as the Danish author sees it.
  const da = localiseFinding(found[0], useTranslation("da"));
  assert.match(da.detail ?? "", /“Find fejl \(korrektur\)”/);
});

test("the limit counts each kind apart", () => {
  // 21 straight apostrophes collapse; the one stray ellipsis beside them
  // is still listed on its own.
  const units = withStraight(21);
  units.push({ name: "Chapter 14", original: `${CLEAN}\n\nThen... nothing.` });
  const findings = scan(units);
  assert.equal(findings.filter((f) => f.check === "apostrophe_style").length, 1);
  const ellipsis = findings.filter((f) => f.check === "ellipsis_style");
  assert.equal(ellipsis.length, 1);
  assert.equal(ellipsis[0].location, "Chapter 14");
});

test("doubled punctuation follows the same limit, and names the copy edit too", () => {
  const pairs = (n: number): ScanUnit[] => [
    { name: "Chapter 1", original: Array.from({ length: n }, (_, i) => `Line ${i} ended., and went on.`).join("\n\n") },
  ];
  assert.equal(ofCheck(pairs(20), "punctuation_pair").length, 20);
  const [summary] = ofCheck(pairs(21), "punctuation_pair");
  assert.equal(summary.params?.n, 21);
  assert.match(summary.detail ?? "", /fixes them all/);
});
