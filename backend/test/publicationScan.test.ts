import test from "node:test";
import assert from "node:assert/strict";
import { buildPublicationScan } from "../src/publicationScan.ts";

// A block of >40 words, reused across tests where a "real" chapter body is needed.
const LONG = (seed: string) =>
  `${seed} ` +
  Array.from({ length: 45 }, (_, i) => `word${i}`).join(" ") +
  ".";

function checks(units: { name: string; original: string }[]) {
  return buildPublicationScan(units).findings;
}

test("a clean, distinct, well-numbered manuscript has no findings", () => {
  const report = buildPublicationScan([
    { name: "Chapter 1", original: LONG("alpha opening") },
    { name: "Chapter 2", original: LONG("beta middle") },
    { name: "Chapter 3", original: LONG("gamma ending") },
  ]);
  assert.equal(report.findings.length, 0);
  assert.equal(report.chaptersScanned, 3);
  assert.equal(report.summary.error, 0);
});

test("detects two chapters with identical bodies as a duplicate", () => {
  const body = LONG("same content here");
  const found = checks([
    { name: "Chapter 1", original: body },
    { name: "Chapter 2", original: LONG("different") },
    { name: "Chapter 3", original: body },
  ]);
  const dup = found.filter((f) => f.check === "duplicate");
  assert.equal(dup.length, 1);
  assert.equal(dup[0].severity, "error");
  assert.match(dup[0].location, /Chapter 1/);
  assert.match(dup[0].location, /Chapter 3/);
});

test("detects a large duplicated block shared by two otherwise-distinct chapters", () => {
  const shared =
    "This is a long shared paragraph that appears verbatim in two different chapters " +
    Array.from({ length: 40 }, (_, i) => `tok${i}`).join(" ") +
    ".";
  const found = checks([
    { name: "Chapter 1", original: `${LONG("unique one")}\n\n${shared}` },
    { name: "Chapter 2", original: `${LONG("unique two")}\n\n${shared}` },
  ]);
  const dup = found.filter((f) => f.check === "duplicate");
  assert.equal(dup.length, 1);
  assert.match(dup[0].message, /block|section|paragraph/i);
});

test("flags an empty chapter as an error and a very short one as a warning", () => {
  const found = checks([
    { name: "Chapter 1", original: LONG("full chapter") },
    { name: "Chapter 2", original: "   " },
    { name: "Chapter 3", original: "Only a handful of words here, nothing more." },
  ]);
  const empty = found.filter((f) => f.check === "empty_chapter");
  assert.equal(empty.length, 2);
  const err = empty.find((f) => f.severity === "error");
  const warn = empty.find((f) => f.severity === "warning");
  assert.ok(err, "empty chapter → error");
  assert.match(err!.location, /Chapter 2/);
  assert.ok(warn, "short chapter → warning");
  assert.match(warn!.location, /Chapter 3/);
});

test("detects a gap in chapter numbering", () => {
  const found = checks([
    { name: "Chapter 1", original: LONG("a") },
    { name: "Chapter 2", original: LONG("b") },
    { name: "Chapter 4", original: LONG("c") },
  ]);
  const num = found.filter((f) => f.check === "numbering");
  assert.equal(num.length, 1);
  assert.match(num[0].message, /3/);
});

test("detects a duplicate chapter number", () => {
  const found = checks([
    { name: "Chapter 1", original: LONG("a") },
    { name: "Chapter 5", original: LONG("b") },
    { name: "Chapter 5", original: LONG("c") },
  ]);
  const num = found.filter((f) => f.check === "numbering");
  assert.ok(num.some((f) => /5/.test(f.message)));
});

test("parses Roman numerals for numbering", () => {
  const found = checks([
    { name: "Chapter I", original: LONG("a") },
    { name: "Chapter II", original: LONG("b") },
    { name: "Chapter IV", original: LONG("c") },
  ]);
  const num = found.filter((f) => f.check === "numbering");
  assert.equal(num.length, 1, "III is missing between II and IV");
});

test("flags a chapter that ends mid-sentence", () => {
  const found = checks([
    { name: "Chapter 1", original: LONG("proper ending") },
    {
      name: "Chapter 2",
      original:
        "He walked to the door and reached for the handle and then he",
    },
  ]);
  const trunc = found.filter((f) => f.check === "truncation");
  assert.ok(trunc.some((f) => /Chapter 2/.test(f.location)));
});

test("does not flag a chapter ending in a closing quote", () => {
  const found = checks([
    { name: "Chapter 1", original: LONG("one") },
    { name: "Chapter 2", original: `${LONG("two")} “And that was that.”` },
  ]);
  assert.equal(found.filter((f) => f.check === "truncation").length, 0);
});

test("ignores unnumbered special sections in numbering checks", () => {
  const found = checks([
    { name: "Prologue", original: LONG("prologue") },
    { name: "Chapter 1", original: LONG("a") },
    { name: "Chapter 2", original: LONG("b") },
    { name: "Epilogue", original: LONG("epilogue") },
  ]);
  assert.equal(found.filter((f) => f.check === "numbering").length, 0);
});
