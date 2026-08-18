// The truncation and quote checks, against what real manuscripts actually look
// like. Both cases here come from a live book:
//
//   - a chapter ending "…_This doesn't make any sense…_" was reported as
//     truncated, because the last CHARACTER is an italic marker
//   - two unbalanced-quote findings were correct but unverifiable, because the
//     message named the chapter and nothing else

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPublicationScan } from "../src/publicationScan.ts";

const PROSE = Array.from(
  { length: 40 },
  (_, i) => `Paragraph ${i} of ordinary prose that carries the chapter along.`,
).join("\n\n");

function scan(body: string, name = "Chapter one") {
  return buildPublicationScan([{ name, original: body }] as never);
}

function truncations(body: string) {
  return scan(body).findings.filter((f) => f.check === "truncation");
}

test("a chapter ending in italics is not reported as truncated", async () => {
  const f = truncations(`${PROSE}\n\nShe rolled onto her side. _This doesn't make any sense…_`);
  assert.deepEqual(f, [], JSON.stringify(f));
});

test("a chapter ending in a closing quote is not reported as truncated", async () => {
  const f = truncations(`${PROSE}\n\n“We can try,” he said.”`);
  assert.equal(
    f.filter((x) => /terminal punctuation/.test(x.message)).length,
    0,
  );
});

test("a chapter ending mid-sentence is still reported", async () => {
  const f = truncations(`${PROSE}\n\nShe rolled onto her side and then`);
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].message, /terminal punctuation/);
});

test("an unclosed quote is reported WITH the passage it is in", async () => {
  // Verbatim shape of the real finding: a quote opened and never closed, with
  // narration following rather than continued speech.
  const body = `${PROSE}\n\nAaron shrugged. “We can try.\n\nBack at the Golden Kettle, Aaron sat down heavily.`;
  const f = truncations(body).filter((x) => /quotation/i.test(x.message));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(
    f[0].message,
    /Aaron shrugged/,
    "the finding must quote the passage so it can be checked",
  );
});

test("a quote closed with an opening mark is caught", async () => {
  const body = `${PROSE}\n\n“We were outnumbered. We couldn't do anything.“\n\nA tear rolled down her face.`;
  const f = truncations(body).filter((x) => /quotation/i.test(x.message));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].message, /outnumbered/);
});

test("speech continued across paragraphs is NOT flagged", async () => {
  // The standard convention: each paragraph of continued speech opens with a
  // quote and only the last one closes. Flagging it would fire on every novel
  // with a long speech in it.
  const body =
    `${PROSE}\n\n` +
    `“I have been thinking about the harbour for a long time now.\n\n` +
    `“And I have decided that we should go,” she said.`;
  const f = truncations(body).filter((x) => /quotation/i.test(x.message));
  assert.deepEqual(f, [], JSON.stringify(f));
});
