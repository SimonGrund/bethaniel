// RTF text, located and rewritten in place (rtfText.ts).
//
// The fixtures at the top are byte-for-byte what Scrivener 3.1 for Windows
// wrote for three scenes of a test project. The rule pinned hardest is the
// one the .docx export lives by: an edit changes the text it names and not
// one byte of formatting.

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeRtfText, indexRtf, rewriteRtf } from "../src/rtfText.ts";

const HEAD =
  "{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0\r\n" +
  "{\\fonttbl{\\f0\\fmodern\\fcharset0\\fprq2 SitkaText;}}\r\n" +
  "{\\colortbl;\\red0\\green0\\blue0;\\red255\\green255\\blue255;\\red128\\green128\\blue128;}\r\n" +
  "\\paperw12240\\paperh15840\\margl1800\\margr1800\\margt1440\\margb1440\\f0\\fs24\\cf0\r\n" +
  "\\pard\\plain \\tx0\\tx360\\tx720\\tx1080\\tx1440\\tx1800\\tx2160\\tx2880\\tx3600\\tx4320\\fi360\\ltrch\\loch ";

const SCENE_1 = HEAD + "{\\f0\\fs24\\b0\\i0 This is scene 1. People will be fighting and magic will be flying.}}";
const SCENE_2 =
  HEAD +
  "{\\f0\\fs24\\b0\\i0 And now the world is introduced\\loch\\af0\\hich\\af0\\dbch\\af0\\uc1\\u8230\\'85\\line \\line }}";
const SCENE_3 = HEAD + "{\\f0\\fs24\\b0\\i0 Welcoem to chapter 2!}}";

test("Scrivener's scene reads as its text, with nothing from the font or colour tables", () => {
  const ps = indexRtf(SCENE_1);
  assert.equal(ps.length, 1);
  assert.equal(ps[0].text, "This is scene 1. People will be fighting and magic will be flying.");
});

test("escapes decode: \\u8230 with its fallback is one ellipsis, \\line a line break", () => {
  const ps = indexRtf(SCENE_2);
  assert.equal(ps[0].text, "And now the world is introduced…\n\n");
});

test("a typo is fixed and every other byte is left as it was", () => {
  const { rtf, applied, skipped } = rewriteRtf(SCENE_3, [
    { paragraphIndex: 0, start: 0, end: 7, replacement: "Welcome" },
  ]);
  assert.equal(applied, 1);
  assert.deepEqual(skipped, []);
  assert.equal(rtf, SCENE_3.replace("Welcoem", "Welcome"));
});

test("text with non-ASCII characters is written as \\u escapes", () => {
  const { rtf } = rewriteRtf(SCENE_3, [
    { paragraphIndex: 0, start: 0, end: 7, replacement: "Velkommen — til" },
  ]);
  assert.ok(rtf.includes("Velkommen \\u8212? til to chapter 2!"), rtf);
  assert.equal(indexRtf(rtf)[0].text, "Velkommen — til to chapter 2!");
});

test("an edit across a formatting change is refused, not guessed", () => {
  // "introduced" and "…" are separate stretches: Scrivener switches font
  // codes between them.
  const { rtf, applied, skipped } = rewriteRtf(SCENE_2, [
    { paragraphIndex: 0, start: 21, end: 32, replacement: "introduced..." },
  ]);
  assert.equal(applied, 0);
  assert.equal(skipped[0].reason, "spans-formatting");
  assert.equal(rtf, SCENE_2);
});

test("an edit inside the escaped stretch keeps the escape equivalent", () => {
  const ps = indexRtf(SCENE_2);
  const at = ps[0].text.indexOf("world");
  const { rtf } = rewriteRtf(SCENE_2, [
    { paragraphIndex: 0, start: at, end: at + 5, replacement: "realm" },
  ]);
  assert.equal(indexRtf(rtf)[0].text, "And now the realm is introduced…\n\n");
});

test("italic text is its own stretch, editable inside, its markers untouched", () => {
  const src = "{\\rtf1\\ansi\\uc1 She said {\\i nevr} again.\\par Next.}";
  const ps = indexRtf(src);
  assert.deepEqual(ps.map((p) => p.text), ["She said never again.".replace("never", "nevr"), "Next."]);
  const at = ps[0].text.indexOf("nevr");
  const { rtf } = rewriteRtf(src, [{ paragraphIndex: 0, start: at, end: at + 4, replacement: "never" }]);
  assert.equal(rtf, "{\\rtf1\\ansi\\uc1 She said {\\i never} again.\\par Next.}");
});

test("footnotes and ignorable destinations are not body text", () => {
  const src =
    "{\\rtf1\\ansi\\uc1 Text{\\super\\chftn}{\\footnote\\pard {\\super\\chftn} A note.} more.{\\*\\Scrv_annot hidden}}";
  assert.equal(indexRtf(src)[0].text, "Text more.");
});

test("braces and backslashes in new text are escaped", () => {
  assert.equal(encodeRtfText("a{b}c\\d", 1), "a\\{b\\}c\\\\d");
});

test("with \\uc0 an escape is ended by a space, not a fallback character", () => {
  assert.equal(encodeRtfText("é", 0), "\\u233 ");
  assert.equal(encodeRtfText("é", 1), "\\u233?");
});

test("new text starting with a digit cannot join a control word's number", () => {
  const src = "{\\rtf1\\ansi\\uc1 {\\b0This apple}}";
  const { rtf } = rewriteRtf(src, [{ paragraphIndex: 0, start: 0, end: 4, replacement: "5" }]);
  assert.equal(indexRtf(rtf)[0].text, "5 apple");
});

test("a new line in the replacement is refused", () => {
  const { applied, skipped } = rewriteRtf(SCENE_3, [
    { paragraphIndex: 0, start: 0, end: 7, replacement: "Welcome\n" },
  ]);
  assert.equal(applied, 0);
  assert.equal(skipped[0].reason, "new-line");
});

test("two edits in one stretch are both applied", () => {
  const text = indexRtf(SCENE_1)[0].text;
  const a = text.indexOf("People");
  const b = text.indexOf("magic");
  const { rtf } = rewriteRtf(SCENE_1, [
    { paragraphIndex: 0, start: a, end: a + 6, replacement: "Folk" },
    { paragraphIndex: 0, start: b, end: b + 5, replacement: "spells" },
  ]);
  assert.equal(indexRtf(rtf)[0].text, "This is scene 1. Folk will be fighting and spells will be flying.");
});
