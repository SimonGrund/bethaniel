// ── The translation's emphasis reaches the author's own italic run ──
//
// Not a generic <w:i/>: the emphasised text is put into the run that was
// already emphasised, so it keeps the author's font, size and highlight. That
// is why this needs no new XML — the run is already there, and was only being
// blanked.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { indexDocumentXml, rewriteDocxText } from "../src/docxSurgery.ts";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/** A paragraph of three runs: base, italic, base. */
const PARA =
  "<w:p>" +
  '<w:r><w:t xml:space="preserve">I will be honest: </w:t></w:r>' +
  '<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">love multiplies</w:t></w:r>' +
  '<w:r><w:t xml:space="preserve">.</w:t></w:r>' +
  "</w:p>";

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

async function xmlOf(buf: Buffer): Promise<string> {
  return (
    (await (await JSZip.loadAsync(buf)).file("word/document.xml")?.async("string")) ??
    ""
  );
}

const WHOLE = {
  paragraphIndex: 0,
  start: 0,
  end: "I will be honest: love multiplies.".length,
  wholeParagraph: true,
};

test("with an allocation, each run receives its own translated text", async () => {
  const input = await docxOf(PARA);
  const { buffer, restored, flattened } = await rewriteDocxText(input, [
    {
      ...WHOLE,
      replacement: "Je serai honnête : l'amour se multiplie.",
      segments: ["Je serai honnête : ", "l'amour se multiplie", "."],
    },
  ]);
  const xml = await xmlOf(buffer);
  // The emphasised French sits inside the run that carries <w:i/>.
  assert.match(xml, /<w:rPr><w:i\/><\/w:rPr><w:t[^>]*>l'amour se multiplie<\/w:t>/);
  assert.match(xml, /Je serai honnête/);
  assert.equal(restored, 1);
  assert.equal(flattened, 0, "a restored paragraph must not also count as lost");
});

test("the italic run still exists and is still italic", async () => {
  // The point of reusing the run rather than creating one: no new XML, and the
  // author's own styling survives.
  const input = await docxOf(PARA);
  const { buffer } = await rewriteDocxText(input, [
    { ...WHOLE, replacement: "a b c", segments: ["a ", "b", " c"] },
  ]);
  const out = indexDocumentXml(await xmlOf(buffer));
  const p = out.paragraphs[0];
  const fmts = new Set(
    p.nodes.filter((n) => n.kind !== "virtual").map((n) => n.rPrXml),
  );
  assert.equal(fmts.size, 2, "the paragraph lost its second formatting");
  assert.equal(p.text, "a b c");
});

test("without an allocation the paragraph is flattened exactly as before", async () => {
  const input = await docxOf(PARA);
  const { buffer, restored, flattened, flattenedDetail } = await rewriteDocxText(
    input,
    [{ ...WHOLE, replacement: "tout dans le premier run" }],
  );
  const out = indexDocumentXml(await xmlOf(buffer));
  assert.equal(out.paragraphs[0].text, "tout dans le premier run");
  assert.equal(restored, 0);
  assert.equal(flattened, 1);
  assert.equal(flattenedDetail.length, 1);
  assert.deepEqual(flattenedDetail[0].emphasised, ["love multiplies"]);
});

test("a wrong-length allocation is refused, not partly applied", async () => {
  // Defensive: docxRemap should never emit this, but a half-applied paragraph
  // would put translated text in the wrong run — the one outcome worse than
  // losing the emphasis.
  const input = await docxOf(PARA);
  const { buffer, restored, flattened } = await rewriteDocxText(input, [
    { ...WHOLE, replacement: "fallback text", segments: ["only", "two"] },
  ]);
  const out = indexDocumentXml(await xmlOf(buffer));
  assert.equal(out.paragraphs[0].text, "fallback text");
  assert.equal(restored, 0);
  assert.equal(flattened, 1);
});

test("an ordinary correction is untouched by any of this", async () => {
  // No wholeParagraph, no segments: the existing path, unchanged.
  const input = await docxOf(PARA);
  const { buffer, restored } = await rewriteDocxText(input, [
    { paragraphIndex: 0, start: 0, end: 6, replacement: "I shall" },
  ]);
  const out = indexDocumentXml(await xmlOf(buffer));
  assert.match(out.paragraphs[0].text, /^I shall/);
  assert.equal(restored, 0);
});

test("a shared trailing full stop does not cost the paragraph its emphasis", () => {
  // Regression. trimEdit shrinks an edit to the span that actually changed,
  // which is right for a correction and wrong here: the original and the
  // translation both end in ".", so trimming dropped the last run out of the
  // touched set, leaving two segments against three allocated parts — and the
  // paragraph was refused for a difference that was not real.
  //
  // Asserted through the public result rather than by inspecting trimEdit:
  // what matters is that the emphasis survives, however the trimming is done.
  return (async () => {
    const input = await docxOf(PARA);
    const { buffer, restored } = await rewriteDocxText(input, [
      {
        ...WHOLE,
        replacement: "Je serai honnête : l'amour se multiplie.",
        segments: ["Je serai honnête : ", "l'amour se multiplie", "."],
      },
    ]);
    assert.equal(restored, 1, "a shared suffix refused the allocation");
    const xml = await xmlOf(buffer);
    assert.match(xml, /<w:i\/><\/w:rPr><w:t[^>]*>l'amour se multiplie</);
  })();
});

test("a bold lead-in is reported as the lost emphasis, not the rest of the paragraph", async () => {
  // Measured on a real manuscript: a definition paragraph opens with its term
  // in bold, so the bold run comes FIRST. Reading the first run as the base
  // reported the whole remaining paragraph as the emphasis that was lost —
  // backwards, and it filled the formatting notes with entries quoting a
  // paragraph each. The base is the formatting covering the most text.
  const input = await docxOf(
    "<w:p>" +
      '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Monogamish</w:t></w:r>' +
      '<w:r><w:t xml:space="preserve"> relationships allow limited flexibility.</w:t></w:r>' +
      "</w:p>",
  );
  const { flattenedDetail } = await rewriteDocxText(input, [
    {
      paragraphIndex: 0,
      start: 0,
      end: "Monogamish relationships allow limited flexibility.".length,
      wholeParagraph: true,
      replacement: "Les relations monogamish admettent une souplesse limitée.",
    },
  ]);
  assert.deepEqual(flattenedDetail[0].emphasised, ["Monogamish"]);
});
