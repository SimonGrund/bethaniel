// ── A chapter heading that starts a new page must still be mapped ──
//
// In Word, "page break before" is a paragraph PROPERTY (w:pageBreakBefore),
// and in a book it sits on the chapter heading itself — every chapter starts
// on a new page. The importer used to treat any page-break paragraph as a bare
// separator and skip it, which did two things at once: the heading got no
// entry in the paragraph map, and its HTML block was never consumed. From the
// first chapter heading onward every paragraph was then recorded against the
// PREVIOUS paragraph's docx index.
//
// Surgical export therefore found none of the text it expected, refused those
// paragraphs, and shipped a "translation" in which only the front matter —
// everything before the first page break — had actually been replaced. That is
// the customer report "only the introduction is in French"; on the real
// manuscript it was 472 refusals out of 540 paragraphs, and 369 of 419
// exported paragraphs still in English.
//
// The distinction that has to hold: a heading that breaks the page carries
// text and must be mapped; a bare <w:br type="page"/> paragraph carries none
// and must not consume an HTML block that mammoth never emitted for it.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { docxToMarkdownMapped } from "../src/conversion.ts";
import { indexDocumentXml } from "../src/docxSurgery.ts";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function para(text: string, opts: { pageBreakBefore?: boolean } = {}): string {
  const pPr = opts.pageBreakBefore ? "<w:pPr><w:pageBreakBefore/></w:pPr>" : "";
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/** A paragraph that is nothing but a page break — no visible text. */
const bareBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

async function docxOf(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip
    .folder("_rels")!
    .file(
      ".rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    );
  zip
    .folder("word")!
    .file(
      "document.xml",
      `<?xml version="1.0"?><w:document ${NS}><w:body>${body}</w:body></w:document>`,
    );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

/** Every map entry must point at the markdown for its own docx paragraph. */
async function mapAlignment(buf: Buffer) {
  const { md, paragraphMap } = await docxToMarkdownMapped(buf);
  const index = indexDocumentXml(
    (await (await JSZip.loadAsync(buf)).file("word/document.xml")?.async("string")) ??
      "",
  );
  const loose = (s: string) => s.replace(/\s+/g, " ").trim();
  const wrong: string[] = [];
  for (const e of paragraphMap) {
    const p = index.paragraphs[e.docxParaIndex];
    if (!p) continue;
    const got = loose(md.slice(e.mdStart, e.mdEnd).replace(/^#{1,6}\s+/, ""));
    if (got !== loose(p.text))
      wrong.push(
        `docxPara ${e.docxParaIndex}: map says "${got.slice(0, 40)}", docx has "${loose(p.text).slice(0, 40)}"`,
      );
  }
  return { entries: paragraphMap.length, wrong };
}

test("a heading with pageBreakBefore keeps its place in the map", async () => {
  const buf = await docxOf(
    para("Front matter, before any break.") +
      para("Chapter One", { pageBreakBefore: true }) +
      para("The first line of the first chapter.") +
      para("A second line of the first chapter.") +
      para("Chapter Two", { pageBreakBefore: true }) +
      para("The first line of the second chapter."),
  );
  const { entries, wrong } = await mapAlignment(buf);
  assert.equal(wrong.length, 0, `misaligned entries:\n  ${wrong.join("\n  ")}`);
  assert.equal(entries, 6, "every paragraph with text should be mapped");
});

test("a bare page-break paragraph is still skipped", async () => {
  // It carries no text, so mammoth emits no block for it. Letting it through
  // would consume the NEXT paragraph's block and shift the map the other way —
  // which is exactly what the first attempt at this fix did.
  const buf = await docxOf(
    para("Before the break.") + bareBreak + para("After the break."),
  );
  const { entries, wrong } = await mapAlignment(buf);
  assert.equal(wrong.length, 0, `misaligned entries:\n  ${wrong.join("\n  ")}`);
  assert.equal(entries, 2, "only the two text paragraphs should be mapped");
});

test("both kinds in one document stay aligned", async () => {
  const buf = await docxOf(
    para("Front matter.") +
      bareBreak +
      para("Chapter One", { pageBreakBefore: true }) +
      para("Body of one.") +
      bareBreak +
      para("Chapter Two", { pageBreakBefore: true }) +
      para("Body of two.") +
      para("More of two."),
  );
  const { entries, wrong } = await mapAlignment(buf);
  assert.equal(wrong.length, 0, `misaligned entries:\n  ${wrong.join("\n  ")}`);
  assert.equal(entries, 6);
});
