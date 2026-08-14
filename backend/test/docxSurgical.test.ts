// End-to-end proof that surgical editing preserves everything it does not
// deliberately change.
//
// The strongest assertion here is not "the correction landed" — it is that
// every formatting construct present in the input is still present, byte for
// byte, in the output, and that the other parts of the zip are untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";

import { indexDocumentXml, rewriteDocxText } from "../src/docxSurgery.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** A .docx carrying the formatting a real manuscript would have. */
async function buildRichDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/></w:style>
</w:styles>`,
  );
  zip.file("word/theme/theme1.xml", `<?xml version="1.0"?><a:theme xmlns:a="x"/>`);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:spacing w:line="360"/><w:jc w:val="both"/><w:ind w:firstLine="425"/></w:pPr>
      <w:r>
        <w:rPr><w:rFonts w:ascii="Garamond"/><w:sz w:val="26"/><w:color w:val="1F4E79"/><w:highlight w:val="yellow"/></w:rPr>
        <w:t xml:space="preserve">The shakey hand of the keeper.</w:t>
      </w:r>
    </w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:txbxContent><w:p><w:r><w:t>inside a text box</w:t></w:r></w:p></w:txbxContent></w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
  </w:body>
</w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function documentXmlOf(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  return (await zip.file("word/document.xml")?.async("string")) ?? "";
}

test("a correction lands and every formatting construct survives", async () => {
  const input = await buildRichDocx();
  const beforeXml = await documentXmlOf(input);

  const { buffer, applied, skipped } = await rewriteDocxText(input, [
    { paragraphIndex: 0, start: 4, end: 10, replacement: "shaky" },
  ]);
  assert.equal(applied, 1);
  assert.equal(skipped.length, 0);

  const afterXml = await documentXmlOf(buffer);
  assert.match(afterXml, /The shaky hand of the keeper\./);

  // Every formatting construct present in the input must still be present.
  for (const fragment of [
    `<w:spacing w:line="360"/>`,
    `<w:jc w:val="both"/>`,
    `<w:ind w:firstLine="425"/>`,
    `<w:rFonts w:ascii="Garamond"/>`,
    `<w:sz w:val="26"/>`,
    `<w:color w:val="1F4E79"/>`,
    `<w:highlight w:val="yellow"/>`,
    `<w:tbl>`,
    `<w:txbxContent>`,
    `<w:sectPr>`,
    `<w:pgSz w:w="11906" w:h="16838"/>`,
  ]) {
    assert.ok(afterXml.includes(fragment), `lost: ${fragment}`);
  }

  // Paragraph count unchanged — nothing added, nothing dropped.
  assert.equal(
    indexDocumentXml(afterXml).paragraphs.length,
    indexDocumentXml(beforeXml).paragraphs.length,
  );
});

test("only the corrected span differs — the rest of the XML is identical", async () => {
  const input = await buildRichDocx();
  const before = await documentXmlOf(input);
  const { buffer } = await rewriteDocxText(input, [
    { paragraphIndex: 0, start: 4, end: 10, replacement: "shaky" },
  ]);
  const after = await documentXmlOf(buffer);

  // Undo the one intended change; the result must be byte-identical.
  assert.equal(after.replace("The shaky hand", "The shakey hand"), before);
});

test("other zip parts pass through byte-for-byte", async () => {
  const input = await buildRichDocx();
  const inZip = await JSZip.loadAsync(input);
  const { buffer } = await rewriteDocxText(input, [
    { paragraphIndex: 0, start: 4, end: 10, replacement: "shaky" },
  ]);
  const outZip = await JSZip.loadAsync(buffer);

  for (const part of ["word/styles.xml", "word/theme/theme1.xml", "[Content_Types].xml"]) {
    assert.equal(
      await outZip.file(part)?.async("string"),
      await inZip.file(part)?.async("string"),
      `${part} changed`,
    );
  }
});

test("a refused edit leaves the document completely untouched", async () => {
  const input = await buildRichDocx();
  const before = await documentXmlOf(input);
  // Paragraph 2 is the table cell; ask for something out of range.
  const { buffer, applied, skipped } = await rewriteDocxText(input, [
    { paragraphIndex: 1, start: 0, end: 999, replacement: "nope" },
  ]);
  assert.equal(applied, 0);
  assert.equal(skipped.length, 1);
  assert.equal(await documentXmlOf(buffer), before);
});

test("the real sample manuscript round-trips with its structure intact", async () => {
  // sample_texts/two_chapters_english.docx is a genuine Word export containing
  // real errors ("shakey", "writen", "had began") and a paragraph Word split
  // across runs at a rendered page break.
  const file = path.join(REPO, "sample_texts", "two_chapters_english.docx");
  const input = fs.readFileSync(file);
  const beforeIndex = indexDocumentXml(await documentXmlOf(input));

  const target = beforeIndex.paragraphs.findIndex((p) =>
    p.text.includes("shakey"),
  );
  assert.ok(target >= 0, "expected the fixture to contain 'shakey'");

  const at = beforeIndex.paragraphs[target].text.indexOf("shakey");
  const { buffer, applied, skipped } = await rewriteDocxText(input, [
    { paragraphIndex: target, start: at, end: at + 6, replacement: "shaky" },
  ]);

  assert.equal(applied, 1, `skipped: ${JSON.stringify(skipped)}`);
  const afterIndex = indexDocumentXml(await documentXmlOf(buffer));
  assert.equal(
    afterIndex.paragraphs.length,
    beforeIndex.paragraphs.length,
    "paragraph structure must be identical",
  );
  assert.ok(afterIndex.paragraphs[target].text.includes("shaky"));
  assert.ok(!afterIndex.paragraphs[target].text.includes("shakey"));
});
