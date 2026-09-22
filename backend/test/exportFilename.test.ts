// ── What an exported file is called ──
//
// Named from the manuscript, not from the pipeline. A translation of
// "book 2.docx" came out as "book 2.docx.full.docx" — the source extension
// kept, a word from the export code appended, and nothing at all saying which
// language it is in, which is the one thing an author with four translations
// in a folder needs to see.
//
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import { exportBaseName, sidecarName } from "../../frontend/src/exportFilename.ts";

test("a translation is named for the manuscript and its language", () => {
  assert.equal(
    exportBaseName({ source: "book 2.docx", scope: "full", targetLang: "French" }),
    "book 2 (French)",
  );
});

test("the source extension is not carried into the name", () => {
  // "book 2.docx.full.docx" — the old shape. Any import extension goes.
  for (const src of ["book 2.docx", "book 2.epub", "book 2.md", "book 2.pdf"])
    assert.equal(exportBaseName({ source: src, scope: "full" }), "book 2.full", src);
});

test("a name with a dot inside it keeps everything but the extension", () => {
  assert.equal(
    exportBaseName({ source: "vol. 2 final.docx", scope: "full", targetLang: "German" }),
    "vol. 2 final (German)",
  );
});

test("one chapter is named after the chapter", () => {
  assert.equal(
    exportBaseName({
      source: "book 2.docx",
      scope: "one",
      chapterName: "Chapter 5",
      targetLang: "French",
    }),
    "Chapter 5 (French)",
  );
  assert.equal(
    exportBaseName({ source: "book 2.docx", scope: "one", chapterName: "Chapter 5" }),
    "Chapter 5.edited",
  );
});

test("a selection of chapters says so", () => {
  assert.equal(
    exportBaseName({ source: "book 2.docx", scope: "chapters", targetLang: "French" }),
    "book 2 (French) chapters",
  );
  assert.equal(
    exportBaseName({ source: "book 2.docx", scope: "chapters" }),
    "book 2.chapters",
  );
});

test("characters a file system refuses are replaced, not passed on", () => {
  // Real chapter titles carry colons: "Chapter 5: The Building Blocks of
  // Non-Monogamy". A colon is the path separator in Finder's own display and
  // is illegal on Windows outright.
  const name = exportBaseName({
    source: "book.docx",
    scope: "one",
    chapterName: 'Ch 5: A/B "testing" <or> not?',
  });
  assert.doesNotMatch(name, /[/\\:*?"<>|]/);
  assert.match(name, /Ch 5/);
});

test("an absurdly long chapter title is cut to something a Finder can show", () => {
  const long = "Chapter 5 " + "of non-monogamy ".repeat(30);
  const name = exportBaseName({ source: "book.docx", scope: "one", chapterName: long });
  assert.ok(name.length <= 80, `still ${name.length} characters`);
  assert.ok(name.startsWith("Chapter 5"), name);
  assert.doesNotMatch(name, / $/, "left a trailing space before the extension");
});

test("an empty or extension-only source still yields a name", () => {
  assert.equal(exportBaseName({ source: "", scope: "full" }), "manuscript.full");
  assert.equal(exportBaseName({ source: ".docx", scope: "full" }), "manuscript.full");
});

test("the sidecar is named after the file it belongs to", () => {
  assert.equal(
    sidecarName("book 2 (French)", "formatting notes"),
    "book 2 (French) formatting notes",
  );
});
