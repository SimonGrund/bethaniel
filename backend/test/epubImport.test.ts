// EPUB is a zip of XHTML, which means — unlike PDF — the text is text.
//
// This exists because a print-ready PDF could not be read at all: its fonts map
// to the wrong characters and no tool can recover them. The EPUB exported from
// the same typesetting run carries the same final text, correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { epubToMarkdown, InvalidEpubError } from "../src/epubToMarkdown.ts";

interface Doc {
  id: string;
  href: string;
  html: string;
}

/** A minimal but valid EPUB: container, OPF with a spine, and content. */
async function buildEpub(
  docs: Doc[],
  opts: { spine?: string[] } = {},
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
    media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );
  const spine = opts.spine ?? docs.map((d) => d.id);
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    ${docs
      .map(
        (d) =>
          `<item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`,
      )
      .join("\n    ")}
  </manifest>
  <spine>
    ${spine.map((id) => `<itemref idref="${id}"/>`).join("\n    ")}
  </spine>
</package>`,
  );
  for (const d of docs) {
    zip.file(
      `OEBPS/${d.href}`,
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>${d.html}</body></html>`,
    );
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

test("chapters come out as markdown, in spine order", async () => {
  const epub = await buildEpub([
    { id: "c1", href: "c1.xhtml", html: "<h1>Chapter One</h1><p>The first.</p>" },
    { id: "c2", href: "c2.xhtml", html: "<h1>Chapter Two</h1><p>The second.</p>" },
  ]);
  const md = await epubToMarkdown(epub);
  assert.match(md, /# Chapter One/);
  assert.match(md, /# Chapter Two/);
  assert.ok(
    md.indexOf("Chapter One") < md.indexOf("Chapter Two"),
    "chapters must keep their reading order",
  );
});

test("reading order comes from the spine, not the zip", async () => {
  // A zip has no inherent order and manifests are not sorted. The spine is the
  // only statement of what order a book is read in.
  const epub = await buildEpub(
    [
      { id: "b", href: "b.xhtml", html: "<p>Second in the book.</p>" },
      { id: "a", href: "a.xhtml", html: "<p>First in the book.</p>" },
    ],
    { spine: ["a", "b"] },
  );
  const md = await epubToMarkdown(epub);
  assert.ok(
    md.indexOf("First in the book") < md.indexOf("Second in the book"),
    md,
  );
});

test("italics survive, because they carry meaning in fiction", async () => {
  const epub = await buildEpub([
    { id: "c1", href: "c1.xhtml", html: "<p>She was <em>certain</em> of it.</p>" },
  ]);
  const md = await epubToMarkdown(epub);
  assert.match(md, /_certain_|\*certain\*/);
});

test("navigation and cover documents are left out of the prose", async () => {
  const epub = await buildEpub([
    {
      id: "nav",
      href: "nav.xhtml",
      html: `<nav epub:type="toc"><ol><li>Chapter One</li></ol></nav>`,
    },
    { id: "c1", href: "c1.xhtml", html: "<h1>Chapter One</h1><p>Real prose.</p>" },
  ]);
  const md = await epubToMarkdown(epub);
  assert.match(md, /Real prose/);
  assert.doesNotMatch(md, /^- Chapter One$/m, "the table of contents leaked in");
});

test("a file that is not an EPUB fails clearly", async () => {
  await assert.rejects(
    () => epubToMarkdown(Buffer.from("not a zip at all")),
    InvalidEpubError,
  );
});

test("a zip with no OPF is refused rather than half-read", async () => {
  const zip = new JSZip();
  zip.file("hello.txt", "nothing to see");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await assert.rejects(() => epubToMarkdown(buf), InvalidEpubError);
});
