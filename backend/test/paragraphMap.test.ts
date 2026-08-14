// The paragraph map is what lets surgical export find the original runs for a
// chapter of edited markdown. If an offset is wrong the edit lands in the wrong
// place, so these assert the map against the markdown it describes — the map
// must be able to reproduce each paragraph's text by slicing.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { docxToMarkdownMapped } from "../src/conversion.ts";

const r = (t: string) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;

async function docx(bodyXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

test("every mapped span slices back to that paragraph's text", async () => {
  const buf = await docx(
    `<w:p>${r("First paragraph here.")}</w:p>` +
      `<w:p>${r("Second paragraph follows.")}</w:p>` +
      `<w:p>${r("And a third.")}</w:p>`,
  );
  const { md, paragraphMap } = await docxToMarkdownMapped(buf);

  assert.equal(paragraphMap.length, 3);
  assert.equal(md.slice(paragraphMap[0].mdStart, paragraphMap[0].mdEnd), "First paragraph here.");
  assert.equal(md.slice(paragraphMap[1].mdStart, paragraphMap[1].mdEnd), "Second paragraph follows.");
  assert.equal(md.slice(paragraphMap[2].mdStart, paragraphMap[2].mdEnd), "And a third.");
});

test("spans are ordered and never overlap", async () => {
  const buf = await docx(
    `<w:p>${r("One.")}</w:p><w:p>${r("Two.")}</w:p><w:p>${r("Three.")}</w:p>`,
  );
  const { paragraphMap } = await docxToMarkdownMapped(buf);
  for (let i = 1; i < paragraphMap.length; i++) {
    assert.ok(
      paragraphMap[i].mdStart >= paragraphMap[i - 1].mdEnd,
      "spans must not overlap",
    );
  }
});

test("docx paragraph indices survive empty paragraphs between blocks", async () => {
  // Empty Word paragraphs become blank lines, not map entries — but they still
  // consume an ordinal, and the surgery scanner counts them the same way.
  const buf = await docx(
    `<w:p>${r("Before.")}</w:p><w:p/><w:p/><w:p>${r("After.")}</w:p>`,
  );
  const { md, paragraphMap } = await docxToMarkdownMapped(buf);
  assert.equal(paragraphMap.length, 2);
  assert.equal(paragraphMap[0].docxParaIndex, 0);
  assert.equal(paragraphMap[1].docxParaIndex, 3, "index must skip the empties");
  assert.equal(md.slice(paragraphMap[1].mdStart, paragraphMap[1].mdEnd), "After.");
});

test("table paragraphs are marked unmappable", async () => {
  const buf = await docx(
    `<w:p>${r("Body text.")}</w:p>` +
      `<w:tbl><w:tr><w:tc><w:p>${r("cell")}</w:p></w:tc></w:tr></w:tbl>`,
  );
  const { paragraphMap } = await docxToMarkdownMapped(buf);
  const body = paragraphMap.find((e) => e.docxParaIndex === 0);
  const cell = paragraphMap.find((e) => e.docxParaIndex === 1);
  assert.equal(body?.mappable, true);
  assert.equal(cell?.mappable, false, "table text is preserved but not edited");
});

test("the real sample manuscript maps every paragraph it imports", async () => {
  const fs = await import("fs");
  const path = await import("path");
  const { fileURLToPath } = await import("url");
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const buf = fs.readFileSync(
    path.join(repo, "sample_texts", "two_chapters_english.docx"),
  );

  const { md, paragraphMap } = await docxToMarkdownMapped(buf);
  assert.ok(paragraphMap.length > 5, "expected a real map");
  for (const e of paragraphMap) {
    const slice = md.slice(e.mdStart, e.mdEnd);
    assert.ok(slice.length > 0, `empty span for paragraph ${e.docxParaIndex}`);
    assert.equal(slice, slice.trim(), "spans must not include surrounding blanks");
  }
});
