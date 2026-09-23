// A straight mark among curly ones is a house-style inconsistency, not
// evidence the text is cut off — so it is its own check, not another
// truncation finding.
//
// All five defects the scan missed on two real manuscripts were this: a curly
// opener closed by a straight mark. They are BALANCED, so no balance check
// can ever find them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPublicationScan } from "../src/publicationScan.ts";

const NARRATION = Array.from(
  { length: 20 },
  (_, i) => `Paragraph ${i} of ordinary narration carrying the chapter along.`,
).join("\n\n");

function styleFindings(body: string, quoteStyle?: "curly" | "straight") {
  const report = buildPublicationScan(
    [{ name: "Chapter one", original: body }] as never,
    quoteStyle ? ({ quoteStyle } as never) : undefined,
  );
  return report.findings.filter((f) => f.check === "quote_style");
}

const CURLY_DIALOGUE = "“Yes,” she said. “No,” he answered. “Maybe,” they said.";

test("a straight closing mark in a curly book is reported", () => {
  const found = styleFindings(
    [NARRATION, CURLY_DIALOGUE, '“But—"', NARRATION].join("\n\n"),
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /But—/);
});

test("the finding names the chapter and carries the passage", () => {
  const found = styleFindings(
    [NARRATION, CURLY_DIALOGUE, '“I hope it won’t get boring for you."'].join(
      "\n\n",
    ),
  );
  assert.equal(found[0].location, "Chapter one");
  assert.match(found[0].message, /I hope it won’t get boring/);
});

test("a consistently straight book is left alone", () => {
  const body = [NARRATION, '"Yes," she said. "No," he answered. "Maybe."'].join(
    "\n\n",
  );
  assert.equal(styleFindings(body).length, 0);
});

test("a consistently curly book is left alone", () => {
  assert.equal(styleFindings([NARRATION, CURLY_DIALOGUE].join("\n\n")).length, 0);
});

test("the declared style decides, not the majority", () => {
  // Mostly curly, but the author says the book is straight. Then it is the
  // curly marks that are off-style.
  const body = [NARRATION, CURLY_DIALOGUE, '"Fine," he said.'].join("\n\n");
  const found = styleFindings(body, "straight");
  assert.ok(found.length >= 1);
  assert.match(found[0].message, /Yes/);
});

test("an evenly mixed book with no declared style reports nothing", () => {
  // Nothing to conform to. Reporting half the book's dialogue as off-style
  // would be a guess, and the settings panel asks the author instead.
  const body = [
    NARRATION,
    "“Yes,” she said. “No,” he answered.",
    '"Yes," she said. "No," he answered.',
  ].join("\n\n");
  assert.equal(styleFindings(body).length, 0);
});

test("apostrophes are never reported", () => {
  const body = [NARRATION, CURLY_DIALOGUE, "It’s Bria’s, he said."].join("\n\n");
  assert.equal(styleFindings(body).length, 0);
});
