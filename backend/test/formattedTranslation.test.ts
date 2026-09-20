// ── A translation must survive a manuscript that has italics in it ──
//
// Every docx fixture in this suite until now came from markdownToDocx, where
// all runs share one rPr — so `mixed-formatting` could never fire and a whole
// class of failure was invisible. A real manuscript has emphasis in it, and a
// translation replaces the whole paragraph, so the replacement spans runs whose
// formatting differs. Refusing that leaves the paragraph in the SOURCE
// LANGUAGE, which is how a customer came to be handed a French translation
// whose body was still English.
//
// The rule these pin: a whole-paragraph replacement collapses to the
// paragraph's first formatting rather than being refused, and says so, because
// losing one italic word is a far smaller harm than losing the translation.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import JSZip from "jszip";

import { docxToMarkdownMapped } from "../src/conversion.ts";
import { indexDocumentXml, rewriteDocxText } from "../src/docxSurgery.ts";
import { remapChaptersToParagraphEdits } from "../src/docxRemap.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FORMATTED = path.join(
  REPO,
  "sample_texts",
  "two_chapters_english_with_formatting.docx",
);

const FR = ["le", "gardien", "du", "phare", "écrivit", "une", "lettre", "à", "sa", "fille"];

/** Replace every line with target-language prose of the same word count. */
function translate(md: string): string {
  return md
    .split("\n")
    .map((ln) => {
      if (!ln.trim()) return ln;
      if (/^#/.test(ln)) return "# Chapitre";
      const n = ln.split(/\s+/).filter(Boolean).length;
      return Array.from({ length: n }, (_, i) => FR[i % FR.length]).join(" ") + ".";
    })
    .join("\n");
}

async function translateFormattedDocx() {
  const input = fs.readFileSync(FORMATTED);
  const { md, paragraphMap } = await docxToMarkdownMapped(input);
  const xml =
    (await (await JSZip.loadAsync(input)).file("word/document.xml")?.async("string")) ?? "";
  const index = indexDocumentXml(xml);
  const { edits } = remapChaptersToParagraphEdits(md, paragraphMap, index, [
    { original: md, edited: translate(md) },
  ]);
  const result = await rewriteDocxText(input, edits);
  const outXml =
    (await (await JSZip.loadAsync(result.buffer)).file("word/document.xml")?.async("string")) ?? "";
  return { ...result, out: indexDocumentXml(outXml) };
}

/** Words that only appear in the English source. */
const ENGLISH = /\b(the|she|her|and|was|had|lighthouse|grandfather|climbed)\b/i;

test("the fixture really does contain mixed formatting", async () => {
  // If this ever stops being true the other tests below prove nothing, and
  // would pass for the wrong reason.
  const input = fs.readFileSync(FORMATTED);
  const xml =
    (await (await JSZip.loadAsync(input)).file("word/document.xml")?.async("string")) ?? "";
  const index = indexDocumentXml(xml);
  const mixed = index.paragraphs.filter(
    (p) => new Set(p.nodes.filter((n) => n.kind !== "virtual").map((n) => n.rPrXml)).size > 1,
  );
  assert.ok(mixed.length > 0, "fixture has no mixed-formatting paragraph to test with");
});

test("no paragraph is left in the source language", async () => {
  const { out } = await translateFormattedDocx();
  const stuck = out.paragraphs
    .map((p) => p.text.trim())
    .filter((t) => t && ENGLISH.test(t));
  assert.deepEqual(
    stuck,
    [],
    `left untranslated:\n${stuck.map((s) => `  - ${s.slice(0, 80)}`).join("\n")}`,
  );
});

test("a mixed-formatting paragraph is no longer refused", async () => {
  const { skipped } = await translateFormattedDocx();
  const mixed = skipped.filter((s) => s.reason === "mixed-formatting");
  assert.deepEqual(mixed, [], "a whole-paragraph replacement was refused for formatting");
});

test("the author is told how many paragraphs lost their emphasis", async () => {
  // Collapsing is a real loss, quietly done. It must be reportable, or the
  // author finds out by reading their own book.
  const { flattened } = await translateFormattedDocx();
  assert.ok(
    typeof flattened === "number" && flattened > 0,
    "rewriteDocxText did not report any flattened paragraphs",
  );
});

test("an ordinary correction spanning mixed formatting is STILL refused", async () => {
  // The relaxation is only for a whole-paragraph replacement. A correction
  // must not silently restyle an italic word — that is the guarantee the
  // surgical export exists for.
  const input = fs.readFileSync(FORMATTED);
  const xml =
    (await (await JSZip.loadAsync(input)).file("word/document.xml")?.async("string")) ?? "";
  const index = indexDocumentXml(xml);
  const mixed = index.paragraphs.find(
    (p) => new Set(p.nodes.filter((n) => n.kind !== "virtual").map((n) => n.rPrXml)).size > 1,
  );
  assert.ok(mixed, "no mixed-formatting paragraph in fixture");
  const { skipped, applied } = await rewriteDocxText(input, [
    {
      paragraphIndex: mixed.index,
      start: 0,
      end: mixed.text.length,
      replacement: "a correction that spans the whole paragraph",
      // deliberately NOT wholeParagraph
    },
  ]);
  assert.equal(applied, 0);
  assert.equal(skipped[0]?.reason, "mixed-formatting");
});
