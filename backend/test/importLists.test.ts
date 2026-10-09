// ── Lists and small headings survive import ──
//
// The importer picked text blocks out of mammoth's HTML with
// /<(p|h1|h2|h3)…>/, and mammoth writes a list item as <li>…</li> and a
// Heading 4–6 as <h4>–<h6>. Every list in every Word manuscript was dropped
// on import (since v1.2.8): never translated, never edited, never proofread.
// Found on a Danish handbook — 96 list items, 1,161 words. And since the
// importer walks Word's paragraphs and the HTML blocks side by side, each
// dropped item also shifted every later paragraph's map by one.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { AlignmentType, Document, HeadingLevel, LevelFormat, Packer, Paragraph } from "docx";

import { docxToMarkdownMapped } from "../src/conversion.ts";
import { indexDocumentXml } from "../src/docxSurgery.ts";
import { stripMarkdown } from "../src/docxRemap.ts";

async function sample(): Promise<Buffer> {
  const doc = new Document({
    numbering: {
      config: [
        { reference: "bullets", levels: [
          { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT },
          { level: 1, format: LevelFormat.BULLET, text: "◦", alignment: AlignmentType.LEFT },
        ] },
        { reference: "numbers", levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT }] },
      ],
    },
    sections: [{ children: [
      new Paragraph("Psykologisk tryghed er relevant for alle, men særligt hvis:"),
      new Paragraph({ text: "Arbejdet rummer mange ubekendte faktorer.", numbering: { reference: "bullets", level: 0 } }),
      new Paragraph({ text: "Et underpunkt.", numbering: { reference: "bullets", level: 1 } }),
      new Paragraph({ text: "Man har et psykisk krævende job.", numbering: { reference: "bullets", level: 0 } }),
      new Paragraph("Et almindeligt afsnit imellem."),
      new Paragraph({ text: "Første skridt.", numbering: { reference: "numbers", level: 0 } }),
      new Paragraph({ text: "Andet skridt.", numbering: { reference: "numbers", level: 0 } }),
      new Paragraph({ text: "En lille overskrift", heading: HeadingLevel.HEADING_4 }),
      new Paragraph("Det sidste afsnit."),
    ] }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

test("every list item and a Heading 4 reach the markdown, markers and all", async () => {
  const { md } = await docxToMarkdownMapped(await sample());
  for (const line of [
    "- Arbejdet rummer mange ubekendte faktorer.",
    "  - Et underpunkt.",
    "- Man har et psykisk krævende job.",
    "1. Første skridt.",
    "2. Andet skridt.",
    "#### En lille overskrift",
    "Det sidste afsnit.",
  ]) {
    assert.ok(md.includes(line), `missing: ${line}\n---\n${md}`);
  }
});

test("each block maps to its own Word paragraph, before and after the lists", async () => {
  const buf = await sample();
  const { md, paragraphMap } = await docxToMarkdownMapped(buf);
  const zip = await JSZip.loadAsync(buf);
  const index = indexDocumentXml(await zip.file("word/document.xml")!.async("string"));
  assert.equal(paragraphMap.length, 9);
  for (const e of paragraphMap) {
    const block = stripMarkdown(md.slice(e.mdStart, e.mdEnd)).replace(/^\s*(?:\d+[.)]|[-*])\s+/, "").trim();
    assert.equal(index.paragraphs[e.docxParaIndex].text.trim(), block);
  }
});

// Found on the same book: a paragraph holding only a decorative shape (a box
// drawn behind a sidebar) has no text and gets no block from mammoth, but it
// carries an object, so it was not counted as empty and took the next
// paragraph's block — shifting the map of everything after it by one.
test("a paragraph holding only a shape does not take the next paragraph's text", async () => {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"';
  const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const shape = `<w:p><w:r><w:drawing><wp:anchor><wp:extent cx="100" cy="100"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:spPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>${para("Før kassen.")}${shape}${para("Prøvehandling")}${para("Efter kassen.")}</w:body></w:document>`);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const { md, paragraphMap } = await docxToMarkdownMapped(buf);
  const index = indexDocumentXml(await (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string"));
  for (const e of paragraphMap) {
    assert.equal(index.paragraphs[e.docxParaIndex].text, md.slice(e.mdStart, e.mdEnd), `block mapped to #${e.docxParaIndex}`);
  }
  assert.equal(paragraphMap.length, 3);
});

// Also found there: text Word holds but mammoth never writes out (the letters
// of a figure label: "lNNOVATlVT", "BLlK"). Each such paragraph took the next
// real block. Pairing is now checked by text, so a paragraph with no block of
// its own gives the block to its rightful paragraph.
test("a paragraph mammoth writes no block for does not take the next one's text", async () => {
  const { flattenLists, pairBlocksByText } = await import("../src/conversion.ts");
  void flattenLists;
  // Word: A, X (no block), B, C. Mammoth: A, B, C.
  const pairs = pairBlocksByText(["Første afsnit.", "BLlK", "Andet afsnit.", "Tredje afsnit."], ["<p>Første afsnit.</p>", "<p>Andet afsnit.</p>", "<p>Tredje afsnit.</p>"]);
  assert.deepEqual(pairs, [0, -1, 1, 2]);
  // Mammoth with an extra block Word has no paragraph for: A, extra, B.
  assert.deepEqual(pairBlocksByText(["A one.", "B two."], ["<p>A one.</p>", "<p>Ekstra.</p>", "<p>B two.</p>"]), [0, 2]);
  // A difference that is only formatting is still the same paragraph.
  assert.deepEqual(pairBlocksByText(["\tRisici & ansvar", "Næste."], ["<p>Risici &amp; <em>ansvar</em></p>", "<p>Næste.</p>"]), [0, 1]);
});
