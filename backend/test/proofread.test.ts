// Proofread is the lightest corrections pass: surface errors only. It must NOT
// carry copy-edit's dialect conversion, Oxford comma, or dialogue-tag rules.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildProofreadCorrectionsPrompt } from "../src/prompts.ts";

test("proofread prompt targets surface errors", () => {
  const p = buildProofreadCorrectionsPrompt();
  assert.ok(p.includes("Spelling errors and obvious typos"));
  assert.ok(p.includes("Duplicated words"));
  assert.ok(p.includes("Clear grammatical slips"));
  assert.ok(p.includes("STRICT JSONL"), "keeps the corrections JSONL contract");
});

test("proofread prompt leaves style and dialect alone", () => {
  const p = buildProofreadCorrectionsPrompt();
  // Explicitly instructs to preserve dialect and style choices…
  assert.ok(p.includes("British vs American spelling"));
  assert.ok(p.includes("Oxford/serial comma"));
  assert.ok(p.includes("Dialogue tag punctuation restyling"));
  // …and never carries copy-edit's ACTIVE conversion/style directives.
  assert.ok(!p.includes("convert to AMERICAN ENGLISH"));
  assert.ok(!p.includes("convert to BRITISH ENGLISH"));
  assert.ok(!p.includes("missing the OXFORD COMMA"));
});
