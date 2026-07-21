// DOCX import structural fidelity: section breaks (empty paragraphs) and
// chapter/title heading styles. A real manuscript lost a section break on
// import: the raw-XML paragraph splitter `/<w:p\b[\s\S]*?(?:<\/w:p>|\/>)/g`
// truncated any FORMATTED paragraph at the first self-closing child tag
// (`<w:jc/>`, `<w:spacing/>`, `<w:pStyle/>`, …). The truncated fragment had no
// `<w:t>`, so content paragraphs were misclassified as empty, the block
// alignment shifted, and the blank line between two paragraphs collapsed to an
// ordinary boundary. These tests build real .docx zips by hand (same approach
// as italics.test.ts) so the import path is exercised end to end.

import { test } from "node:test";
import assert from "node:assert/strict";

import { docxToMarkdown } from "../src/conversion.ts";
import { findChapters } from "../src/chapters.ts";

// Build a minimal but valid .docx from a list of <w:p> paragraph XML strings.
// Optionally include a styles.xml part (for heading-style tests).
async function buildDocx(
  paragraphsXml: string[],
  stylesXml?: string,
): Promise<Buffer> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${
    stylesXml
      ? `\n  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`
      : ""
  }
</Types>`;
  zip.file("[Content_Types].xml", contentTypes);

  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  if (stylesXml) {
    zip.file(
      "word/_rels/document.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    );
    zip.file("word/styles.xml", stylesXml);
  }

  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraphsXml.join("\n    ")}
  </w:body>
</w:document>`,
  );

  return zip.generateAsync({ type: "nodebuffer" });
}

const para = (text: string) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// A justified/formatted paragraph — its <w:pPr> carries a self-closing child
// (<w:jc/>) before the text, the shape that tripped the old splitter regex.
const fpara = (text: string) =>
  `<w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// ── section breaks: empty paragraphs in various encodings ──

test("formatted paragraphs keep the section break (the real bug)", async () => {
  // Every paragraph is justified (<w:jc/> in pPr) — exactly what Word writes for
  // a normal manuscript — with an empty paragraph as the section break.
  const buf = await buildDocx([
    fpara("she was about to show the children."),
    `<w:p></w:p>`,
    fpara("They hovered over the world, invisible"),
  ]);
  const md = await docxToMarkdown(buf);
  assert.match(
    md,
    /show the children\.\n{3,}They hovered/,
    `section break collapsed: ${JSON.stringify(md)}`,
  );
});

test("formatted empty paragraph (pPr but no text) is still a section break", async () => {
  const buf = await buildDocx([
    fpara("First para."),
    `<w:p><w:pPr><w:jc w:val="both"/></w:pPr></w:p>`,
    fpara("Second para."),
  ]);
  const md = await docxToMarkdown(buf);
  assert.match(md, /First para\.\n{3,}Second para\./, JSON.stringify(md));
});

test("whitespace-only paragraph is preserved as a section break (the bug)", async () => {
  const buf = await buildDocx([
    para("First para."),
    // A blank line the author typed as a paragraph containing a single space.
    `<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>`,
    para("Second para."),
  ]);
  const md = await docxToMarkdown(buf);
  assert.match(
    md,
    /First para\.\n{3,}Second para\./,
    `section break collapsed: ${JSON.stringify(md)}`,
  );
});

test("truly empty <w:p></w:p> still preserves the section break", async () => {
  const buf = await buildDocx([
    para("First para."),
    `<w:p></w:p>`,
    para("Second para."),
  ]);
  const md = await docxToMarkdown(buf);
  assert.match(md, /First para\.\n{3,}Second para\./, JSON.stringify(md));
});

test("tab-only paragraph counts as a section break", async () => {
  const buf = await buildDocx([
    para("First para."),
    `<w:p><w:r><w:tab/></w:r></w:p>`,
    para("Second para."),
  ]);
  const md = await docxToMarkdown(buf);
  assert.match(md, /First para\.\n{3,}Second para\./, JSON.stringify(md));
});

test("nbsp-only paragraph counts as a section break", async () => {
  const buf = await buildDocx([
    para("First para."),
    `<w:p><w:r><w:t xml:space="preserve"> </w:t></w:r></w:p>`,
    para("Second para."),
  ]);
  const md = await docxToMarkdown(buf);
  assert.match(md, /First para\.\n{3,}Second para\./, JSON.stringify(md));
});

test("two adjacent content paragraphs stay a single boundary (no spurious blank)", async () => {
  const buf = await buildDocx([para("One."), para("Two.")]);
  const md = await docxToMarkdown(buf);
  // Exactly one paragraph boundary, no extra empty paragraph between them.
  assert.equal(md.trim(), "One.\n\nTwo.", JSON.stringify(md));
});

// ── chapter/title heading styles ──
// mammoth maps heading styles to h1/h2 (→ markdown "#"), the most reliable
// chapter-detection signal. Localized docs carry the English styleId ("Heading1")
// under a translated w:name ("Overskrift 1"); the styleId map must catch them.

const headingStyles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="Overskrift 1"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Title">
    <w:name w:val="Titel"/>
  </w:style>
</w:styles>`;

const styledPara = (styleId: string, text: string) =>
  `<w:p><w:pPr><w:pStyle w:val="${styleId}"/></w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

test("localized Heading 1 (styleId) imports as a markdown heading", async () => {
  const buf = await buildDocx(
    [styledPara("Heading1", "Kapitel Et"), para("Der var engang.")],
    headingStyles,
  );
  const md = await docxToMarkdown(buf);
  assert.match(md, /^#\s+Kapitel Et$/m, JSON.stringify(md));
});

test("Title style imports as a top-level heading", async () => {
  const buf = await buildDocx(
    [styledPara("Title", "Bogens Navn"), para("Kapitel indhold.")],
    headingStyles,
  );
  const md = await docxToMarkdown(buf);
  assert.match(md, /^#\s+Bogens Navn$/m, JSON.stringify(md));
});

test("localized headings feed findChapters", async () => {
  const buf = await buildDocx(
    [
      styledPara("Heading1", "Kapitel Et"),
      para("Første scene."),
      styledPara("Heading1", "Kapitel To"),
      para("Anden scene."),
    ],
    headingStyles,
  );
  const md = await docxToMarkdown(buf);
  const chapters = findChapters(md);
  assert.equal(chapters.length, 2, JSON.stringify({ md, chapters }));
  assert.deepEqual(
    chapters.map((c) => c.title),
    ["Kapitel Et", "Kapitel To"],
  );
});
