// Tests for the markdown → HTML export renderer (mdToHtml), which feeds both
// the DOCX exporter (html-to-docx) and the EPUB builder. The lone-"#" case is
// a real manuscript convention: "#" on its own line is a minor section break
// (smaller than a *** scene break) and must export as a real empty line, not
// a literal "#" paragraph.

import { test } from "node:test";
import assert from "node:assert/strict";

import { mdToHtml, DEFAULT_DOCX_EXPORT_OPTIONS } from "../src/conversion.ts";
import { SCENE_BREAK_MARKER } from "../src/sceneBreaks.ts";

const render = (md: string) => mdToHtml(md, DEFAULT_DOCX_EXPORT_OPTIONS);

// ── lone "#" minor section break ──

test('lone "#" renders as an empty paragraph, not a literal #', () => {
  const html = render("First scene.\n\n#\n\nSecond scene.");
  assert.ok(!html.includes(">#<"), `literal # leaked into export: ${html}`);
  // html-to-docx drops truly empty <p>s, so the blank line is an nbsp
  // paragraph (&#160; — numeric so EPUB XHTML parses it too).
  assert.ok(html.includes(">&#160;</p>"), `no empty-line paragraph: ${html}`);
});

test('lone "#" with surrounding whitespace still counts as a minor break', () => {
  const html = render("First.\n\n  #  \n\nSecond.");
  assert.ok(!html.includes(">#<"));
  assert.ok(html.includes(">&#160;</p>"));
});

test('lone "#" flushes the open paragraph before the break', () => {
  const html = render("First.\n#\nSecond.");
  const lines = html.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("First."));
  assert.ok(lines[1].includes("&#160;"));
  assert.ok(lines[2].includes("Second."));
});

// ── existing behaviour preserved ──

test('"# Title" still renders as an h1 heading', () => {
  const html = render("# Chapter One\n\nText.");
  assert.ok(html.includes("<h1"));
  assert.ok(html.includes("Chapter One"));
});

test("scene break markers still render as centered dividers", () => {
  for (const marker of [SCENE_BREAK_MARKER, "***", "* * *"]) {
    const html = render(`Before.\n\n${marker}\n\nAfter.`);
    assert.ok(
      html.includes("* * *"),
      `scene break lost for marker ${JSON.stringify(marker)}: ${html}`,
    );
  }
});

test('"#" inside paragraph text is untouched', () => {
  const html = render("She was #1 in her class.");
  assert.ok(html.includes("She was #1 in her class."));
});

// ── blank-line section breaks ──
// The DOCX importer preserves an empty Word paragraph as an extra blank line
// ("\n\n\n"), the author's soft section break. The exporter must round-trip
// it back to an empty paragraph instead of collapsing it into an ordinary
// paragraph boundary.

test("a double blank line exports as an empty paragraph", () => {
  const html = render("He flashed a forced smile.\n\n\nAaron blinked.");
  const lines = html.split("\n");
  assert.equal(lines.length, 3, html);
  assert.ok(lines[0].includes("forced smile."));
  assert.ok(lines[1].includes("&#160;"));
  assert.ok(lines[2].includes("Aaron blinked."));
});

test("each extra blank line beyond the first adds one empty paragraph", () => {
  const html = render("One.\n\n\n\nTwo.");
  const empty = html.split("\n").filter((ln) => ln.includes("&#160;"));
  assert.equal(empty.length, 2, html);
});

test("a single blank line stays a plain paragraph separator", () => {
  const html = render("One.\n\nTwo.");
  assert.ok(!html.includes("&#160;"), html);
});

test("leading and trailing blank lines produce no empty paragraphs", () => {
  const html = render("\n\n\nOnly paragraph.\n\n\n");
  assert.ok(!html.includes("&#160;"), html);
  assert.equal(html.split("\n").length, 1);
});

// ── emphasis rendering ──
// html-to-docx (1.8) styles <i>/<b>/<strong> but silently drops <em> — every
// italic exported as <em> becomes a plain unstyled run in the .docx. The
// renderer must therefore never emit <em>.

test("italics render as <i>, never <em>", () => {
  for (const md of ["He said *hello* there.", "He said _hello_ there."]) {
    const html = render(md);
    assert.ok(html.includes("<i>hello</i>"), html);
    assert.ok(!html.includes("<em>"), `<em> is dropped by html-to-docx: ${html}`);
  }
});

test("bold renders as <strong>", () => {
  assert.ok(render("A **bold** word.").includes("<strong>bold</strong>"));
  assert.ok(render("A __bold__ word.").includes("<strong>bold</strong>"));
});

test("bold-italic renders well-nested (<b><i>…</i></b>)", () => {
  const html = render("A ***warning*** here.");
  assert.ok(html.includes("<b><i>warning</i></b>"), html);
});

test("italic span with adjacent punctuation and curly quotes", () => {
  const html = render("he said *“hi”*, then *left*.");
  assert.ok(html.includes("<i>“hi”</i>"), html);
  assert.ok(html.includes("<i>left</i>."), html);
});

test("intra-word underscores are not emphasis", () => {
  const html = render("the file_name_here variable");
  assert.ok(!html.includes("<i>"), html);
  assert.ok(html.includes("file_name_here"), html);
});

test("spaced asterisks are not emphasis", () => {
  const html = render("5 * 3 * 2 equals 30");
  assert.ok(!html.includes("<i>"), html);
  assert.ok(html.includes("5 * 3 * 2 equals 30"), html);
});

test("unbalanced asterisk stays literal", () => {
  const html = render("an unbalanced * asterisk");
  assert.ok(!html.includes("<i>"), html);
  assert.ok(html.includes("an unbalanced * asterisk"), html);
});

test("a 4+-star divider line renders as a divider, not italics", () => {
  const html = render("Before.\n\n* * * *\n\nAfter.");
  assert.ok(!html.includes("<i>"), html);
  assert.ok(html.includes("* * *"), html);
});
