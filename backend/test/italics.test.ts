// Italics preservation across the DOCX pipeline. A real user manuscript lost
// its italics when the exporter was html-to-docx, which silently dropped <em>
// runs and kept only the innermost tag of nested emphasis. The DOCX emit layer
// is now programmatic (mdToDocx.ts), so both defects are gone and bold+italic
// survives intact. These tests round-trip markdown → .docx → markdown through
// the real conversion functions, plus the import-side handling of Word's
// "Emphasis" character style (which mammoth's default style map ignores).

import { test } from "node:test";
import assert from "node:assert/strict";

import { markdownToDocx, docxToMarkdown } from "../src/conversion.ts";

// ── markdown → .docx → markdown round-trips ──
// Assertions are delimiter-agnostic: mammoth+turndown re-import emphasis as
// _underscores_ regardless of the input delimiter.

async function roundTrip(md: string): Promise<string> {
  const buf = await markdownToDocx(md);
  return docxToMarkdown(buf);
}

test("asterisk italics survive a DOCX round-trip", async () => {
  const back = await roundTrip("He said *hello* to her.");
  assert.match(back, /[_*]hello[_*]/, back);
});

test("underscore italics survive a DOCX round-trip", async () => {
  const back = await roundTrip("She wrote _quietly_ in the margin.");
  assert.match(back, /[_*]quietly[_*]/, back);
});

test("bold survives a DOCX round-trip", async () => {
  const back = await roundTrip("This is **important** now.");
  assert.match(back, /\*\*important\*\*|__important__/, back);
});

test("bold-italic keeps BOTH through a DOCX round-trip", async () => {
  // Under html-to-docx this degraded to italic only, and the test could assert
  // no more than "at least the italic". The programmatic builder writes both
  // properties onto one run, so both come back.
  const back = await roundTrip("A ***warning*** appeared.");
  assert.match(back, /\*\*[_*]warning[_*]\*\*/, back);
});

test("italics with adjacent punctuation survive a DOCX round-trip", async () => {
  const back = await roundTrip("The sign read *No entry*.");
  assert.match(back, /[_*]No entry[_*]\./, back);
});

test("italics around curly quotes survive a DOCX round-trip", async () => {
  const back = await roundTrip("he said *“hi”* and left.");
  assert.match(back, /[_*]“hi”[_*]/, back);
});

test("italics after a scene break survive; the break itself is kept", async () => {
  const back = await roundTrip(
    "The night ended.\n\n* * *\n\n*Morning came slowly* over the hills.",
  );
  // Export emits "***" (Atticus's form); the importer normalizes it back.
  assert.ok(back.includes("***"), back);
  assert.match(back, /[_*]Morning came slowly[_*]/, back);
});

test("Danish italic sentence survives a DOCX round-trip", async () => {
  const back = await roundTrip("Han tænkte: *Kniven lå på bordet.*");
  assert.match(back, /[_*]Kniven lå på bordet\.[_*]/, back);
});

// ── import: Word "Emphasis" character style ──
// Word can italicize via a character STYLE (no direct <w:i/> on the run).
// Mammoth's default style map has no Emphasis mapping, so without our
// styleMap entries such text imports as plain — italics silently lost at
// upload. Build a minimal .docx in memory to prove both paths import.

async function buildStyledDocx(bodyXml?: string): Promise<Buffer> {
  const { default: JSZip } = await import("jszip");
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
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  );
  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="character" w:styleId="Emphasis">
    <w:name w:val="Emphasis"/>
    <w:rPr><w:i/></w:rPr>
  </w:style>
</w:styles>`,
  );
  const defaultBody = `    <w:p>
      <w:r><w:t xml:space="preserve">Plain then </w:t></w:r>
      <w:r>
        <w:rPr><w:rStyle w:val="Emphasis"/></w:rPr>
        <w:t>styled italics</w:t>
      </w:r>
      <w:r><w:t xml:space="preserve"> then </w:t></w:r>
      <w:r>
        <w:rPr><w:i/></w:rPr>
        <w:t>direct italics</w:t>
      </w:r>
      <w:r><w:t>.</w:t></w:r>
    </w:p>`;
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
${bodyXml ?? defaultBody}
  </w:body>
</w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

test("Emphasis character style imports as italics (not plain text)", async () => {
  const md = await docxToMarkdown(await buildStyledDocx());
  assert.match(md, /[_*]styled italics[_*]/, md);
  assert.match(md, /[_*]direct italics[_*]/, md);
});

// ── import: adjacent italic runs coalesce without broken seams ──
// Word splits runs arbitrarily; adjacent same-format runs must not import as
// corrupt seams like "_He__ ran_".

// ── markdown-escape hygiene ──
// Turndown escapes literal `_`/`*` found as text in the docx (`\_s\_`) — an
// artifact of earlier exports that leaked markers as literal characters.
// Import strips these escapes; the corrections parser strips model-added
// escapes; export never emits literal backslash-marker sequences.

test("literal _s_ text in a docx imports without backslash escapes", async () => {
  // Fixture built by hand rather than generated: the point is a docx whose text
  // contains literal underscore characters, which is awkward to express through
  // any markdown-aware builder.
  const buf = await buildStyledDocx(
    `    <w:p><w:r><w:t xml:space="preserve">Bethaniel_s_ hus og _“Goddag,”_ sagde han.</w:t></w:r></w:p>`,
  );
  const md = await docxToMarkdown(buf);
  assert.ok(!md.includes("\\_"), md);
  assert.ok(!md.includes("\\*"), md);
});

test("corrections parser strips model-added markdown escapes", async () => {
  const { parseCorrectionsJson } = await import("../src/llm.ts");
  const raw =
    '{"original": "_word_ here", "corrected": "\\\\_word\\\\_ there"}';
  const cs = parseCorrectionsJson(raw);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "_word_ there");
});

test("adjacent italic runs import without __ seams", async () => {
  // Two consecutive italic runs — exactly how Word splits a phrase whose
  // formatting is uniform but whose runs are not.
  const buf = await buildStyledDocx(
    `    <w:p>
      <w:r><w:rPr><w:i/></w:rPr><w:t>He</w:t></w:r>
      <w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve"> ran</w:t></w:r>
      <w:r><w:t xml:space="preserve"> home.</w:t></w:r>
    </w:p>`,
  );
  const md = await docxToMarkdown(buf);
  assert.ok(!md.includes("__"), md);
  assert.match(md, /_He ran_ home\./, md);
});
