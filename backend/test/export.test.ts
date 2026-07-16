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
