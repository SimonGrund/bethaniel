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

import { docxToMarkdownMapped, markdownToDocx } from "../src/conversion.ts";
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

// ── Translation-shaped remaps ──────────────────────────────────────────────
// A translation replaces every word, which is the worst case for the diff the
// offset map is built from: nothing matches, so Myers runs at its O(n·d) worst
// and a chapter-sized call costs seconds. Exported for real books that is
// minutes of a blocked backend, which is what "the download takes forever"
// was. These pin both halves: the paragraph counterparts still line up, and
// the work stays proportional to the text.

/** A chapter of `paras` paragraphs, and its translation — no shared words. */
function translatedChapter(paras: number): { original: string; edited: string } {
  const en =
    "the ferry stopped running in october and by november the river had frozen hard enough to walk on for thirty one years she had never once crossed it".split(
      " ",
    );
  const da =
    "færgen holdt op med at sejle i oktober og november var floden frosset så hårdt til man kunne gå på den i enogtredive år havde hun aldrig krydset isen".split(
      " ",
    );
  const build = (words: string[], salt: number) =>
    Array.from({ length: paras }, (_, p) =>
      Array.from({ length: 60 }, (_, i) => words[(i * 7 + p + salt) % words.length]).join(
        " ",
      ) + ".",
    ).join("\n\n");
  return { original: build(en, 0), edited: build(da, 0) };
}

test("a translated chapter maps paragraph-to-paragraph, not word-to-word", async () => {
  const { original, edited } = translatedChapter(6);
  const docxBuf = await markdownToDocx(original);
  const input = Buffer.from(docxBuf);
  const { md, paragraphMap } = await docxToMarkdownMapped(input);
  const index = indexDocumentXml(await documentXmlOf(input));

  const { edits, unmapped } = remapChaptersToParagraphEdits(
    md,
    paragraphMap,
    index,
    [{ original: md, edited }],
  );
  assert.deepEqual(unmapped, []);

  const { buffer } = await rewriteDocxText(input, edits);
  const out = indexDocumentXml(await documentXmlOf(buffer));
  const got = out.paragraphs.map((p) => p.text).filter((t) => t.trim());
  assert.deepEqual(got, edited.split("\n\n"));
});

test("remapping a translated chapter stays proportional to the text", async () => {
  // Doubling the chapter must not quadruple the work. The word diff this
  // replaced went from ~0.4 s to ~1.5 s across exactly this step.
  const time = async (paras: number) => {
    const { original, edited } = translatedChapter(paras);
    const input = Buffer.from(await markdownToDocx(original));
    const { md, paragraphMap } = await docxToMarkdownMapped(input);
    const index = indexDocumentXml(await documentXmlOf(input));
    const t0 = performance.now();
    remapChaptersToParagraphEdits(md, paragraphMap, index, [
      { original: md, edited },
    ]);
    return performance.now() - t0;
  };
  const small = await time(10);
  const large = await time(40);
  // 4x the text, generously under 4x the quadratic blow-up it used to cost.
  assert.ok(
    large < Math.max(small * 8, 250),
    `remap scaled badly: ${small.toFixed(0)} ms for 10 paragraphs, ${large.toFixed(0)} ms for 40`,
  );
});
