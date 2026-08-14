// The DOCX emit layer, rebuilt on the `docx` library.
//
// The headline behaviour change: html-to-docx@1.8 kept only the INNERMOST tag of
// nested emphasis, so ***bold italic*** silently degraded to italic — the
// reader-critical channel for fiction. conversion.ts:547 documented that as a
// library limitation. It is now testable as a requirement instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { markdownToDocx, DEFAULT_DOCX_EXPORT_OPTIONS } from "../src/conversion.ts";
import { PAGEBREAK_MARKER } from "../src/chapters.ts";

async function documentXml(md: string, opts = {}): Promise<string> {
  const buf = await markdownToDocx(md, {
    ...DEFAULT_DOCX_EXPORT_OPTIONS,
    ...opts,
  });
  const zip = await JSZip.loadAsync(buf);
  return (await zip.file("word/document.xml")?.async("string")) ?? "";
}

test("plain prose survives", async () => {
  const xml = await documentXml("The lighthouse keeper rose before dawn.");
  assert.match(xml, /The lighthouse keeper rose before dawn\./);
});

test("bold and italic each survive on their own", async () => {
  const xml = await documentXml("A **bold** and an _italic_ word.");
  assert.match(xml, /<w:b\/>/, "bold run missing");
  assert.match(xml, /<w:i\/>/, "italic run missing");
});

test("bold+italic survives — html-to-docx dropped one of the two", async () => {
  const xml = await documentXml("She was ***utterly certain*** of it.");
  // Both properties must appear on the same run.
  const runs = xml.match(/<w:r>[\s\S]*?<\/w:r>/g) ?? [];
  // The enabled form specifically — <w:b w:val="false"/> must not count.
  const both = runs.filter((r) => /<w:b\/>/.test(r) && /<w:i\/>/.test(r));
  assert.ok(
    both.length > 0,
    "expected a run carrying BOTH bold and italic properties",
  );
  assert.match(both[0], /utterly certain/);
});

// Turndown never emits ***text*** from a .docx. mammoth gives <strong><em>…
// or <em><strong>…, which turndown writes as **_text_** and _**text**_ — the
// two forms the flat parser dropped half of. The ***…*** test above passed
// because it exercised the one spelling the import pipeline cannot produce.
test("bold+italic survives as **_text_** — what <strong><em> imports to", async () => {
  const xml = await documentXml("She was **_utterly certain_** of it.");
  const runs = xml.match(/<w:r>[\s\S]*?<\/w:r>/g) ?? [];
  const both = runs.filter((r) => /<w:b\/>/.test(r) && /<w:i\/>/.test(r));
  assert.ok(both.length > 0, "expected a run carrying BOTH bold and italic");
  assert.match(both[0], /utterly certain/);
});

test("bold+italic survives as _**text**_ — what <em><strong> imports to", async () => {
  const xml = await documentXml("She was _**utterly certain**_ of it.");
  const runs = xml.match(/<w:r>[\s\S]*?<\/w:r>/g) ?? [];
  const both = runs.filter((r) => /<w:b\/>/.test(r) && /<w:i\/>/.test(r));
  assert.ok(both.length > 0, "expected a run carrying BOTH bold and italic");
  assert.match(both[0], /utterly certain/);
});

test("emphasis nested inside a longer span keeps both spans right", async () => {
  // Only the inner words are italic; the whole phrase is bold.
  const xml = await documentXml("**plain _inner_ plain**");
  const runs = xml.match(/<w:r>[\s\S]*?<\/w:r>/g) ?? [];
  const inner = runs.find((r) => /inner/.test(r));
  assert.ok(inner, "inner run missing");
  assert.match(inner, /<w:b\/>/, "inner text should still be bold");
  assert.match(inner, /<w:i\/>/, "inner text should be italic");

  const outer = runs.find((r) => /plain/.test(r));
  assert.ok(outer, "outer run missing");
  assert.match(outer, /<w:b\/>/, "outer text should be bold");
  assert.doesNotMatch(outer, /<w:i\/>/, "outer text should NOT be italic");
});

test("headings become headings, not styled paragraphs", async () => {
  const xml = await documentXml("# Chapter One\n\nSome prose.");
  assert.match(xml, /Chapter One/);
  assert.match(xml, /<w:pStyle w:val="Heading1"\/>/);
});

// Page breaks the author did not put there are not ours to add. The HTML path
// has always emitted a page-break div before each chapter heading, but
// html-to-docx dropped it, so no shipped DOCX ever contained one. Honouring it
// in the new builder silently restructured people's manuscripts — reported from
// live use as "added a pagebreak between chapters which wasn't there before".
test("a chapter heading does not invent a page break", async () => {
  const xml = await documentXml("# One\n\nProse.\n\n# Two\n\nMore.");
  assert.doesNotMatch(xml, /<w:br w:type="page"\/>/);
});

test("the first chapter heading does not either", async () => {
  const xml = await documentXml("# One\n\nProse.");
  assert.doesNotMatch(xml, /<w:br w:type="page"\/>/);
});

test("a page break the author DID write is kept", async () => {
  // PAGEBREAK_MARKER is what a real <w:br w:type="page"/> imports to. Declining
  // to invent breaks must not start dropping genuine ones.
  const xml = await documentXml(`# One\n\nProse.\n\n${PAGEBREAK_MARKER}\n\n# Two\n\nMore.`);
  assert.match(xml, /<w:br w:type="page"\/>/);
});

test("chapter page breaks can be asked for explicitly", async () => {
  const xml = await documentXml("# One\n\nProse.\n\n# Two\n\nMore.", {
    chapterPageBreaks: true,
  });
  assert.match(xml, /<w:br w:type="page"\/>/);
});

test("scene breaks render per the chosen style", async () => {
  const asterisks = await documentXml("A\n\n***\n\nB");
  assert.match(asterisks, /\*\*\*/);
  const dash = await documentXml("A\n\n***\n\nB", { sectionBreak: "dash" });
  assert.match(dash, /—/, "em dash expected for the dash style");
});

test("a lone # renders as a minor break", async () => {
  const hash = await documentXml("A\n\n#\n\nB", { minorBreak: "hash" });
  assert.match(hash, />#</);
});

test("line spacing is applied", async () => {
  const xml = await documentXml("Prose.", { lineSpacing: 2 });
  assert.match(xml, /<w:spacing[^/]*w:line="480"/);
});

test("soft line breaks inside a paragraph are preserved", async () => {
  const xml = await documentXml("First line\nsecond line");
  assert.match(xml, /<w:br\/>/);
});

test("markdown escapes do not leak into the text", async () => {
  const xml = await documentXml("A plain sentence with no markup.");
  assert.doesNotMatch(xml, /\*\*/);
});

test("XML-significant characters are escaped, not injected", async () => {
  const xml = await documentXml("Tom & Jerry <not a tag>");
  assert.match(xml, /Tom &amp; Jerry/);
  assert.doesNotMatch(xml, /<not a tag>/);
});

test("the document is a valid zip with the expected parts", async () => {
  const buf = await markdownToDocx("Hello.", DEFAULT_DOCX_EXPORT_OPTIONS);
  const zip = await JSZip.loadAsync(buf);
  for (const part of ["word/document.xml", "[Content_Types].xml"]) {
    assert.ok(zip.file(part), `missing ${part}`);
  }
});
