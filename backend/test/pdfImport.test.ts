// PDF is a layout format, not a document format: it records where glyphs sit,
// not what a paragraph is. Everything the editor needs — paragraphs, emphasis,
// chapter headings — has to be inferred from geometry and font names.
//
// The fixtures are built by hand (test/helpers/pdf.ts) so the coordinates are
// exactly known. A converter would give monospace text wrapped mid-word, which
// tests nothing about a typeset book.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPdf, paragraph } from "./helpers/pdf.ts";
import { pdfToMarkdown, ScannedPdfError } from "../src/pdfToMarkdown.ts";

const BODY_TOP = 700;

test("lines of one paragraph are joined; a wider gap starts a new one", async () => {
  // 14pt between wrapped lines, 28pt between paragraphs — the signal a reader
  // sees as white space and the only thing distinguishing the two.
  const pdf = buildPdf([
    {
      runs: [
        ...paragraph(
          [
            "The lighthouse keeper rose before dawn and walked",
            "the long path down to the water.",
          ],
          { top: BODY_TOP, leading: 14 },
        ),
        ...paragraph(["He had written the letter three times."], {
          top: BODY_TOP - 14 - 28,
        }),
      ],
    },
  ]);

  const md = await pdfToMarkdown(pdf);
  const paras = md.trim().split(/\n\n+/);
  assert.equal(paras.length, 2, md);
  assert.equal(
    paras[0],
    "The lighthouse keeper rose before dawn and walked the long path down to the water.",
  );
  assert.equal(paras[1], "He had written the letter three times.");
});

test("a word broken across lines is put back together", async () => {
  const pdf = buildPdf([
    {
      runs: paragraph(
        ["The keeper walked down to the light-", "house before dawn."],
        { top: BODY_TOP, leading: 14 },
      ),
    },
  ]);
  const md = await pdfToMarkdown(pdf);
  assert.match(md, /lighthouse before dawn/);
  assert.doesNotMatch(md, /light-\s*house/, "the hyphen should be gone");
});

test("a real hyphenated compound keeps its hyphen", async () => {
  // Breaking "well-lit" at the hyphen must not produce "welllit". The next line
  // starting with a capital is the signal that the hyphen belongs to the word.
  const pdf = buildPdf([
    {
      runs: paragraph(["It was a well-", "Known problem."], {
        top: BODY_TOP,
        leading: 14,
      }),
    },
  ]);
  const md = await pdfToMarkdown(pdf);
  assert.match(md, /well-Known/);
});

test("words are spaced by the gaps between them, not run together", async () => {
  // Real PDFs emit each word as its own positioned run with no space character.
  const pdf = buildPdf([
    {
      runs: [
        { text: "The", x: 72, y: BODY_TOP },
        { text: "keeper", x: 96, y: BODY_TOP },
        { text: "rose", x: 140, y: BODY_TOP },
      ],
    },
  ]);
  const md = await pdfToMarkdown(pdf);
  assert.match(md, /The keeper rose/);
});

test("a running head repeated across pages is dropped", async () => {
  // Same text, same place, every page. It is furniture, not prose — and left in
  // it would land in the middle of a sentence.
  const pages = [1, 2, 3].map((n) => ({
    runs: [
      { text: "THE LIGHTHOUSE KEEPER", x: 72, y: 750, size: 9 },
      ...paragraph(
        [
          `Body text of page ${n} runs here.`,
          "The keeper counted the stairs on the way up,",
          "as he had every morning for thirty years.",
          "The lamp needed trimming before the light failed.",
        ],
        { top: BODY_TOP, leading: 14 },
      ),
      { text: String(n), x: 300, y: 60, size: 9 },
    ],
  }));

  const md = await pdfToMarkdown(buildPdf(pages));
  assert.doesNotMatch(md, /THE LIGHTHOUSE KEEPER/, "running head survived");
  assert.match(md, /Body text of page 2/);
});

test("a page number alone on a line is dropped", async () => {
  const pages = [1, 2, 3].map((n) => ({
    runs: [
      ...paragraph(
        [
          `Page ${n} opens here with prose.`,
          "The path down to the water was slick with rain,",
          "and the boards complained under his weight.",
        ],
        { top: BODY_TOP, leading: 14 },
      ),
      { text: String(n * 10), x: 300, y: 60, size: 9 },
    ],
  }));
  const md = await pdfToMarkdown(buildPdf(pages));
  assert.doesNotMatch(md.trim(), /^\d+$/m, "a bare page number survived");
});

test("a larger line becomes a heading", async () => {
  const pdf = buildPdf([
    {
      runs: [
        { text: "Chapter One", x: 72, y: 730, size: 20, font: "bold" },
        ...paragraph(["The keeper rose before dawn and went down."], {
          top: BODY_TOP,
        }),
      ],
    },
  ]);
  const md = await pdfToMarkdown(pdf);
  assert.match(md, /^# Chapter One$/m, md);
});

test("italic and bold survive as emphasis", async () => {
  // Italics carry meaning in fiction — thoughts, titles, stress. Losing them
  // changes what the sentence says.
  const pdf = buildPdf([
    {
      runs: [
        { text: "She was", x: 72, y: BODY_TOP },
        { text: "certain", x: 120, y: BODY_TOP, font: "italic" },
        { text: "of it.", x: 170, y: BODY_TOP },
      ],
    },
  ]);
  const md = await pdfToMarkdown(pdf);
  assert.match(md, /_certain_/, md);
  assert.match(md, /She was _certain_ of it\./);
});

test("a paragraph running over a page break stays one paragraph", async () => {
  const pdf = buildPdf([
    { runs: paragraph(["The keeper rose before dawn and walked down"], { top: 200 }) },
    { runs: paragraph(["the long path to the water."], { top: BODY_TOP }) },
  ]);
  const md = await pdfToMarkdown(pdf);
  assert.match(md, /walked down the long path/, md);
});

test("a new sentence after a page break starts a new paragraph", async () => {
  const pdf = buildPdf([
    { runs: paragraph(["The keeper rose before dawn."], { top: 200 }) },
    { runs: paragraph(["He had written the letter three times."], { top: BODY_TOP }) },
  ]);
  const md = await pdfToMarkdown(pdf);
  const paras = md.trim().split(/\n\n+/);
  assert.equal(paras.length, 2, md);
});

test("a scanned PDF is refused, not imported as an empty manuscript", async () => {
  // No text layer at all. Importing it silently would hand the user a blank
  // document and no idea why.
  const pdf = buildPdf([{ runs: [] }]);
  await assert.rejects(() => pdfToMarkdown(pdf), ScannedPdfError);
});

test("a PDF that is not a PDF fails clearly", async () => {
  await assert.rejects(
    () => pdfToMarkdown(Buffer.from("this is not a pdf at all")),
    (err: Error) => !(err instanceof ScannedPdfError),
  );
});
