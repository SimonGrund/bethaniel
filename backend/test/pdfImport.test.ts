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
import {
  pdfToMarkdown,
  ScannedPdfError,
  GarbledPdfError,
} from "../src/pdfToMarkdown.ts";

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

test("a drop cap opens its paragraph instead of becoming a heading", async () => {
  // A drop cap spans two or three lines, so its baseline sits with the SECOND
  // line. Assembled naively it is glued there and — being several times the
  // body size — promoted to a heading: the "D" of "Dust haze hung over Tabahi"
  // became "# Dof storms" and the paragraph began "ust haze".
  const pdf = buildPdf([
    {
      runs: [
        { text: "D", x: 72, y: 672, size: 36 },
        { text: "ust haze hung over Tabahi after the three days", x: 100, y: BODY_TOP },
        { text: "of storms. Tents peaked from sand piles that had", x: 100, y: BODY_TOP - 14 },
        { text: "formed around them, and the wind had not yet dropped.", x: 72, y: BODY_TOP - 28 },
      ],
    },
  ]);

  const md = await pdfToMarkdown(pdf);
  assert.match(md, /Dust haze hung over Tabahi/, md);
  assert.doesNotMatch(md, /^#.*Dof storms/m, "the drop cap became a heading");
  assert.doesNotMatch(md, /\bust haze/, "the paragraph lost its first letter");
});

test("a readable PDF is not refused for lacking a character map", async () => {
  // The base-14 fonts these fixtures use carry no ToUnicode map either, and
  // they decode perfectly. Absence of a map is not on its own evidence of
  // anything — the text has to look wrong too.
  const pdf = buildPdf([
    {
      runs: paragraph(
        [
          "The lighthouse keeper rose before dawn and walked the long path",
          "down to the water, where the boards were shaky underfoot and the",
          "rope had frayed against the post for years without anyone thinking",
          "to replace it, which was the sort of thing he noticed every morning",
          "and did nothing about, because there was always another morning.",
        ],
        { top: BODY_TOP, leading: 14 },
      ),
    },
  ]);
  const md = await pdfToMarkdown(pdf);
  assert.match(md, /lighthouse keeper/);
});

test("a PDF whose character map is wrong is refused", async () => {
  // The shape of the real failure: a fixed substitution drops capitals into the
  // middle of words. Transcribed from the file that prompted this — f→H, y→N,
  // v→x — and repeated across pages, because the detector needs a manuscript's
  // worth of words before it will judge anything.
  const garbled = [
    "Still, the ship's tossing testifed to the Horces raking at",
    "them. ye hung his cape on a hook, snow and ice dropping",
    "to the voor and melting instantlN. FierN red lanterns lit",
    "the room at exerN table. “o need to saxe the waA at this",
    "hour. C?nN news, ”apt’in-L ”rook asked, his xoice coarse",
    "and drN. The large room was meant Hor dining, drinking,",
    "celeW brating. TodaN it carried the silence oH men Hearing",
    "a Hate theN could not change. He looked Hrom Hace to Hace.",
  ];
  const pdf = buildPdf(
    Array.from({ length: 6 }, () => ({
      runs: paragraph(garbled, { top: BODY_TOP, leading: 14 }),
    })),
  );
  await assert.rejects(() => pdfToMarkdown(pdf), GarbledPdfError);
});

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

test("ordinary prose with proper nouns and an acronym is NOT refused", async () => {
  // The detector must survive everything that legitimately carries a capital,
  // and must see enough words to be judging at all. Pages differ from one
  // another, or their shared first and last lines read as running heads.
  const pdf = buildPdf(
    Array.from({ length: 6 }, (_, i) => ({
      runs: paragraph(
        [
          `${DAYS[i]} McDonald met the DeWitt brothers again by the water,`,
          "outside the BBC studios in London, where iPhone screens lit",
          "the queue and a man from MI5 pretended not to watch closely.",
          "O'Brien had warned them about the McKinsey report, and the",
          "DiCaprio name came up twice in the same breath as the NHS,",
          "which nobody in the OldeShoppe thought at all unusual then.",
          "MacGregor waited by the river with the LaSalle papers under",
          `one arm and a FitzGerald translation under the other, ${DAYS[i]}.`,
        ],
        { top: BODY_TOP, leading: 14 },
      ),
    })),
  );
  const md = await pdfToMarkdown(pdf);
  assert.match(md, /McDonald met the DeWitt brothers/, md.slice(0, 200));
  assert.match(md, /FitzGerald translation/);
});
