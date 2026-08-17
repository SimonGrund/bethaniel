// A proofread agent emitted 357 correction lines of which 8 were distinct, the
// tail repeating one no-op ({"original": X, "corrected": X}) until it hit the
// 8192-token ceiling — 34 seconds and ~8k tokens, billed, for nothing.
//
// The corrections themselves were harmless: no-ops are dropped downstream. The
// waste was all in generating them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { stopOnRepeatedLines } from "../src/llm.ts";

async function* emit(chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c;
}

async function collect(src: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const t of src) out += t;
  return out;
}

const LINE = '{"original": "the attack will come", "corrected": "the attack will come"}';

test("a line repeating over and over cuts the stream", async () => {
  const out = await collect(
    stopOnRepeatedLines(emit(Array.from({ length: 50 }, () => LINE + "\n"))),
  );
  const lines = out.split("\n").filter(Boolean);
  assert.ok(lines.length < 10, `kept ${lines.length} copies of one line`);
});

test("everything before the loop is kept", async () => {
  const good = [
    '{"original": "teh", "corrected": "the"}',
    '{"original": "recieve", "corrected": "receive"}',
    '{"original": "alot", "corrected": "a lot"}',
  ];
  const out = await collect(
    stopOnRepeatedLines(
      emit([...good.map((g) => g + "\n"), ...Array(30).fill(LINE + "\n")]),
    ),
  );
  for (const g of good) assert.ok(out.includes(g), `lost a real correction: ${g}`);
});

test("distinct corrections are never cut, however many", async () => {
  const many = Array.from(
    { length: 60 },
    (_, i) => `{"original": "word${i}", "corrected": "Word${i}"}\n`,
  );
  const out = await collect(stopOnRepeatedLines(emit(many)));
  assert.equal(out.split("\n").filter(Boolean).length, 60);
});

test("a repeat far from its twin does not count as a loop", async () => {
  // The same correction can legitimately appear twice in a chunk; downstream
  // dedup handles that. Only an unbroken run is a loop.
  const mixed: string[] = [];
  for (let i = 0; i < 20; i++) {
    mixed.push(`{"original": "a${i}", "corrected": "A${i}"}\n`);
    mixed.push(LINE + "\n");
  }
  const out = await collect(stopOnRepeatedLines(emit(mixed)));
  assert.ok(
    out.split("\n").filter(Boolean).length >= 30,
    "alternating lines were mistaken for a loop",
  );
});

test("tokens arrive as they are produced, not buffered to the end", async () => {
  // The UI streams these; holding them back would stall the progress display.
  const src = stopOnRepeatedLines(emit(['{"original": "a", ', '"corrected": "b"}\n']));
  const first = await src.next();
  assert.equal(first.value, '{"original": "a", ');
});
