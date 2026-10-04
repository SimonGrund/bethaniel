// Tracked-changes export: the edits arrive in Word as Betty's revisions.
//
// The assertions that matter most are the two round trips. Accepting every
// revision must give exactly the text the clean export writes, and rejecting
// every one must give back the author's original — otherwise the file is not
// a faithful proposal of the edit. Everything else (well-formed XML, the
// comments part wired into the package) is what lets Word open it at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import mammoth from "mammoth";
import { DOMParser } from "@xmldom/xmldom";

import {
  planTrackedEdits,
  rewriteDocxTracked,
  widenToWords,
  type TrackedEdit,
} from "../src/docxTracked.ts";
import { indexDocumentXml } from "../src/docxSurgery.ts";

const OPTS = { author: "Betty", initials: "B", date: "2026-10-04T12:00:00Z" };
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const GARAMOND = '<w:rPr><w:rFonts w:ascii="Garamond"/><w:sz w:val="26"/></w:rPr>';

async function docx(body: string, extra: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
  );
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function part(buf: Buffer, name: string): Promise<string | undefined> {
  return (await JSZip.loadAsync(buf)).file(name)?.async("string");
}

/** Parse strictly: any XML error fails the test. */
function wellFormed(xml: string): void {
  const errors: string[] = [];
  new DOMParser({
    onError: (level: string, msg: string) => {
      if (level !== "warning") errors.push(msg);
    },
  }).parseFromString(xml, "text/xml");
  assert.deepEqual(errors, [], "XML must be well-formed");
}

async function textOf(buf: Buffer): Promise<string> {
  return (await mammoth.extractRawText({ buffer: buf })).value.trim();
}

/** The document as Word shows it after Reject All. */
async function rejectAll(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const xml = (await zip.file("word/document.xml")!.async("string"))
    .replace(/<w:ins [^>]*>[\s\S]*?<\/w:ins>/g, "")
    .replace(/<w:del [^>]*>([\s\S]*?)<\/w:del>/g, "$1")
    .replace(/<w:delText/g, "<w:t")
    .replace(/<\/w:delText>/g, "</w:t>");
  zip.file("word/document.xml", xml);
  return textOf(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })));
}

const para = (text: string, rPr = GARAMOND) =>
  `<w:p><w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function track(body: string, edits: TrackedEdit[], extra?: Record<string, string>) {
  const input = await docx(body, extra);
  const res = await rewriteDocxTracked(input, edits, OPTS);
  const xml = (await part(res.buffer, "word/document.xml"))!;
  return { input, res, xml };
}

// ── Widening ──

test("a misspelling is marked as the whole word, not one letter", () => {
  // diffChars makes "sudenly" → "suddenly" an inserted "d".
  const text = "He sudenly left.";
  assert.deepEqual(widenToWords(text, [{ start: 6, end: 6, replacement: "d" }]), [
    { start: 3, end: 10, replacement: "suddenly" },
  ]);
});

test("a comma added after a word stays an inserted comma", () => {
  const text = "Well I never.";
  assert.deepEqual(widenToWords(text, [{ start: 4, end: 4, replacement: "," }]), [
    { start: 4, end: 4, replacement: "," },
  ]);
});

test("two fixes in one word become one revision", () => {
  // "recieve" → "receive": diffChars deletes the "i" and inserts one after
  // the "e", two edits in one word.
  const text = "to recieve it";
  const out = widenToWords(text, [
    { start: 6, end: 7, replacement: "" },
    { start: 8, end: 8, replacement: "i" },
  ]);
  assert.deepEqual(out, [{ start: 3, end: 10, replacement: "receive" }]);
});

test("a whole-paragraph replacement is left alone", () => {
  const e = { start: 0, end: 5, replacement: "Bonjour", wholeParagraph: true };
  assert.deepEqual(widenToWords("Hello", [e]), [e]);
});

// ── Notes ──

test("an edit takes the note of the suggestion whose words it sits in", () => {
  const text = "He sudenly left the the room.";
  const out = planTrackedEdits(
    [
      { paragraphIndex: 0, chapterIndex: 0, start: 6, end: 6, replacement: "d" },
      { paragraphIndex: 0, chapterIndex: 0, start: 16, end: 20, replacement: "" },
    ],
    () => text,
    [[
      { original: "sudenly", text: "Spelling." },
      { original: "the the", text: "Doubled word." },
    ]],
  );
  assert.equal(out[0].note?.text, "Spelling.");
  assert.equal(out[1].note?.text, "Doubled word.");
});

test("where two suggestions overlap, the later one's note wins", () => {
  const text = "She walked slow to the door.";
  const out = planTrackedEdits(
    [{ paragraphIndex: 0, chapterIndex: 0, start: 11, end: 15, replacement: "slowly" }],
    () => text,
    [[
      { original: "slow", text: "Adverb." },
      { original: "walked slow to the door", text: "Smoother." },
    ]],
  );
  assert.equal(out[0].note?.text, "Smoother.");
});

test("notes are matched within their own chapter only", () => {
  const out = planTrackedEdits(
    [{ paragraphIndex: 3, chapterIndex: 1, start: 0, end: 4, replacement: "That" }],
    () => "This is it.",
    [[{ original: "This", text: "From chapter one." }], []],
  );
  assert.equal(out[0].note, undefined);
});

// ── The document ──

test("an edit becomes Betty's deletion and insertion, in the run's own formatting", async () => {
  const { res, xml } = await track(para("The shakey hand."), [
    { paragraphIndex: 0, start: 4, end: 10, replacement: "shaky" },
  ]);
  wellFormed(xml);
  assert.equal(res.applied, 1);
  assert.match(xml, /<w:del w:id="\d+" w:author="Betty" w:date="2026-10-04T12:00:00Z">/);
  assert.ok(xml.includes(`<w:r>${GARAMOND}<w:delText xml:space="preserve">shakey</w:delText>`));
  assert.ok(xml.includes(`<w:r>${GARAMOND}<w:t xml:space="preserve">shaky</w:t></w:r></w:ins>`));
});

test("accepting every revision gives the corrected text; rejecting gives the original", async () => {
  const { input, res } = await track(
    para("He sudenly left the the room, and I never knew.") + para("A second paragraph stays."),
    planTrackedEdits(
      [
        { paragraphIndex: 0, chapterIndex: 0, start: 6, end: 6, replacement: "d" },
        { paragraphIndex: 0, chapterIndex: 0, start: 16, end: 20, replacement: "" },
        { paragraphIndex: 0, chapterIndex: 0, start: 33, end: 33, replacement: "," },
      ],
      (i) => indexDocumentXml(
        `<w:document xmlns:w="${W}"><w:body>${para("He sudenly left the the room, and I never knew.")}</w:body></w:document>`,
      ).paragraphs[i]?.text,
    ),
  );
  assert.equal(res.skipped.length, 0);
  assert.equal(
    await textOf(res.buffer),
    "He suddenly left the room, and, I never knew.\n\nA second paragraph stays.",
  );
  assert.equal(await rejectAll(res.buffer), await textOf(input));
});

test("a comment is added, anchored on its change, and wired into the package", async () => {
  const { res, xml } = await track(para("The shakey hand."), [
    {
      paragraphIndex: 0,
      start: 4,
      end: 10,
      replacement: "shaky",
      note: { key: "k", text: "Betty (90% sure): spelling.\nCommon misspelling." },
    },
  ]);
  assert.equal(res.comments, 1);
  const comments = (await part(res.buffer, "word/comments.xml"))!;
  wellFormed(comments);
  wellFormed(xml);
  const id = comments.match(/<w:comment w:id="(\d+)"/)![1];
  assert.ok(xml.includes(`<w:commentRangeStart w:id="${id}"/>`));
  assert.ok(xml.includes(`<w:commentRangeEnd w:id="${id}"/>`));
  assert.ok(xml.includes(`<w:commentReference w:id="${id}"/>`));
  // The range opens before the deletion and closes after the insertion.
  assert.ok(xml.indexOf(`commentRangeStart w:id="${id}"`) < xml.indexOf("<w:del "));
  assert.ok(xml.indexOf(`commentRangeEnd w:id="${id}"`) > xml.indexOf("</w:ins>"));
  // Two lines of note, two comment paragraphs.
  assert.equal(comments.match(/<w:p>/g)?.length, 2);
  assert.ok(comments.includes("Common misspelling."));
  // No revision shares the comment's id.
  assert.ok(!new RegExp(`<w:(ins|del) w:id="${id}"`).test(xml));

  const types = (await part(res.buffer, "[Content_Types].xml"))!;
  assert.ok(types.includes('PartName="/word/comments.xml"'));
  const rels = (await part(res.buffer, "word/_rels/document.xml.rels"))!;
  assert.match(rels, /relationships\/comments" Target="comments.xml"/);
});

test("comments are appended to a document that already has some, with fresh ids", async () => {
  const existing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments xmlns:w="${W}"><w:comment w:id="7" w:author="Editor"><w:p><w:r><w:t>Mine.</w:t></w:r></w:p></w:comment></w:comments>`;
  const { res } = await track(
    para("The shakey hand."),
    [{ paragraphIndex: 0, start: 4, end: 10, replacement: "shaky", note: { key: "k", text: "Spelling." } }],
    { "word/comments.xml": existing },
  );
  const comments = (await part(res.buffer, "word/comments.xml"))!;
  wellFormed(comments);
  assert.ok(comments.includes("Mine."));
  const ids = [...comments.matchAll(/<w:comment w:id="(\d+)"/g)].map((m) => Number(m[1]));
  assert.equal(ids.length, 2);
  assert.ok(ids[1] > 7);
});

test("text inside a tracked change the author already has is left alone", async () => {
  const body = `<w:p><w:ins w:id="1" w:author="Author"><w:r><w:t>The shakey hand.</w:t></w:r></w:ins></w:p>`;
  const { res, xml } = await track(body, [
    { paragraphIndex: 0, start: 4, end: 10, replacement: "shaky" },
  ]);
  assert.equal(res.applied, 0);
  assert.equal(res.skipped[0]?.reason, "tracked-region");
  assert.ok(!xml.includes('w:author="Betty"'));
});

test("a change across differing formatting is refused, as the clean export refuses it", async () => {
  const body =
    `<w:p><w:r><w:t xml:space="preserve">The sha</w:t></w:r>` +
    `<w:r><w:rPr><w:i/></w:rPr><w:t>key hand.</w:t></w:r></w:p>`;
  const { res } = await track(body, [{ paragraphIndex: 0, start: 4, end: 10, replacement: "shaky" }]);
  assert.equal(res.applied, 0);
  assert.equal(res.skipped[0]?.reason, "mixed-formatting");
});

test("a change across runs of the same formatting is one revision", async () => {
  // Word splits runs for its own bookkeeping (rsids); the formatting is equal.
  const body =
    `<w:p><w:r>${GARAMOND}<w:t xml:space="preserve">The sha</w:t></w:r>` +
    `<w:r>${GARAMOND}<w:t xml:space="preserve">key hand.</w:t></w:r></w:p>`;
  const { input, res, xml } = await track(body, [
    { paragraphIndex: 0, start: 4, end: 10, replacement: "shaky" },
  ]);
  wellFormed(xml);
  assert.equal(res.applied, 1);
  assert.equal(xml.match(/<w:ins /g)?.length, 1);
  assert.equal(await textOf(res.buffer), "The shaky hand.");
  assert.equal(await rejectAll(res.buffer), await textOf(input));
});

test("special characters in text and notes are escaped", async () => {
  const { res, xml } = await track(para("Fish &amp; chips &lt;3"), [
    {
      paragraphIndex: 0,
      start: 5,
      end: 6,
      replacement: "and",
      note: { key: "k", text: 'Spell out "&" in prose <always>.' },
    },
  ]);
  wellFormed(xml);
  wellFormed((await part(res.buffer, "word/comments.xml"))!);
  assert.equal(await textOf(res.buffer), "Fish and chips <3");
});

// ── A manuscript with no original .docx ──

test("a Markdown manuscript gets a generated document with the changes tracked", async () => {
  const { markdownToDocx } = await import("../src/conversion.ts");
  const { mapMarkdownOntoDocx, remapChaptersToParagraphEdits } = await import("../src/docxRemap.ts");
  const md =
    "# Chapter One\n\nHe sudenly left the room.\n\nShe stayed, *quietly*, by the the window.\n\n* * *\n\nThe end came at dawn.";
  const edited =
    "# Chapter One\n\nHe suddenly left the room.\n\nShe stayed, *quietly*, by the window.\n\n* * *\n\nThe end came at dawn.";
  const base = await markdownToDocx(md, {});
  const xml = (await part(base, "word/document.xml"))!;
  const index = indexDocumentXml(xml);
  const { edits, unmapped } = remapChaptersToParagraphEdits(
    md,
    mapMarkdownOntoDocx(md, index),
    index,
    [{ original: md, edited }],
  );
  assert.deepEqual(unmapped, []);
  const res = await rewriteDocxTracked(
    base,
    planTrackedEdits(edits, (i) => index.paragraphs[i]?.text, [[
      { original: "sudenly", text: "Spelling." },
      { original: "the the", text: "Doubled word." },
    ]]),
    OPTS,
  );
  assert.equal(res.skipped.length, 0);
  assert.equal(res.applied, 2);
  assert.equal(res.comments, 2);
  wellFormed((await part(res.buffer, "word/document.xml"))!);
  const accepted = await textOf(res.buffer);
  assert.ok(accepted.includes("He suddenly left the room."), accepted);
  assert.ok(accepted.includes("by the window."), accepted);
  assert.equal(await rejectAll(res.buffer), await textOf(base));
});

test("the last paragraph of a manuscript ending in a newline is not dropped", async () => {
  // Found on a real run: the last block's span took the trailing "\n", ran
  // past the chapter's end, and its changes were skipped without a report.
  const { markdownToDocx } = await import("../src/conversion.ts");
  const { mapMarkdownOntoDocx, remapChaptersToParagraphEdits } = await import("../src/docxRemap.ts");
  const md = "First paragraph.\n\nShe began antering the figures.\n";
  const chapter = md.trimEnd();
  const base = await markdownToDocx(md, {});
  const index = indexDocumentXml((await part(base, "word/document.xml"))!);
  const { edits, unmapped } = remapChaptersToParagraphEdits(
    md,
    mapMarkdownOntoDocx(md, index),
    index,
    [{ original: chapter, edited: chapter.replace("antering", "entering") }],
  );
  assert.deepEqual(unmapped, []);
  assert.equal(edits.length, 1);
});

test("a note is not matched inside a longer word", () => {
  // Found on a real run: the comment for "apear" → "spear" also landed on the
  // separate fix to "apeared".
  const text = "It apeared to apear.";
  const out = planTrackedEdits(
    [
      { paragraphIndex: 0, chapterIndex: 0, start: 3, end: 10, replacement: "appeared" },
      { paragraphIndex: 0, chapterIndex: 0, start: 14, end: 19, replacement: "spear" },
    ],
    () => text,
    [[
      { original: "apeared", text: "Spelling of appeared." },
      { original: "apear", text: "Spear?" },
    ]],
  );
  assert.equal(out[0].note?.text, "Spelling of appeared.");
  assert.equal(out[1].note?.text, "Spear?");
});
