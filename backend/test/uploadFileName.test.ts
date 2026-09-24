// ── What an uploaded file is called ──
//
// multer 1.x hands busboy's file name through decoded as Latin-1, while every
// browser sends it as UTF-8. "Bogbinderen i Havnsø.md" arrived as
// "Bogbinderen i HavnsÃ¸.md" — and that name is what the upload card shows
// and what every export is named after.

import { test } from "node:test";
import assert from "node:assert/strict";

import { uploadFileName } from "../src/uploadFileName.ts";

/** What multer produces from a UTF-8 name: its bytes read as Latin-1. */
const asMulterSees = (name: string) => Buffer.from(name, "utf8").toString("latin1");

test("Danish, German, French and Spanish letters survive the upload", () => {
  for (const name of [
    "Bogbinderen i Havnsø.md",
    "Æblet og åen.docx",
    "Größenwahn.epub",
    "Hélène à la plage.pdf",
    "El niño.md",
  ])
    assert.equal(uploadFileName(asMulterSees(name)), name, name);
});

test("characters outside Latin-1 survive too", () => {
  for (const name of ["Книга.docx", "本.md", "draft — final ✓.docx"])
    assert.equal(uploadFileName(asMulterSees(name)), name, name);
});

test("a plain ASCII name is unchanged", () => {
  assert.equal(uploadFileName("book 2.docx"), "book 2.docx");
});

test("a name that is not UTF-8 bytes is left as it came", () => {
  // Already correct (a client that sent RFC 5987 filename*, which busboy
  // decodes properly): re-reading it would turn "ø" into a replacement char.
  assert.equal(uploadFileName("Havnsø.md"), "Havnsø.md");
});
