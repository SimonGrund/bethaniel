// ── The structural findings, in the order of the book ──
//
// The scan runs check by check, so its findings came out grouped by check —
// every duplicate, then every repetition, then every empty chapter — and an
// author working down the report jumped from chapter 9 back to chapter 2
// and on to 6. The panel and the PDF both print the list as given, so the
// order is fixed where the list is made: by the chapter each finding is
// about, the whole-book ones first because they belong to no chapter.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPublicationScan, type ScanUnit } from "../src/publicationScan.ts";

const PROSE = [
  "“She didn’t answer,” he said. “It wasn’t Tobias’s place to ask.”",
  "The harbour was quiet, and the tide was going out. She waited for him.",
  "The chapter ended the way the others had, with nothing settled at all.",
].join("\n\n");

function book(): ScanUnit[] {
  return [
    { name: "Chapter 1", original: PROSE },
    // Chapter 2: doubled punctuation — a check that runs late.
    { name: "Chapter 2", original: PROSE.replace("settled at all.", "settled at all.,” she said.") },
    { name: "Chapter 3", original: `${PROSE}\n\nMorning came, and nothing had changed.` },
    // Chapter 4: cut off mid-sentence — truncation runs in the middle.
    { name: "Chapter 4", original: `${PROSE}\n\nShe walked out into the rain without` },
    // Chapter 5: nearly empty — a check that runs early.
    { name: "Chapter 5", original: "Nothing here." },
    { name: "Chapter 6", original: `${PROSE}\n\nThe placeholder stays. TODO: the storm.` },
  ];
}

test("structural findings are listed in chapter order, whatever check found them", () => {
  const { findings } = buildPublicationScan(book(), { manuscriptLang: "en" });
  const chapters = findings.filter((f) => !f.wholeManuscript).map((f) => f.location);
  assert.deepEqual(chapters, [...chapters].sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))));
  assert.ok(chapters.includes("Chapter 2") && chapters.includes("Chapter 5"), chapters.join(", "));
});

test("findings about the whole book come before the chapters", () => {
  const { findings } = buildPublicationScan(book(), { manuscriptLang: "en" });
  const firstChapter = findings.findIndex((f) => !f.wholeManuscript);
  const lastWhole = findings.map((f) => !!f.wholeManuscript).lastIndexOf(true);
  assert.ok(lastWhole >= 0, "the placeholder in chapter 6 is reported for the whole book");
  assert.ok(lastWhole < firstChapter, findings.map((f) => f.location).join(", "));
});

test("a finding spanning chapters sits at the first of them", () => {
  const units = book();
  units.push({ name: "Chapter 7", original: units[0].original }); // duplicates chapter 1
  const { findings } = buildPublicationScan(units, { manuscriptLang: "en" });
  const dup = findings.findIndex((f) => f.check === "duplicate");
  const ch2 = findings.findIndex((f) => f.location === "Chapter 2");
  assert.ok(dup >= 0 && dup < ch2, findings.map((f) => f.location).join(", "));
});

// ── Reports saved before the scan sorted them ──

import { inChapterOrder } from "../../frontend/src/scanFinding.ts";

test("an old report is put in order by its chapter names", () => {
  // The shape a saved result has: no unitIndex, grouped by check.
  const saved = [
    { location: "Chapter 9 ↔ Chapter 2", message: "duplicate" },
    { location: "Chapter 5", message: "empty" },
    { location: "Chapter 1 → Chapter 3", message: "gap" },
    { location: "Manuscript", message: "apostrophes" },
    { location: "Epilogue?", message: "unknown chapter" },
    { location: "Chapter 2", message: "truncation" },
  ];
  const names = ["Chapter 1", "Chapter 2", "Chapter 3", "Chapter 5", "Chapter 9"];
  assert.deepEqual(
    inChapterOrder(saved, names).map((f) => f.message),
    ["apostrophes", "gap", "truncation", "empty", "duplicate", "unknown chapter"],
  );
});

test("a new report's own chapter index wins over its name", () => {
  const fresh = [
    { location: "Kapitel 2", message: "b", unitIndex: 1 },
    { location: "Kapitel 2", message: "a", unitIndex: 0 }, // two chapters, one name
  ];
  assert.deepEqual(inChapterOrder(fresh, []).map((f) => f.message), ["a", "b"]);
});
