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

test("a block quotation — one open, one close, paragraphs between — is NOT flagged", async () => {
  // The other convention for a quotation across paragraphs: a legend read
  // aloud, opened once and closed once, with nothing on the paragraphs
  // between. Read paragraph by paragraph this was two findings on a
  // manuscript that was right.
  const body =
    `${PROSE}\n\n` +
    `“This era we call the Old Wars, and it was a time which brought us all to the brink of extinction.\n\n` +
    `They channeled their energy into the ground, binding their power to two metals. One black and one white.\n\n` +
    `As a last act, the power wielders tore the very world into pieces, letting the sea separate the land into islands.”\n\n` +
    `She closed the book.`;
  const f = truncations(body).filter((x) => /quotation/i.test(x.message));
  assert.deepEqual(f, [], JSON.stringify(f));
});

test("a block quotation opened mid-paragraph is NOT flagged either", async () => {
  const body =
    `${PROSE}\n\n` +
    `The page read: “This era we call the Old Wars.\n\n` +
    `They channeled their energy into the ground.\n\n` +
    `The sea separated the land into islands.”\n\n` +
    `She closed the book.`;
  const f = truncations(body).filter((x) => /quotation/i.test(x.message));
  assert.deepEqual(f, [], JSON.stringify(f));
});

test("a quote left open when other speech begins is still caught", async () => {
  // Carrying the open quote must not hide a real miss: the next line of
  // dialogue is not the end of a block quotation.
  const body =
    `${PROSE}\n\n` +
    `Aaron shrugged. “We can try.\n\n` +
    `“Fine,” she said.\n\n` +
    `They went.`;
  const f = truncations(body).filter((x) => /quotation/i.test(x.message));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].message, /Aaron shrugged/);
});

test("a block quotation never closed is reported at its opening", async () => {
  const body =
    `${PROSE}\n\n` +
    `“This era we call the Old Wars.\n\n` +
    `They channeled their energy into the ground.\n\n` +
    `She closed the book.`;
  const f = truncations(body).filter((x) => /quotation/i.test(x.message));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].message, /Old Wars/);
});

// ── Quote conventions other than English ──
//
// The balance check counted “ and ” and nothing else, which on a French
// manuscript meant it found no quotation marks at all and passed every chapter
// in silence, and on a German one meant every „…“ line read as two openers and
// no closer. The convention is now read off the manuscript.

import { detectQuoteFamily } from "../src/publicationScan.ts";

test("the quote family is read off the manuscript, not assumed", () => {
  assert.deepEqual(detectQuoteFamily("“We can try,” he said."), { open: "“", close: "”" });
  assert.deepEqual(detectQuoteFamily("« On peut essayer », dit-il."), { open: "«", close: "»" });
  assert.deepEqual(detectQuoteFamily("„Wir können es versuchen“, sagte er."), { open: "„", close: "“" });
  // Narration with no dialogue at all falls back to the English pair rather
  // than throwing or picking at random.
  assert.deepEqual(detectQuoteFamily(PROSE), { open: "“", close: "”" });
});

test("balanced French guillemets are not reported", () => {
  const french = `${PROSE}\n\n« Tu ne dors jamais », dit sa sœur.\n\n« Je dors », répondit-elle. « Un peu. »`;
  assert.deepEqual(truncations(french), [], "correct French dialogue is not a finding");
});

test("an unclosed French guillemet IS reported", () => {
  const french = `${PROSE}\n\n« Tu ne dors jamais, dit sa sœur.\n\nLe jour se levait sur les toits.`;
  const f = truncations(french);
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].message, /Unbalanced quotation marks/);
});

test("balanced German quotes are not reported", () => {
  // „…“ closes with the character English opens with, so this is the case that
  // decides the family by its opener rather than by counting both marks.
  const german = `${PROSE}\n\n„Du schläfst nie“, sagte ihre Schwester.\n\n„Ich schlafe“, antwortete sie.`;
  assert.deepEqual(truncations(german), [], "correct German dialogue is not a finding");
});
