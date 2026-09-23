// Calibration against two real manuscripts.
//
// Skipped unless the corpus is present — these are the author's own books and
// are not checked in. Extract them with the sqlite3 commands in
// docs/superpowers/plans/2026-09-23-one-reading-of-a-quotation-mark.md.
//
// What this pins: the five defects the old check missed are caught, the
// legitimate seven-paragraph legend stays silent, and the scan stays
// byte-identical across runs so a second run of it can never be worth making.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { findChapters } from "../src/chapters.ts";
import { buildPublicationScan } from "../src/publicationScan.ts";

const DIR = "/tmp/quote-corpus";
const have = existsSync(`${DIR}/rage.md`) && existsSync(`${DIR}/taker.md`);

function scanBook(file: string) {
  const md = readFileSync(`${DIR}/${file}`, "utf8");
  const units = findChapters(md).map((c) => ({
    name: c.title,
    original: md.slice(c.start, c.end),
  }));
  return buildPublicationScan(units as never, { manuscriptLang: "en" } as never);
}

test("the five straight-among-curly defects are caught", { skip: !have }, () => {
  const messages = [
    ...scanBook("rage.md").findings,
    ...scanBook("taker.md").findings,
  ]
    .filter((f) => f.check === "quote_style")
    .map((f) => f.message)
    .join("\n");
  // Each phrase must fall inside excerptOf's 110-character window, which is
  // what the author actually reads on the finding.
  for (const passage of [
    "But—", // Taker, Chapter Eight
    "to be any threat to them", // Taker, Chapter Fifteen
    "Mutiny is a crime", // Rage, Chapter eight — "…remembering so."
    "get too boring for you", // Rage, Chapter nine
    "Share your knowledge", // Rage, Frontmatter
  ]) {
    assert.ok(messages.includes(passage), `missed: ${passage}`);
  }
});

test("the seven-paragraph legend stays silent", { skip: !have }, () => {
  // Path of the Taker, Chapter Four #83–#89: a story told aloud, each
  // paragraph re-opening with “ and the last one closing. The case that keeps
  // the tolerances honest — a scan that reports this is worse than the one
  // this replaced.
  const ch4 = scanBook("taker.md").findings.filter(
    (f) => f.location === "Chapter Four",
  );
  assert.deepEqual(ch4, []);
});

test("the scan is byte-identical across runs", { skip: !have }, () => {
  // No LLM, no randomness, no clock. Which is why running the publication
  // scan twice cannot find anything the first run missed.
  assert.equal(
    JSON.stringify(scanBook("rage.md")),
    JSON.stringify(scanBook("rage.md")),
  );
  assert.equal(
    JSON.stringify(scanBook("taker.md")),
    JSON.stringify(scanBook("taker.md")),
  );
});
