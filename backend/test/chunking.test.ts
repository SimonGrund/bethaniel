// ── Chunk overlap is only what was actually carried over ──
//
// A chunk opens with overlap paragraphs — the end of the previous chunk, as
// context — only when the previous chunk was cut for size. A top heading
// starts a fresh chunk with none. Both flushes used to assume the overlap was
// there anyway, so after a heading the chunk's first real paragraph was taken
// for context: left out of `core` and stripped from the model's answer. Seen
// on a real translation of a contract: "## 1. Scope", right under the title,
// never reached the German.

import { test } from "node:test";
import assert from "node:assert/strict";

import { splitIntoChunks, stripOverlapFromResponse } from "../src/chunking.ts";

const words = (n: number, w = "word") => Array.from({ length: n }, () => w).join(" ");

test("a chunk started by a heading carries no overlap", () => {
  const text = `# Agreement\n\n## 1. Scope\n\n${words(30)}\n\n${words(30)}`;
  const chunks = splitIntoChunks(text, 2000, 1);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].overlapHeadParagraphs, 0);
  assert.ok(chunks[1].core.startsWith("## 1. Scope"));
  // And the heading survives the response being trimmed.
  const response = chunks[1].body.replace("1. Scope", "1. Geltungsbereich");
  assert.match(stripOverlapFromResponse(response, chunks[1].overlapHeadParagraphs), /^## 1\. Geltungsbereich/);
});

test("a heading-started chunk that is cut for size carries no overlap either", () => {
  const text = `# A\n\n## B\n\n${words(60, "one")}\n\n${words(60, "two")}\n\n${words(60, "three")}`;
  const chunks = splitIntoChunks(text, 100, 1);
  const b = chunks.find((c) => c.body.startsWith("## B"))!;
  assert.equal(b.overlapHeadParagraphs, 0);
  assert.ok(b.core.startsWith("## B"));
});

test("a chunk that follows a size cut still opens with its overlap", () => {
  const text = `${words(60, "one")}\n\n${words(60, "two")}\n\n${words(60, "three")}`;
  const chunks = splitIntoChunks(text, 100, 1);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].overlapHeadParagraphs, 1);
  assert.ok(chunks[1].body.startsWith("two"));
  assert.ok(chunks[1].core.startsWith("three"));
});

test("a size cut just before a heading does not repeat the last paragraph", () => {
  const text = `${words(60, "aaa")}\n\n${words(60, "bbb")}\n\n## Chapter 2\n\n${words(30, "ccc")}`;
  const chunks = splitIntoChunks(text, 100, 1);
  const cores = chunks.map((c) => c.core).join("\n\n");
  assert.equal((cores.match(/bbb/g) ?? []).length, 60, "every paragraph once");
  assert.ok(chunks.at(-1)!.core.startsWith("## Chapter 2"));
});

test("however the text is cut, the cores put together are the text", () => {
  const paras = Array.from({ length: 30 }, (_, i) => (i % 7 === 3 ? `## Part ${i}` : words(15 + (i % 5) * 10, `p${i}`)));
  const text = paras.join("\n\n");
  for (const target of [20, 50, 120, 400]) {
    const joined = splitIntoChunks(text, target, 1).map((c) => c.core).join("\n\n");
    assert.equal(joined, text, `target ${target}`);
  }
});
