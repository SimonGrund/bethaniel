// "Can I safely click publish?" is the question this run exists to answer.
//
// It used to answer with per-chapter lists in which "wrinled → wrinkled" and
// "a chapter's dialogue is unclosed" carried equal weight. Every structural
// finding on a real book turned out to be a genuine defect worth fixing before
// release; the LLM's comma suggestions did not.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPublicationScan } from "../src/publicationScan.ts";

const PROSE = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i} of ordinary prose carrying the chapter along nicely.`,
).join("\n\n");

function scan(units: { name: string; original: string }[]) {
  return buildPublicationScan(units as never);
}

test("structural findings are marked as blocking publication", () => {
  const report = scan([
    { name: "Chapter one", original: `${PROSE}\n\nAaron shrugged. “We can try.\n\nHe left.` },
  ]);
  const quote = report.findings.find((f) => /quotation/i.test(f.message));
  assert.ok(quote, "the unclosed quote should be found");
  assert.equal(quote.blocking, true);
});

test("a clean book blocks nothing", () => {
  const report = scan([
    { name: "Chapter one", original: `${PROSE}\n\nIt ended well.` },
    { name: "Chapter two", original: `${PROSE}\n\nAnd so did this one.` },
  ]);
  assert.equal(report.findings.filter((f) => f.blocking).length, 0);
  assert.equal(report.chaptersScanned, 2);
});

test("every finding carries a blocking decision, none left undefined", () => {
  // The UI groups on this flag; an undefined would quietly fall into "minor"
  // and hide a real defect.
  const report = scan([
    { name: "Chapter one", original: "tiny" },
    { name: "Chapter two", original: `${PROSE}\n\nEnds properly.` },
    { name: "Chapter two", original: `${PROSE}\n\nEnds properly.` },
  ]);
  assert.ok(report.findings.length > 0);
  for (const f of report.findings) {
    assert.equal(typeof f.blocking, "boolean", JSON.stringify(f));
  }
});
