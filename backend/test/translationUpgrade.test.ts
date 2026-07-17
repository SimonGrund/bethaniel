// Tests for the translation upgrade stage: structural guards and the
// upgrade → fluency-review → re-polish orchestrator with injected deps.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  splitIntoParas,
  upgradeGuard,
} from "../src/translationUpgrade.ts";

const DRAFT =
  "Para one draft sentence.\n\nPara two draft sentence.\n\nPara three draft sentence.";
const POLISHED =
  "Para one polished sentence.\n\nPara two polished sentence.\n\nPara three polished sentence.";

test("splitIntoParas: splits on blank lines, trims, drops empties", () => {
  assert.deepEqual(splitIntoParas("a\n\n  b  \n\n\n\nc\n"), ["a", "b", "c"]);
  assert.deepEqual(splitIntoParas("   "), []);
});

test("upgradeGuard: accepts same paragraph count and sane length", () => {
  assert.deepEqual(upgradeGuard(DRAFT, POLISHED), { ok: true });
});

test("upgradeGuard: rejects empty output", () => {
  const r = upgradeGuard(DRAFT, "   ");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /empty/i);
});

test("upgradeGuard: rejects paragraph count mismatch", () => {
  const r = upgradeGuard(DRAFT, "Merged into one paragraph.");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /paragraph count/i);
});

test("upgradeGuard: rejects output shorter than 60% of draft", () => {
  const r = upgradeGuard(DRAFT, "a.\n\nb.\n\nc.");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /too short/i);
});
