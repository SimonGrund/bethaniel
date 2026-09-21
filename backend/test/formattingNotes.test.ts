// ── The sidecar listing what a translation could not carry across ──
//
// The export used to say only "112 paragraphs lost emphasis", which told the
// author something was gone without saying what, and left reading the whole
// book against the original as the only way to find out.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFormattingNotes } from "../src/formattingNotes.ts";

const S = {
  title: "Formatting notes",
  intro: "A translation replaces whole paragraphs, so emphasis inside them could not be carried across.",
  summary: "{count} paragraph(s) lost emphasis.",
  wasEmphasised: "These were emphasised:",
  noneRecorded: "The emphasis carried no text of its own.",
  paragraphLabel: "Paragraph {n}",
};

const para = (before: string, emphasised: string[] = []) => ({
  paragraphIndex: 1,
  before,
  emphasised,
});

test("nothing lost means no document at all", () => {
  // Offering a download of an empty list is worse than offering nothing.
  assert.equal(buildFormattingNotes([], "book.docx", S), null);
});

test("the manuscript is named, so a loose file is identifiable", () => {
  const md = buildFormattingNotes([para("A paragraph.", ["italic bit"])], "book 2.docx", S);
  assert.ok(md!.includes("book 2.docx"));
});

test("each paragraph is quoted with what was emphasised in it", () => {
  const md = buildFormattingNotes(
    [para("She read the Gazette every morning.", ["Gazette"])],
    "book.docx",
    S,
  )!;
  assert.ok(md.includes("> She read the Gazette every morning."));
  assert.ok(md.includes("- Gazette"));
  assert.ok(md.includes("Paragraph 1"));
});

test("paragraphs are numbered in order", () => {
  const md = buildFormattingNotes(
    [para("First.", ["a"]), para("Second.", ["b"]), para("Third.", ["c"])],
    "book.docx",
    S,
  )!;
  assert.ok(md.indexOf("Paragraph 1") < md.indexOf("Paragraph 2"));
  assert.ok(md.indexOf("Paragraph 2") < md.indexOf("Paragraph 3"));
  assert.ok(md.includes("3 paragraph(s) lost emphasis."));
});

test("a long paragraph is excerpted, not reproduced whole", () => {
  // The notes are a place to look things up, not a second copy of the book.
  const long = "x".repeat(500);
  const md = buildFormattingNotes([para(long, ["y"])], "book.docx", S)!;
  assert.ok(md.includes("…"));
  assert.ok(!md.includes("x".repeat(300)));
});

test("newlines inside a paragraph are flattened so the quote stays one block", () => {
  const md = buildFormattingNotes(
    [para("One line.\n\nAnother line.", ["bit"])],
    "book.docx",
    S,
  )!;
  // A bare newline inside a "> " quote would end the quote early.
  const quote = md.split("\n").find((l) => l.startsWith("> "))!;
  assert.ok(quote.includes("One line. Another line."));
});

test("formatting that carried no text says so rather than showing an empty list", () => {
  const md = buildFormattingNotes([para("A paragraph.", [])], "book.docx", S)!;
  assert.ok(md.includes(S.noneRecorded));
  assert.ok(!md.includes("\n- \n"));
});

test("blank emphasis entries are dropped, not listed as empty bullets", () => {
  const md = buildFormattingNotes(
    [para("A paragraph.", ["  ", "real"])],
    "book.docx",
    S,
  )!;
  const bullets = md.split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(bullets, ["- real"]);
});
