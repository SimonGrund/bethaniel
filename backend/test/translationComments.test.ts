// ── A translation is always complete; doubts are Word comments ──
//
// Before: a paragraph the export could not place exactly, or whose layout
// (a tab, a line break) or emphasis could not be carried over, stayed in the
// source language, and the author learnt of it from a warning and a separate
// notes file. Now every paragraph gets its translation, and where Betty is
// unsure she says so in a comment on that paragraph, in Word's own margin.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { indexDocumentXml, rewriteDocxText } from "../src/docxSurgery.ts";
import { remapChaptersToParagraphEdits } from "../src/docxRemap.ts";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (runs: string) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>${runs}</w:p>`;
const r = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

async function docx(body: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
async function parts(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  return {
    doc: (await zip.file("word/document.xml")!.async("string")),
    comments: (await zip.file("word/comments.xml")?.async("string")) ?? "",
  };
}
const texts = (xml: string) => indexDocumentXml(xml).paragraphs.map((x) => x.text);

test("a paragraph with a line break is translated, with a comment about its layout", async () => {
  const input = await docx(p(`${r("Første linje")}<w:r><w:br/></w:r>${r("anden linje")}`));
  const out = await rewriteDocxText(
    input,
    [{ paragraphIndex: 0, start: 0, end: "Første linje\nanden linje".length, replacement: "First line second line", wholeParagraph: true }],
    { doubtComments: true },
  );
  assert.equal(out.skipped.length, 0);
  const { doc, comments } = await parts(out.buffer);
  assert.match(texts(doc)[0], /First line second line/);
  assert.match(comments, /line break|layout/i);
  assert.match(doc, /<w:commentRangeStart w:id="\d+"\/>/);
  assert.match(doc, /<w:commentReference w:id="\d+"\/>/);
});

test("emphasis that cannot be placed is named in a comment on its paragraph", async () => {
  const input = await docx(p(`${r("Hun læste ")}${r("Den afrikanske farm", "<w:i/>")}${r(" igen og igen.")}`));
  const out = await rewriteDocxText(
    input,
    [{ paragraphIndex: 0, start: 0, end: "Hun læste Den afrikanske farm igen og igen.".length, replacement: "She read Out of Africa again and again.", wholeParagraph: true }],
    { doubtComments: true },
  );
  const { doc, comments } = await parts(out.buffer);
  assert.equal(texts(doc)[0], "She read Out of Africa again and again.");
  assert.match(comments, /Den afrikanske farm/);
  assert.equal(out.comments, 1);
});

test("a paragraph whose place cannot be found keeps its translation in a comment", async () => {
  const input = await docx(p(r("Et afsnit i Word.")) + p(r("Endnu et afsnit i Word.")));
  const index = indexDocumentXml((await parts(input)).doc);
  const md = "Et helt andet afsnit som ikke står i Word.";
  const { edits, unmapped, notes } = remapChaptersToParagraphEdits(
    md,
    [{ docxParaIndex: 0, mdStart: 0, mdEnd: md.length, mappable: true }],
    index,
    [{ original: md, edited: "A completely different paragraph that is not in Word." }],
    { wholeParagraphs: true },
  );
  assert.equal(edits.length, 0);
  assert.deepEqual(unmapped, [], "nothing is left out silently");
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /A completely different paragraph that is not in Word\./);
  const out = await rewriteDocxText(input, edits, { doubtComments: true, comments: notes });
  assert.match((await parts(out.buffer)).comments, /A completely different paragraph/);
});

test("a correction (not a translation) still refuses rather than guesses", async () => {
  const input = await docx(p(`${r("Første linje")}<w:r><w:br/></w:r>${r("anden linje")}`));
  const out = await rewriteDocxText(input, [{ paragraphIndex: 0, start: 10, end: 14, replacement: "X" }]);
  assert.equal(out.skipped.length, 1);
});

test("an emphasised title split into runs is named as one phrase", async () => {
  const i = "<w:i/>";
  const input = await docx(p(`${r("Bogen ")}${r("Kom", i)}${r(" ")}${r("på", i)}${r(" ")}${r("benene", i)}${r(" ")}${r("igen", i)}${r(" udkom i 2009.")}`));
  const out = await rewriteDocxText(
    input,
    [{ paragraphIndex: 0, start: 0, end: "Bogen Kom på benene igen udkom i 2009.".length, replacement: "The book Back on Your Feet came out in 2009.", wholeParagraph: true }],
    { doubtComments: true },
  );
  const { comments } = await parts(out.buffer);
  assert.match(comments, /“Kom på benene igen” was emphasised/);
});
