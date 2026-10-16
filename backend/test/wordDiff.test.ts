import { test } from "node:test";
import assert from "node:assert/strict";
import { whitespaceMark } from "../../frontend/src/wordDiff.ts";

test("a change that is only a space is drawn, not struck through", () => {
  assert.equal(whitespaceMark(" "), "␣");
  assert.equal(whitespaceMark("\n"), "↵");
  assert.equal(whitespaceMark("-"), null);
  assert.equal(whitespaceMark("a "), null);
});
