// Surgical DOCX editing: rewrite the text inside <w:t> runs and leave every
// other byte of document.xml alone. Formatting survives because nothing
// regenerates it.
//
// The guarantee this suite exists to hold: an edit is applied only when it can
// be applied WITHOUT altering formatting. Anything else is skipped and
// reported. There is no policy switch — a guarantee you can turn off is not one.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  indexDocumentXml,
  planParagraphSplices,
  applySplices,
} from "../src/docxSurgery.ts";

const doc = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:body>${body}</w:body></w:document>`;

const run = (text: string, rPr = "") =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;

/** Apply edits to one paragraph and return the new XML plus what was skipped. */
function edit(
  xml: string,
  paragraphIndex: number,
  edits: { start: number; end: number; replacement: string }[],
) {
  const index = indexDocumentXml(xml);
  const p = index.paragraphs[paragraphIndex];
  const { splices, skipped } = planParagraphSplices(p, edits);
  return { xml: applySplices(xml, splices), skipped, index };
}

// ── Scanning ──

test("paragraph text is the concatenation of its runs", () => {
  const xml = doc(`<w:p>${run("Hello, ")}${run("world.")}</w:p>`);
  const i = indexDocumentXml(xml);
  assert.equal(i.paragraphs.length, 1);
  assert.equal(i.paragraphs[0].text, "Hello, world.");
});

test("a paragraph inside a text box gets its own ordinal", () => {
  // The regex this replaces terminated the OUTER <w:p> at the INNER </w:p>,
  // finding 2 paragraphs where 3 exist and swallowing the text box. Any
  // document with a text box already misaligns on import today.
  const xml = doc(
    `<w:p>${run("outer")}<w:txbxContent><w:p>${run("inner")}</w:p></w:txbxContent>${run("tail")}</w:p>` +
      `<w:p>${run("next")}</w:p>`,
  );
  const i = indexDocumentXml(xml);
  assert.equal(i.paragraphs.length, 3);
  assert.equal(i.paragraphs[0].text, "outertail", "text box text is not the outer paragraph's");
  assert.equal(i.paragraphs[1].text, "inner");
  assert.equal(i.paragraphs[1].depth, 1);
  assert.equal(i.paragraphs[2].text, "next");
});

test("tracked deletions and field codes are not part of the text", () => {
  const xml = doc(
    `<w:p>${run("kept ")}<w:r><w:delText>deleted</w:delText></w:r>` +
      `<w:r><w:instrText>PAGE</w:instrText></w:r>${run("also kept")}</w:p>`,
  );
  assert.equal(indexDocumentXml(xml).paragraphs[0].text, "kept also kept");
});

test("mc:Fallback text is not counted twice", () => {
  // Both branches describe the same shape; counting both doubles the text and
  // shifts every downstream offset.
  const xml = doc(
    `<w:p><mc:AlternateContent xmlns:mc="x">` +
      `<mc:Choice Requires="wps">${run("shape")}</mc:Choice>` +
      `<mc:Fallback>${run("shape")}</mc:Fallback>` +
      `</mc:AlternateContent></w:p>`,
  );
  assert.equal(indexDocumentXml(xml).paragraphs[0].text, "shape");
});

test("tabs and breaks occupy a character so offsets stay honest", () => {
  const xml = doc(`<w:p>${run("a")}<w:r><w:tab/></w:r>${run("b")}</w:p>`);
  const p = indexDocumentXml(xml).paragraphs[0];
  assert.equal(p.text, "a\tb");
});

test("entities are decoded into the plain text", () => {
  const xml = doc(`<w:p>${run("Tom &amp; Jerry &lt;here&gt;")}</w:p>`);
  assert.equal(indexDocumentXml(xml).paragraphs[0].text, "Tom & Jerry <here>");
});

test("table paragraphs are flagged", () => {
  const xml = doc(
    `<w:tbl><w:tr><w:tc><w:p>${run("cell")}</w:p></w:tc></w:tr></w:tbl>`,
  );
  assert.equal(indexDocumentXml(xml).paragraphs[0].inTable, true);
});

// ── Splicing ──

test("an edit inside a single run is applied", () => {
  const xml = doc(`<w:p>${run("The shakey hand.")}</w:p>`);
  const r = edit(xml, 0, [{ start: 4, end: 10, replacement: "shaky" }]);
  assert.equal(r.skipped.length, 0);
  assert.equal(indexDocumentXml(r.xml).paragraphs[0].text, "The shaky hand.");
});

test("formatting bytes are untouched by an applied edit", () => {
  const rPr = `<w:b/><w:color w:val="FF0000"/>`;
  const xml = doc(`<w:p>${run("The shakey hand.", rPr)}</w:p>`);
  const r = edit(xml, 0, [{ start: 4, end: 10, replacement: "shaky" }]);
  assert.ok(r.xml.includes(`<w:rPr>${rPr}</w:rPr>`), "run properties must survive verbatim");
});

test("an edit spanning runs with IDENTICAL formatting is applied", () => {
  const rPr = `<w:i/>`;
  const xml = doc(`<w:p>${run("had ", rPr)}${run("began", rPr)}</w:p>`);
  const r = edit(xml, 0, [{ start: 0, end: 9, replacement: "had begun" }]);
  assert.equal(r.skipped.length, 0, "identical formatting is safe to merge");
  assert.equal(indexDocumentXml(r.xml).paragraphs[0].text, "had begun");
});

test("an edit spanning runs with DIFFERENT formatting is skipped, not guessed", () => {
  const xml = doc(`<w:p>${run("She was ")}${run("certain", "<w:i/>")}${run(" of it.")}</w:p>`);
  const before = xml;
  const r = edit(xml, 0, [
    { start: 0, end: 22, replacement: "He felt sure about it." },
  ]);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, "mixed-formatting");
  assert.equal(r.xml, before, "the XML must be byte-identical when an edit is refused");
});

test("trimming collapses a cross-run edit into one run where it can", () => {
  // The span crosses the italic boundary, but once the shared prefix and suffix
  // are trimmed only the italic word actually changes — so it is safe.
  const xml = doc(`<w:p>${run("She was ")}${run("certian", "<w:i/>")}${run(" of it.")}</w:p>`);
  const r = edit(xml, 0, [
    { start: 0, end: 22, replacement: "She was certain of it." },
  ]);
  assert.equal(r.skipped.length, 0, "trimming should have made this safe");
  const after = indexDocumentXml(r.xml).paragraphs[0];
  assert.equal(after.text, "She was certain of it.");
  assert.ok(r.xml.includes("<w:i/>"), "the italic run must still be italic");
});

test("an edit overlapping a tab is skipped", () => {
  const xml = doc(`<w:p>${run("a")}<w:r><w:tab/></w:r>${run("b")}</w:p>`);
  const before = xml;
  const r = edit(xml, 0, [{ start: 0, end: 3, replacement: "xyz" }]);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, "virtual-node");
  assert.equal(r.xml, before);
});

test("replacement text is re-encoded, not injected raw", () => {
  const xml = doc(`<w:p>${run("Tom and Jerry")}</w:p>`);
  // "Tom and Jerry" — replace the word "and" at [4,7), not the space with it.
  const r = edit(xml, 0, [{ start: 4, end: 7, replacement: "&" }]);
  assert.ok(r.xml.includes("&amp;"), "raw & would corrupt the XML");
  assert.equal(indexDocumentXml(r.xml).paragraphs[0].text, "Tom & Jerry");
});

test("xml:space is added when new text gains a leading space", () => {
  // Without it Word silently eats the space.
  const xml = doc(`<w:p><w:r><w:t>word</w:t></w:r></w:p>`);
  const r = edit(xml, 0, [{ start: 0, end: 4, replacement: " word" }]);
  assert.match(r.xml, /<w:t xml:space="preserve">/);
  assert.equal(indexDocumentXml(r.xml).paragraphs[0].text, " word");
});

test("multiple edits in one paragraph all land", () => {
  const xml = doc(`<w:p>${run("The shakey hand had began to move.")}</w:p>`);
  const r = edit(xml, 0, [
    { start: 4, end: 10, replacement: "shaky" },
    { start: 16, end: 25, replacement: "had begun" },
  ]);
  assert.equal(r.skipped.length, 0);
  assert.equal(
    indexDocumentXml(r.xml).paragraphs[0].text,
    "The shaky hand had begun to move.",
  );
});

test("an out-of-range edit is refused rather than clamped", () => {
  const xml = doc(`<w:p>${run("short")}</w:p>`);
  const before = xml;
  const r = edit(xml, 0, [{ start: 2, end: 99, replacement: "x" }]);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].reason, "out-of-range");
  assert.equal(r.xml, before);
});

test("editing one paragraph leaves the others byte-identical", () => {
  const xml = doc(
    `<w:p>${run("first")}</w:p><w:p>${run("shakey")}</w:p><w:p>${run("third")}</w:p>`,
  );
  const r = edit(xml, 1, [{ start: 0, end: 6, replacement: "shaky" }]);
  const after = indexDocumentXml(r.xml).paragraphs;
  assert.equal(after[0].text, "first");
  assert.equal(after[1].text, "shaky");
  assert.equal(after[2].text, "third");
});

// A skipped edit is only actionable if the user can find the place it belongs.
// "shaky" on its own is unsearchable; the sentence around it is not.
test("a skipped edit carries enough context to locate it in Word", () => {
  const long =
    "The lighthouse keeper rose before dawn and walked the long path down to " +
    "the water, where the boards were shakey underfoot and the rope had frayed " +
    "against the post for years without anyone thinking to replace it.";
  const at = long.indexOf("shakey");
  const xml = doc(
    `<w:p>${run(long.slice(0, at))}${run("shakey", "<w:i/>")}${run(long.slice(at + 6))}</w:p>`,
  );
  const r = edit(xml, 0, [
    { start: at - 4, end: at + 16, replacement: "were shaky under it" },
  ]);

  assert.equal(r.skipped.length, 1);
  const s = r.skipped[0];
  assert.ok(s.context, "a skipped edit must say where it belongs");
  assert.ok(
    s.context.includes(s.original),
    "the context must contain the text being replaced",
  );
  assert.ok(
    s.context.length < long.length,
    "context is an excerpt, not the whole paragraph",
  );
  assert.match(s.context, /^…/, "an excerpt from mid-paragraph is marked as one");
  assert.match(s.context, /…$/);
});

test("a short paragraph is quoted whole, with no ellipses", () => {
  const xml = doc(`<w:p>${run("She was ")}${run("certain", "<w:i/>")}${run(" of it.")}</w:p>`);
  const r = edit(xml, 0, [
    { start: 0, end: 22, replacement: "He felt sure about it." },
  ]);
  assert.equal(r.skipped[0].context, "She was certain of it.");
});
