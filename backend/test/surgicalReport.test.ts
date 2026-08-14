// The skip report travels in a response header, so it has a hard size budget.
//
// Adding the surrounding context to each skipped edit made the report roughly
// ten times bigger. A document with many mixed-formatting edits could push it
// past what servers and browsers accept — and losing the export because the
// explanation of what was left out grew too large would be a poor trade.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildReportHeader,
  MAX_REPORT_HEADER_BYTES,
} from "../src/surgicalReport.ts";
import type { SkippedEdit } from "../src/docxSurgery.ts";

function skip(i: number, contextLen = 160): SkippedEdit {
  return {
    start: 0,
    end: 5,
    replacement: `replacement ${i}`,
    paragraphIndex: i,
    original: `original ${i}`,
    context: "x".repeat(contextLen),
    reason: "mixed-formatting",
  };
}

test("a small report travels whole", () => {
  const header = buildReportHeader([skip(0), skip(1)], []);
  const parsed = JSON.parse(decodeURIComponent(header));
  assert.equal(parsed.skipped.length, 2);
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.skipped[0].replacement, "replacement 0");
  assert.ok(parsed.skipped[0].context, "context must survive");
});

test("a large report is trimmed to fit rather than sent oversized", () => {
  const many = Array.from({ length: 400 }, (_, i) => skip(i));
  const header = buildReportHeader(many, []);
  assert.ok(
    Buffer.byteLength(header) <= MAX_REPORT_HEADER_BYTES,
    `header was ${Buffer.byteLength(header)} bytes`,
  );
  const parsed = JSON.parse(decodeURIComponent(header));
  assert.ok(parsed.skipped.length > 0, "some rows should still get through");
  assert.ok(parsed.skipped.length < many.length);
});

test("a trimmed report says so, and says how many it is describing", () => {
  const many = Array.from({ length: 400 }, (_, i) => skip(i));
  const parsed = JSON.parse(decodeURIComponent(buildReportHeader(many, [])));
  assert.equal(parsed.truncated, true);
  // The user must not be told "here are your 12 unapplied changes" when there
  // were 400 of them.
  assert.equal(parsed.totalSkipped, 400);
});

test("non-ASCII prose is measured after encoding, not before", () => {
  // encodeURIComponent turns one 'ø' into 9 bytes. Measuring the raw string
  // would let a Danish manuscript sail past the budget.
  const danish = Array.from({ length: 400 }, (_, i) => ({
    ...skip(i),
    context: "søen lå stille og mørk under bøgetræerne ".repeat(4),
  }));
  const header = buildReportHeader(danish, []);
  assert.ok(
    Buffer.byteLength(header) <= MAX_REPORT_HEADER_BYTES,
    `header was ${Buffer.byteLength(header)} bytes`,
  );
});

test("the header is always parseable, even with nothing to report", () => {
  const parsed = JSON.parse(decodeURIComponent(buildReportHeader([], [])));
  assert.deepEqual(parsed.skipped, []);
  assert.deepEqual(parsed.unmapped, []);
  assert.equal(parsed.truncated, false);
});
