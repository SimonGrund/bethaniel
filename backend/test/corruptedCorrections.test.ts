// llama-server occasionally detokenizes to a genuinely invalid UTF-8 byte
// sequence — observed reproducibly on Qwen3.5-4B/9B and Mistral-Small-3.2
// GGUFs, almost always on German ä/ö/ü/ß — and silently substitutes U+FFFD
// when it serializes the SSE JSON response. Raw-byte capture confirmed the
// replacement character is already present on the wire, not introduced by
// our own decoding, so the original text is unrecoverable by the time it
// reaches parseCorrectionsJson. The only sound move is to drop the
// correction rather than show a user a garbled "→ Ma�" suggestion.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCorrectionsJson } from "../src/llm.ts";

test("a correction whose corrected field contains U+FFFD is dropped", () => {
  const raw = [
    '{"original": "mal", "corrected": "Ma�"}',
    '{"original": "teh cat", "corrected": "the cat"}',
  ].join("\n");
  const cs = parseCorrectionsJson(raw);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].original, "teh cat");
});

test("a correction whose original field contains U+FFFD is dropped", () => {
  const raw = '{"original": "gro�e", "corrected": "große"}';
  assert.deepEqual(parseCorrectionsJson(raw), []);
});

test("clean German corrections with real umlauts are unaffected", () => {
  const raw = '{"original": "alter", "corrected": "älter"}';
  const cs = parseCorrectionsJson(raw);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "älter");
});

test("the legacy corrections-array shape also drops replacement-char entries", () => {
  const raw = JSON.stringify({
    corrections: [
      { original: "mal", corrected: "Ma�" },
      { original: "teh", corrected: "the" },
    ],
  });
  const cs = parseCorrectionsJson(raw);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].original, "teh");
});

test("the regex-extraction fallback also drops replacement-char entries", () => {
  // Malformed enough that the JSON parsers above all fail, forcing the
  // last-resort regex scan — still must not surface a corrupted entry.
  const raw =
    'not valid json but contains {"original": "mal", "corrected": "Ma�"} ' +
    'and {"original": "teh", "corrected": "the"} embedded';
  const cs = parseCorrectionsJson(raw);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].original, "teh");
});
