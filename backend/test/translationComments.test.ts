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

// ── A partial translation exports only what was translated ──

test("only the translated chapters' paragraphs remain; the page setup stays", async () => {
  const body =
    p(r("Kapitel 1 overskrift")) + p(r("Et afsnit i kapitel et.")) +
    `<w:tbl><w:tr><w:tc>${p(r("En tabel i kapitel et."))}</w:tc></w:tr></w:tbl>` +
    p(r("Kapitel 2 overskrift")) + p(r("Et afsnit i kapitel to.")) +
    p(r("Kapitel 3 overskrift")) + p(r("Et afsnit i kapitel tre.")) +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`;
  const input = await docx(body);
  const out = await rewriteDocxText(
    input,
    [
      { paragraphIndex: 3, start: 0, end: "Kapitel 2 overskrift".length, replacement: "Chapter 2 heading", wholeParagraph: true },
      { paragraphIndex: 4, start: 0, end: "Et afsnit i kapitel to.".length, replacement: "A paragraph in chapter two.", wholeParagraph: true },
    ],
    { doubtComments: true, keepParagraphs: [[3, 4]] },
  );
  const { doc } = await parts(out.buffer);
  assert.deepEqual(texts(doc), ["Chapter 2 heading", "A paragraph in chapter two."]);
  assert.doesNotMatch(doc, /<w:tbl>/, "a table outside the scope goes too");
  assert.match(doc, /<w:sectPr><w:pgSz/);
});

test("the remap reports which paragraphs each translated chapter covers", () => {
  const md = "# Et\n\nAfsnit et.\n\n# To\n\nAfsnit to.";
  const index = { xml: "", paragraphs: ["Et", "Afsnit et.", "To", "Afsnit to."].map((text, i) => ({ index: i, depth: 0, inTable: false, isEmpty: false, isPageBreak: false, hasObject: false, sawTextElement: true, text, nodes: [{ kind: "t", text, textStart: 0, rPrXml: "", runIndex: 0, xmlStart: 0, xmlEnd: 0, openTagEnd: 0, preserve: false }] })) } as never;
  const blocks = md.split("\n\n");
  let from = 0;
  const map = blocks.map((b, i) => { const at = md.indexOf(b, from); from = at + b.length; return { docxParaIndex: i, mdStart: at, mdEnd: at + b.length, mappable: true }; });
  const chapter = "# To\n\nAfsnit to.";
  const { scope } = remapChaptersToParagraphEdits(md, map, index, [{ original: chapter, edited: "# Two\n\nParagraph two." }], { wholeParagraphs: true });
  assert.deepEqual(scope, [[2, 3]]);
});

test("chapters separated only by empty paragraphs export as one stretch, page breaks and all", () => {
  const md = "# Et\n\nAfsnit et.\n\n# To\n\nAfsnit to.";
  const texts5 = ["Et", "Afsnit et.", "", "", "To", "Afsnit to."];
  const index = { xml: "", paragraphs: texts5.map((text, i) => ({ index: i, depth: 0, inTable: false, isEmpty: text === "", isPageBreak: false, hasObject: false, sawTextElement: true, text, nodes: text ? [{ kind: "t", text, textStart: 0, rPrXml: "", runIndex: 0, xmlStart: 0, xmlEnd: 0, openTagEnd: 0, preserve: false }] : [] })) } as never;
  const at = (b: string) => md.indexOf(b);
  const map = [["# Et", 0], ["Afsnit et.", 1], ["# To", 4], ["Afsnit to.", 5]].map(([b, i]) => ({ docxParaIndex: i as number, mdStart: at(b as string), mdEnd: at(b as string) + (b as string).length, mappable: true }));
  const { scope } = remapChaptersToParagraphEdits(md, map, index, [
    { original: "# Et\n\nAfsnit et.", edited: "# One\n\nParagraph one." },
    { original: "# To\n\nAfsnit to.", edited: "# Two\n\nParagraph two." },
  ], { wholeParagraphs: true });
  assert.deepEqual(scope, [[0, 5]]);
});

test("a paragraph inside the chapter that Betty never saw gets a comment, not silence", () => {
  const md = "# Et\n\nAfsnit et.";
  const texts3 = ["Et", "Indhold linje kun i Word", "Afsnit et."];
  const index = { xml: "", paragraphs: texts3.map((text, i) => ({ index: i, depth: 0, inTable: false, isEmpty: false, isPageBreak: false, hasObject: false, sawTextElement: true, text, nodes: [{ kind: "t", text, textStart: 0, rPrXml: "", runIndex: 0, xmlStart: 0, xmlEnd: 0, openTagEnd: 0, preserve: false }] })) } as never;
  const map = [{ docxParaIndex: 0, mdStart: 0, mdEnd: 4, mappable: true }, { docxParaIndex: 2, mdStart: 6, mdEnd: 16, mappable: true }];
  const { notes } = remapChaptersToParagraphEdits(md, map, index, [{ original: md, edited: "# One\n\nParagraph one." }], { wholeParagraphs: true });
  assert.equal(notes.length, 1);
  assert.equal(notes[0].paragraphIndex, 1);
  assert.match(notes[0].text, /no translation/i);
});

// ── Edits too: the export is the chapters that were worked on ──

test("a tracked-changes export of some chapters holds only those chapters", async () => {
  const { rewriteDocxTracked } = await import("../src/docxTracked.ts");
  const body = p(r("Kapitel et.")) + p(r("Kapitel to har en fejjl.")) + p(r("Kapitel tre.")) + `<w:sectPr/>`;
  const out = await rewriteDocxTracked(
    await docx(body),
    [{ paragraphIndex: 1, start: 17, end: 22, replacement: "fejl" }],
    { author: "Betty", initials: "B", date: "2026-10-09T00:00:00Z", keepParagraphs: [[1, 1]] },
  );
  const { doc } = await parts(out.buffer);
  assert.equal(indexDocumentXml(doc).paragraphs.length, 1);
  assert.match(doc, /<w:ins /);
  assert.match(doc, /<w:sectPr\/>/);
});

test("an export of the whole book is not trimmed, even past the last mapped paragraph", () => {
  const md = "# Et\n\nAfsnit et.";
  const texts4 = ["Et", "Afsnit et.", "Kolofon kun i Word", ""];
  const index = { xml: "", paragraphs: texts4.map((text, i) => ({ index: i, depth: 0, inTable: false, isEmpty: !text, isPageBreak: false, hasObject: false, sawTextElement: true, text, nodes: text ? [{ kind: "t", text, textStart: 0, rPrXml: "", runIndex: 0, xmlStart: 0, xmlEnd: 0, openTagEnd: 0, preserve: false }] : [] })) } as never;
  const map = [{ docxParaIndex: 0, mdStart: 0, mdEnd: 4, mappable: true }, { docxParaIndex: 1, mdStart: 6, mdEnd: 16, mappable: true }];
  const whole = remapChaptersToParagraphEdits(md, map, index, [{ original: md, edited: "# Et\n\nAfsnit 1." }]);
  assert.equal(whole.partial, false);
  const md2 = "# Et\n\nAfsnit et.\n\n# To\n\nAfsnit to.";
  const map2 = [...map, { docxParaIndex: 2, mdStart: 18, mdEnd: 22, mappable: true }];
  const part = remapChaptersToParagraphEdits(md2, map2, index, [{ original: md, edited: "# Et\n\nAfsnit 1." }]);
  assert.equal(part.partial, true);
});

// Found on the full book: a table's cells ("Den trygge gruppe", "Kritik
// opleves som engagement") are marked not mappable on import, and the export
// never wrote into them — a translated book with its tables in Danish. A cell
// paragraph is verified against Word's text like any other, so a
// translation writes into it.
test("a translation writes into table cells too", async () => {
  const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const input = await docx(`<w:tbl><w:tr>${cell("Den trygge gruppe")}${cell("Kritik opleves som engagement")}</w:tr></w:tbl>`);
  const index = indexDocumentXml((await parts(input)).doc);
  const md = "Den trygge gruppe\n\nKritik opleves som engagement";
  const map = [
    { docxParaIndex: 0, mdStart: 0, mdEnd: 17, mappable: false },
    { docxParaIndex: 1, mdStart: 19, mdEnd: md.length, mappable: false },
  ];
  const { edits, unmapped } = remapChaptersToParagraphEdits(md, map, index, [
    { original: md, edited: "The safe group\n\nCriticism is experienced as engagement" },
  ], { wholeParagraphs: true });
  assert.deepEqual(unmapped, []);
  const out = await rewriteDocxText(input, edits, { doubtComments: true });
  assert.deepEqual(texts((await parts(out.buffer)).doc), ["The safe group", "Criticism is experienced as engagement"]);
});

// Found on the full book: where the translation's italics were put back in the
// author's own runs, an image's markdown reached the text —
// "![…](media/…/image10.png)We have — as many philosophers…".
test("an image or link in a translated paragraph never reaches its text", async () => {
  const i = "<w:i/>";
  const input = await docx(p(`${r("Vi har ")}${r("et valg", i)}${r(", som filosoffer har peget på.")}`));
  const index = indexDocumentXml((await parts(input)).doc);
  const md = "Vi har _et valg_, som filosoffer har peget på.";
  const { edits } = remapChaptersToParagraphEdits(md, [{ docxParaIndex: 0, mdStart: 0, mdEnd: md.length, mappable: true }], index, [
    { original: md, edited: "![A drawing](media/x/image10.png)We have _a choice_, as [philosophers](https://example.org) have pointed out." },
  ], { wholeParagraphs: true });
  const out = await rewriteDocxText(input, edits, { doubtComments: true });
  const [text] = texts((await parts(out.buffer)).doc);
  assert.equal(text, "We have a choice, as philosophers have pointed out.");
});
