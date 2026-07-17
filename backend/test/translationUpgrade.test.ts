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

import {
  buildTranslationUpgradePrompt,
  buildFluencyReviewerPrompt,
} from "../src/prompts.ts";

test("buildTranslationUpgradePrompt: names target language, forbids meaning/paragraph changes", () => {
  const p = buildTranslationUpgradePrompt("Danish");
  assert.match(p, /native Danish line editor/i);
  assert.match(p, /Do NOT add, drop, or alter any meaning/);
  assert.match(p, /Do NOT merge, split, add, or remove paragraphs/);
  assert.doesNotMatch(p, /BINDING GLOSSARY/);
});

test("buildTranslationUpgradePrompt: includes binding glossary when style guide given", () => {
  const p = buildTranslationUpgradePrompt("Danish", "Betty → Betty (never translate)");
  assert.match(p, /BINDING GLOSSARY/);
  assert.match(p, /never translate/);
});

test("buildFluencyReviewerPrompt: JSONL contract and drift flagging", () => {
  const p = buildFluencyReviewerPrompt("Danish");
  assert.match(p, /"index": 0, "confidence": 5/);
  assert.match(p, /STRICT JSONL/);
  assert.match(p, /Meaning added, dropped, or altered/);
  assert.doesNotMatch(p, /BINDING GLOSSARY/);
});

test("buildFluencyReviewerPrompt: glossary violations become defects when style guide given", () => {
  const p = buildFluencyReviewerPrompt("Danish", "Betty → Betty (never translate)");
  assert.match(p, /BINDING GLOSSARY/);
  assert.match(p, /VIOLATION/);
});
