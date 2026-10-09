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
  alignTranslatedBlocks,
  stripMarkdown,
  tabbedTitleEdit,
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

// ── A translation of a real book, as it was found broken (2026-10-09) ──
// A Danish handbook into English: 243 paragraphs stayed Danish. One Word
// paragraph (a nested table-of-contents line) had no markdown block of its
// own, the map pairs blocks and paragraphs in order, and from there every
// pair was off by one — each paragraph failed its check, to the end of the
// book. Links and short titles accounted for the rest.

/** Blocks of `md` paired IN ORDER with the docx's paragraphs, the way an
 *  importer that skipped one Word paragraph would pair them. */
function inOrderMap(md: string, count: number) {
  const out: { docxParaIndex: number; mdStart: number; mdEnd: number; mappable: boolean }[] = [];
  let from = 0;
  md.split("\n\n").forEach((block, i) => {
    const at = md.indexOf(block, from);
    out.push({ docxParaIndex: Math.min(i, count - 1), mdStart: at, mdEnd: at + block.length, mappable: true });
    from = at + block.length;
  });
  return out;
}

test("one Word paragraph without a markdown block does not shift every paragraph after it", async () => {
  const paras = ["Første afsnit om tryghed.", "Andet afsnit om mod.", "Tredje afsnit om fejl.", "Fjerde afsnit om ro."];
  const docx = Buffer.from(await markdownToDocx([paras[0], paras[1], "Et ekstra afsnit kun i Word.", paras[2], paras[3]].join("\n\n")));
  const index = indexDocumentXml(await documentXmlOf(docx));
  const md = paras.join("\n\n");
  const en = ["First paragraph on safety.", "Second paragraph on courage.", "Third paragraph on mistakes.", "Fourth paragraph on calm."];
  const { edits, unmapped } = remapChaptersToParagraphEdits(md, inOrderMap(md, index.paragraphs.length), index, [
    { original: md, edited: en.join("\n\n") },
  ]);
  assert.deepEqual(unmapped, []);
  const { buffer } = await rewriteDocxText(docx, edits);
  const out = indexDocumentXml(await documentXmlOf(buffer)).paragraphs.map((p) => p.text).filter((t) => t.trim());
  assert.deepEqual(out, [en[0], en[1], "Et ekstra afsnit kun i Word.", en[2], en[3]]);
});

test("a link's markdown is not part of the text Word holds", () => {
  assert.equal(stripMarkdown("[LÆSEVEJLEDNING 17](#TOC250118)"), "LÆSEVEJLEDNING 17");
  assert.equal(
    stripMarkdown("København, [www.belastningspsykologi.dk](http://www.belastningspsykologi.dk/)"),
    "København, www.belastningspsykologi.dk",
  );
  assert.equal(stripMarkdown("before ![a picture](img.png) after"), "before  after");
});

test("in a translation, a short paragraph is replaced whole, not spliced", async () => {
  const md = "Håndbog i psykologisk tryghed\n\nTør vi? Tør vi lade være?";
  const docx = Buffer.from(await markdownToDocx(md));
  const { md: imported, paragraphMap } = await docxToMarkdownMapped(docx);
  const index = indexDocumentXml(await documentXmlOf(docx));
  const edited = "Handbook of Psychological Safety\n\nDo we dare? Do we dare not to?";
  const { edits } = remapChaptersToParagraphEdits(imported, paragraphMap, index, [{ original: imported, edited }], {
    wholeParagraphs: true,
  });
  assert.equal(edits.length, 2);
  assert.ok(edits.every((e) => e.wholeParagraph && e.start === 0));
});

test("a table-of-contents line keeps its tabs and page number; only its title is translated", () => {
  assert.deepEqual(tabbedTitleEdit("\tFORORD af Jette Albinus\t13", "FOREWORD by Jette Albinus 13"), {
    start: 1, end: 24, replacement: "FOREWORD by Jette Albinus",
  });
  assert.deepEqual(tabbedTitleEdit("2.\tSætte rammen\t72", "2. Setting the frame 72"), {
    start: 3, end: 15, replacement: "Setting the frame",
  });
  // Two titles on one line: no way to tell which words go where.
  assert.equal(tabbedTitleEdit("Navn\tAdresse", "Name Address"), null);
});

test("a long run of Word-only paragraphs (a contents page) is followed, not lost", async () => {
  const body = Array.from({ length: 10 }, (_, i) => `Afsnit nummer ${i} om tryghed i gruppen.`);
  const toc = Array.from({ length: 12 }, (_, i) => `Indhold linje ${i}`);
  const docx = Buffer.from(await markdownToDocx(["Titel", ...toc, ...body].join("\n\n")));
  const index = indexDocumentXml(await documentXmlOf(docx));
  // The importer kept the title and the body, not the contents lines.
  const md = ["Titel", ...body].join("\n\n");
  const en = ["Title", ...body.map((_, i) => `Paragraph number ${i} on safety in the group.`)];
  const { edits, unmapped } = remapChaptersToParagraphEdits(md, inOrderMap(md, index.paragraphs.length), index, [
    { original: md, edited: en.join("\n\n") },
  ], { wholeParagraphs: true });
  assert.deepEqual(unmapped, []);
  const { buffer } = await rewriteDocxText(docx, edits);
  const out = indexDocumentXml(await documentXmlOf(buffer)).paragraphs.map((p) => p.text).filter((t) => t.trim());
  assert.deepEqual(out, ["Title", ...toc, ...en.slice(1)]);
});

// Seen on the same book: a sentence the PDF conversion broke across a page
// is two paragraphs in Danish and one in English — the translator joined
// it, rightly. Aligned by character offsets, every paragraph after the join
// was cut in the wrong place ("ften find it easier" for "We often find").
test("a translation that joins a page-broken sentence is aligned paragraph to paragraph", () => {
  const original = [
    "## Kapitel",
    "Her kan man så indvende, at det slet ikke burde være svært at sige, at man er",
    "uenig eller fortælle om sine fejl, men det er det.",
    "Det næste afsnit handler om noget helt andet og er ret langt for at fylde.",
  ];
  const edited = [
    "## Chapter",
    "At this point, one might object that it should not be hard at all to say that one disagrees or to talk about one's mistakes, but it is.",
    "The next paragraph is about something else entirely and is fairly long to fill.",
  ];
  const aligned = alignTranslatedBlocks(original, edited);
  assert.equal(aligned.length, 4);
  assert.equal(aligned[0], "## Chapter");
  // The joined sentence is shared by the two Word paragraphs, whole words only.
  assert.equal(`${aligned[1]} ${aligned[2]}`, edited[1]);
  assert.ok(aligned[1].length > aligned[2].length, "split by the source's proportions");
  assert.equal(aligned[3], edited[2]);
});

test("a split never falls inside an emphasised phrase", () => {
  const aligned = alignTranslatedBlocks(
    ["Første halvdel af en sætning der", "fortsætter her."],
    ["The first half of a sentence _that goes on and on here_ and ends."],
  );
  for (const part of aligned) assert.equal((part.match(/_/g) ?? []).length % 2, 0, part);
});

test("an equal number of paragraphs is paired one to one", () => {
  assert.deepEqual(alignTranslatedBlocks(["a b c", "d e f g h"], ["x y z", "q r s t u"]), ["x y z", "q r s t u"]);
});
