import { test } from "node:test";
import assert from "node:assert/strict";
import { dropNonProseEdits, tableParagraphTexts } from "../src/nonProse.ts";

const c = (original: string, corrected: string, reason?: string) => ({ original, corrected, reason });

test("a suggestion inside a Word contents page is left alone", () => {
  const text = [
    "Contents",
    "[Chapter 1 The Harbour 5](#_Toc1)",
    "[Chapter 2 Teh Storm 17](#_Toc2)",
    "[Chapter 3 Morning 29](#_Toc3)",
    "She walked to teh harbour.",
  ].join("\n\n");
  const r = dropNonProseEdits([c("Teh Storm", "The Storm"), c("teh harbour", "the harbour")], text, new Set());
  assert.deepEqual(r.kept.map((k) => k.original), ["teh harbour"]);
  assert.equal(r.dropped.length, 1);
});

test("a contents page typed by hand, with leader dots, is not prose", () => {
  const text = "Prologue ........ 1\n\nThe Harbor ...... 5\n\nThe Storm ....... 17\n\nIt was late.";
  const r = dropNonProseEdits([c("Harbor", "Harbour")], text, new Set());
  assert.equal(r.kept.length, 0);
});

test("one line ending in a number is ordinary prose", () => {
  const text = "He went to Room 101\n\nIt was cold.";
  const r = dropNonProseEdits([c("Room 101", "room 101")], text, new Set());
  assert.equal(r.kept.length, 1);
});

test("table cells are left alone, and a phrase also in prose is kept", () => {
  const md = "Cast\n\nMother\n\nThe widwo\n\nThe widwo came home.";
  const map = [
    { docxParaIndex: 0, mdStart: 0, mdEnd: 4, mappable: true },
    { docxParaIndex: 1, mdStart: 6, mdEnd: 12, mappable: false },
    { docxParaIndex: 2, mdStart: 14, mdEnd: 23, mappable: false },
  ];
  const cells = new Set(tableParagraphTexts(md, map));
  assert.deepEqual([...cells], ["Mother", "The widwo"]);
  const r = dropNonProseEdits([c("Mother", "mother"), c("widwo", "widow")], md, cells);
  assert.deepEqual(r.kept.map((k) => k.original), ["widwo"]);
});

test("the author's own rules apply in a table too", () => {
  const r = dropNonProseEdits([c("Mother", "Mum", "house-style")], "Mother", new Set(["Mother"]));
  assert.equal(r.kept.length, 1);
});
