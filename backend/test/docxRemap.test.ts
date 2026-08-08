// The full surgical round trip: import a .docx, edit the markdown the way the
// pipeline would, map the edits back onto the original runs, and export.
//
// The point of the exercise is that the exported file is the user's own
// document with words changed — not a regenerated approximation of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";

import { docxToMarkdownMapped } from "../src/conversion.ts";
import { indexDocumentXml, rewriteDocxText } from "../src/docxSurgery.ts";
import {
  remapChaptersToParagraphEdits,
  stripMarkdown,
} from "../src/docxRemap.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SAMPLE = path.join(REPO, "sample_texts", "two_chapters_english.docx");

async function documentXmlOf(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  return (await zip.file("word/document.xml")?.async("string")) ?? "";
}

/** Import, apply a whole-document text substitution, and export surgically. */
async function roundTrip(input: Buffer, from: string, to: string) {
  const { md, paragraphMap } = await docxToMarkdownMapped(input);
  const index = indexDocumentXml(await documentXmlOf(input));
  const { edits, unmapped } = remapChaptersToParagraphEdits(
    md,
    paragraphMap,
    index,
    [{ original: md, edited: md.split(from).join(to) }],
  );
  const result = await rewriteDocxText(input, edits);
  return { ...result, edits, unmapped, md };
}

test("stripMarkdown reduces a block to the text Word would hold", () => {
  assert.equal(stripMarkdown("# Chapter One"), "Chapter One");
  assert.equal(stripMarkdown("She was ***very*** sure."), "She was very sure.");
  assert.equal(stripMarkdown("A _quiet_ **bold** word."), "A quiet bold word.");
  assert.equal(stripMarkdown("Text ![alt](media/x.png) here."), "Text  here.");
});

test("a correction reaches the real manuscript and nothing else moves", async () => {
  const input = fs.readFileSync(SAMPLE);
  const before = await documentXmlOf(input);

  const { buffer, applied, skipped, unmapped } = await roundTrip(
    input,
    "shakey",
    "shaky",
  );

  assert.ok(applied > 0, `nothing applied (skipped: ${JSON.stringify(skipped)}, unmapped: ${JSON.stringify(unmapped)})`);

  const after = await documentXmlOf(buffer);
  assert.match(after, /shaky/);

  // Undo the intended change: the document must be byte-identical.
  assert.equal(
    after.split("shaky").join("shakey"),
    before,
    "something other than the corrected word changed",
  );
});

test("paragraph structure and formatting survive the round trip", async () => {
  const input = fs.readFileSync(SAMPLE);
  const beforeIndex = indexDocumentXml(await documentXmlOf(input));
  const { buffer } = await roundTrip(input, "shakey", "shaky");
  const afterIndex = indexDocumentXml(await documentXmlOf(buffer));

  assert.equal(afterIndex.paragraphs.length, beforeIndex.paragraphs.length);

  // Every run-properties block present before must still be present.
  const before = await documentXmlOf(input);
  const after = await documentXmlOf(buffer);
  const rPrs = before.match(/<w:rPr>[\s\S]*?<\/w:rPr>/g) ?? [];
  for (const rPr of new Set(rPrs)) {
    assert.ok(after.includes(rPr), `lost run properties: ${rPr.slice(0, 70)}`);
  }
});

test("re-importing the exported file yields the corrected text", async () => {
  const input = fs.readFileSync(SAMPLE);
  const { buffer } = await roundTrip(input, "shakey", "shaky");
  const { md } = await docxToMarkdownMapped(buffer);
  assert.match(md, /shaky/);
  assert.doesNotMatch(md, /shakey/);
});

test("an unchanged chapter produces no edits at all", async () => {
  const input = fs.readFileSync(SAMPLE);
  const { md, paragraphMap } = await docxToMarkdownMapped(input);
  const index = indexDocumentXml(await documentXmlOf(input));
  const { edits } = remapChaptersToParagraphEdits(md, paragraphMap, index, [
    { original: md, edited: md },
  ]);
  assert.equal(edits.length, 0);
});

test("a chapter that cannot be located is reported, not guessed at", async () => {
  const input = fs.readFileSync(SAMPLE);
  const { md, paragraphMap } = await docxToMarkdownMapped(input);
  const index = indexDocumentXml(await documentXmlOf(input));
  const { edits, unmapped } = remapChaptersToParagraphEdits(
    md,
    paragraphMap,
    index,
    [{ original: "text that is not in this manuscript", edited: "anything" }],
  );
  assert.equal(edits.length, 0);
  assert.equal(unmapped[0]?.reason, "chapter-not-found");
});

test("several corrections in one document all land", async () => {
  const input = fs.readFileSync(SAMPLE);
  const { md, paragraphMap } = await docxToMarkdownMapped(input);
  const index = indexDocumentXml(await documentXmlOf(input));

  const edited = md
    .split("shakey")
    .join("shaky")
    .split("writen")
    .join("written");

  const { edits } = remapChaptersToParagraphEdits(md, paragraphMap, index, [
    { original: md, edited },
  ]);
  const { buffer, applied } = await rewriteDocxText(input, edits);
  assert.ok(applied >= 2, `expected both corrections, applied ${applied}`);

  const after = await documentXmlOf(buffer);
  assert.match(after, /shaky/);
  assert.match(after, /written/);
});
