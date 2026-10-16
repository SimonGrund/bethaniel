import { test } from "node:test";
import assert from "node:assert/strict";
import { joinLineEndHyphens } from "../src/lineEndHyphens.ts";

test("a word broken across a line is one word again", () => {
  assert.equal(joinLineEndHyphens("a line-\nbreak here"), "a line-break here");
  assert.equal(joinLineEndHyphens("exam-  \n  ple"), "exam-ple");
  assert.equal(joinLineEndHyphens("søn-\r\ndag"), "søn-dag");
});

test("leaves paragraph breaks, capitals and dashes alone", () => {
  assert.equal(joinLineEndHyphens("end-\n\nnext"), "end-\n\nnext");
  assert.equal(joinLineEndHyphens("Copenhagen-\nBerlin"), "Copenhagen-\nBerlin");
  assert.equal(joinLineEndHyphens("he said -\nthen"), "he said -\nthen");
});
