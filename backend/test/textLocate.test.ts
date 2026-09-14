// ── A correction is found in its chapter, whatever the model did to the quote ──
//
// The case that prompted this: a proofread correction quoted as
// "Twenty-two\nEmberMother's" — the chapter heading and the first word of
// the chapter, joined by one newline — against a manuscript that has a blank
// line between them. indexOf found nothing, so the review showed the bare
// fragment with no sentence around it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inTextOrder, locateInText } from "../../frontend/src/textLocate.ts";

const CHAPTER = `## Twenty-two

EmberMother's hand was cold. She said, “It's done,” and the fire went out. Petran read the verse twice.

The vaelfyre burned blue. Silverhnad — the name on the door — had slipped.
`;

test("a quote joined by one newline is found across the manuscript's blank line", () => {
  const found = locateInText("Twenty-two\nEmberMother's", CHAPTER);
  assert.ok(found, "found");
  assert.equal(CHAPTER.slice(found!.index, found!.index + found!.length), "Twenty-two\n\nEmberMother's");
});

test("straight quotes in the quote match curly quotes in the text, and vice versa", () => {
  const found = locateInText('She said, "It\'s done,"', CHAPTER);
  assert.ok(found);
  assert.equal(CHAPTER.slice(found!.index, found!.index + found!.length), "She said, “It's done,”");
});

test("an exact match is preferred and returned as is", () => {
  const found = locateInText("Petran read the verse twice.", CHAPTER)!;
  assert.equal(CHAPTER.slice(found.index, found.index + found.length), "Petran read the verse twice.");
});

test("a quote the text never had falls back to its last line, then its longest word", () => {
  // The model invented the first line; the second exists.
  const lastLine = locateInText("Chapter heading gone wrong\nThe vaelfyre burned blue.", CHAPTER)!;
  assert.equal(CHAPTER.slice(lastLine.index, lastLine.index + lastLine.length), "The vaelfyre burned blue.");
  // Nothing of it exists but one long word.
  const word = locateInText("nonsense Silverhnad nonsense", CHAPTER)!;
  assert.equal(CHAPTER.slice(word.index, word.index + word.length), "Silverhnad");
  assert.equal(locateInText("nothing here at all", CHAPTER), null);
});

test("corrections come out in the order they occur in the chapter, unplaceable ones last", () => {
  const cs = [
    { original: "Silverhnad", corrected: "Silverhand" },
    { original: "no such text anywhere", corrected: "x" },
    { original: "Twenty-two\nEmberMother's", corrected: "Twenty-two\n\nEmber Mother's" },
    { original: "Petran read", corrected: "Petra read" },
  ];
  assert.deepEqual(
    inTextOrder(cs, CHAPTER).map((c) => c.original),
    ["Twenty-two\nEmberMother's", "Petran read", "Silverhnad", "no such text anywhere"],
  );
});
