// ── Reading a translated paragraph's emphasis out of its Markdown ──
//
// The model preserves the emphasis markers it is given, and wraps the TARGET
// language's words in them — measured at 264 of 265 paragraphs on a real
// French translation. This is the half that reads them back out.
//
// Everything here is plain text in, plain data out: no docx, no runs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { foldSegments, splitEmphasis, visibleFormat } from "../src/emphasisSpans.ts";

test("plain text is one unemphasised piece", () => {
  assert.deepEqual(splitEmphasis("Just a sentence."), [
    { text: "Just a sentence.", emphasised: false },
  ]);
});

test("an emphasised phrase splits into three pieces", () => {
  assert.deepEqual(splitEmphasis("I said _love multiplies_ here."), [
    { text: "I said ", emphasised: false },
    { text: "love multiplies", emphasised: true },
    { text: " here.", emphasised: false },
  ]);
});

test("bold counts as emphasis too", () => {
  assert.deepEqual(splitEmphasis("A **bold** word."), [
    { text: "A ", emphasised: false },
    { text: "bold", emphasised: true },
    { text: " word.", emphasised: false },
  ]);
});

test("every marker style is recognised", () => {
  for (const md of ["a *x* b", "a _x_ b", "a **x** b", "a __x__ b", "a ***x*** b"]) {
    const pieces = splitEmphasis(md);
    assert.equal(pieces.length, 3, `not split: ${md}`);
    assert.deepEqual(pieces[1], { text: "x", emphasised: true }, `wrong middle: ${md}`);
  }
});

test("a paragraph that opens with emphasis has no empty piece before it", () => {
  // An empty leading piece would make the shape disagree with a docx whose
  // first run IS the emphasised one, and the whole paragraph would fall back.
  assert.deepEqual(splitEmphasis("_Ilse_ crossed the ice."), [
    { text: "Ilse", emphasised: true },
    { text: " crossed the ice.", emphasised: false },
  ]);
});

test("a paragraph that ends with emphasis has no empty piece after it", () => {
  assert.deepEqual(splitEmphasis("She whispered _Ilse_"), [
    { text: "She whispered ", emphasised: false },
    { text: "Ilse", emphasised: true },
  ]);
});

test("two emphasised phrases give five pieces", () => {
  const pieces = splitEmphasis("a _one_ b _two_ c");
  assert.equal(pieces.length, 5);
  assert.deepEqual(
    pieces.map((p) => p.emphasised),
    [false, true, false, true, false],
  );
});

test("adjacent emphasis does not produce an empty piece between them", () => {
  const pieces = splitEmphasis("_one__two_");
  assert.ok(
    pieces.every((p) => p.text.length > 0),
    `empty piece in ${JSON.stringify(pieces)}`,
  );
});

test("an underscore inside a word is not emphasis", () => {
  // snake_case in a manuscript is rare but a lone marker is not emphasis, and
  // treating it as such would split a word in half across two runs.
  assert.deepEqual(splitEmphasis("file_name here"), [
    { text: "file_name here", emphasised: false },
  ]);
});

test("an unclosed marker is left as text", () => {
  assert.deepEqual(splitEmphasis("a *dangling"), [
    { text: "a *dangling", emphasised: false },
  ]);
});

test("empty input gives no pieces at all", () => {
  assert.deepEqual(splitEmphasis(""), []);
  assert.deepEqual(splitEmphasis("   "), []);
});

// ── Formatting a reader cannot see is not emphasis ──
// Seen on a typeset book converted to Word: nearly every word was its own run
// with its own character spacing (w:spacing -2, 5, 10 …). Compared byte for
// byte, every paragraph looked like mixed formatting and nearly every word
// like an emphasised phrase — 458 "lost phrases" reported on one export.

test("runs that differ only in spacing, kerning or proofing language fold together", () => {
  const plain = (extra: string) => `<w:rPr><w:color w:val="231F20"/>${extra}</w:rPr>`;
  const segments = foldSegments([
    { kind: "t", text: "Håndbog i ", rPrXml: plain("") },
    { kind: "t", text: "psykologisk", rPrXml: plain('<w:spacing w:val="-2"/>') },
    { kind: "t", text: " ", rPrXml: plain('<w:spacing w:val="5"/><w:kern w:val="2"/>') },
    { kind: "t", text: "tryghed", rPrXml: plain('<w:lang w:val="da-DK"/><w:noProof/>') },
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, "Håndbog i psykologisk tryghed");
  assert.equal(visibleFormat(plain('<w:spacing w:val="-2"/>')), visibleFormat(plain("")));
});

test("italic, bold, colour and size are still emphasis", () => {
  const base = '<w:rPr><w:color w:val="231F20"/></w:rPr>';
  for (const other of [
    '<w:rPr><w:color w:val="231F20"/><w:i/></w:rPr>',
    '<w:rPr><w:color w:val="231F20"/><w:b/></w:rPr>',
    '<w:rPr><w:color w:val="7E9EA4"/></w:rPr>',
    '<w:rPr><w:color w:val="231F20"/><w:sz w:val="18"/></w:rPr>',
  ]) {
    assert.notEqual(visibleFormat(other), visibleFormat(base), other);
  }
});
