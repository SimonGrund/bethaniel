// ── A term list uploaded as a file ──
//
// Every format becomes the same thing: tab-separated lines (plus any prose
// the file holds), which go into the paste field for the author to see and
// then through parseTermList like anything typed.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { Document, Packer, Paragraph, Table, TableCell, TableRow } from "docx";

import { extractTermListText } from "../src/termListFile.ts";
import { parseTermList } from "../src/termList.ts";

test("a CSV with a byte-order mark is read as text", async () => {
  const text = await extractTermListText("terms.csv", Buffer.from("﻿term,translation\nGDPR,DSGVO\n"), {});
  assert.equal(parseTermList(text).rows[0].term, "GDPR");
});

test("TBX: the source and target languages are picked out of each entry", async () => {
  const tbx = `<?xml version="1.0"?><tbx><text><body>
    <termEntry id="1">
      <langSec xml:lang="fr"><termGrp><term>responsable du traitement</term></termGrp></langSec>
      <langSec xml:lang="en-GB"><termGrp><term>data controller</term></termGrp></langSec>
      <langSec xml:lang="de"><termGrp><term>Verantwortlicher</term></termGrp></langSec>
    </termEntry>
    <termEntry id="2">
      <langSec xml:lang="en"><tig><term>R&amp;D</term></tig></langSec>
      <langSec xml:lang="de"><tig><term>F&amp;E</term></tig></langSec>
    </termEntry>
  </body></text></tbx>`;
  const text = await extractTermListText("client.tbx", Buffer.from(tbx), { sourceLang: "en", targetLang: "German" });
  assert.deepEqual(parseTermList(text).rows, [
    { term: "data controller", rendering: "Verantwortlicher", keep: false },
    { term: "R&D", rendering: "F&E", keep: false },
  ]);
});

test("Excel: the first sheet's rows, shared and inline strings, gaps kept", async () => {
  const zip = new JSZip();
  zip.file(
    "xl/sharedStrings.xml",
    `<sst><si><t>Term</t></si><si><t>Translation</t></si><si><t>third country</t></si><si><r><t>Dritt</t></r><r><t>land</t></r></si></sst>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<worksheet><sheetData>
      <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
      <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>
      <row r="3"><c r="A3" t="inlineStr"><is><t>Nordlys ApS</t></is></c><c r="C3" t="inlineStr"><is><t>keep</t></is></c></row>
    </sheetData></worksheet>`,
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const text = await extractTermListText("terms.xlsx", buf, {});
  assert.deepEqual(parseTermList(text).rows, [
    { term: "third country", rendering: "Drittland", keep: false },
    { term: "Nordlys ApS", rendering: "Nordlys ApS", keep: true },
  ]);
});

test("Word: a table's rows are rows, its paragraphs are notes", async () => {
  const cell = (t: string) => new TableCell({ children: [new Paragraph(t)] });
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph("Please keep the company names untranslated."),
          new Table({
            rows: [
              new TableRow({ children: [cell("Term"), cell("Translation")] }),
              new TableRow({ children: [cell("data subject"), cell("betroffene Person")] }),
            ],
          }),
        ],
      },
    ],
  });
  const text = await extractTermListText("terms.docx", await Packer.toBuffer(doc), {});
  const parsed = parseTermList(text);
  assert.deepEqual(parsed.rows, [{ term: "data subject", rendering: "betroffene Person", keep: false }]);
  assert.equal(parsed.rest, "Please keep the company names untranslated.");
});

test("a format it cannot read is refused, not guessed at", async () => {
  await assert.rejects(() => extractTermListText("terms.pdf", Buffer.from("%PDF-1.7"), {}), /cannot read/);
});
