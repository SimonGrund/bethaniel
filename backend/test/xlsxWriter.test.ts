// ── A spreadsheet from rows ──

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { writeXlsx } from "../src/xlsxWriter.ts";

test("rows become one sheet of text cells, the header bold and frozen", async () => {
  const buf = await writeXlsx(
    [
      ["Original", "Suggestion"],
      ["a < b & \"c\"", "line one\nline two"],
      ["control\u0001char", ""],
    ],
    "Reviews",
  );
  const zip = await JSZip.loadAsync(buf);
  for (const f of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    assert.ok(zip.file(f), f);
  }
  const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  assert.match(sheet, /<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">Original<\/t><\/is><\/c>/);
  assert.match(sheet, /a &lt; b &amp; &quot;c&quot;/);
  assert.match(sheet, /line one\nline two/);
  assert.match(sheet, /controlchar/, "characters XML cannot hold are dropped, not left to corrupt the file");
  assert.match(sheet, /<pane[^>]*ySplit="1"/);
  assert.match(await zip.file("xl/workbook.xml")!.async("string"), /name="Reviews"/);
});

test("columns past Z are lettered AA, AB", async () => {
  const row = Array.from({ length: 28 }, (_, i) => `h${i}`);
  const sheet = await (await JSZip.loadAsync(await writeXlsx([row], "S"))).file("xl/worksheets/sheet1.xml")!.async("string");
  assert.match(sheet, /r="AB1"/);
});
