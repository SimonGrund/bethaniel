// Change 3: the corrections-mode editor prompts must push for high spelling
// RECALL. The generic "when in doubt, change nothing" caution is right for
// judgment calls (punctuation, word choice) but was also suppressing plain
// spelling fixes — the editor left clear misspellings for the next run.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildCopyEditCorrectionsPrompt,
  buildCombinedEditPrompt,
  buildCopyEditRewritePrompt,
  buildSpellHintBlock,
} from "../src/prompts.ts";
import {
  DEFAULT_COPY_EDIT_OPTIONS,
  DEFAULT_LINE_EDIT_OPTIONS,
} from "../src/types.ts";

const RECALL_MARKER = "Report EVERY spelling error and obvious typo";

test("copy-edit corrections prompt demands full spelling recall when spelling is on", () => {
  const p = buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS);
  assert.ok(p.includes(RECALL_MARKER), "spelling-recall directive missing");
});

test("copy-edit corrections prompt omits the spelling directive when spelling is off", () => {
  const p = buildCopyEditCorrectionsPrompt({
    ...DEFAULT_COPY_EDIT_OPTIONS,
    spelling: false,
  });
  assert.ok(!p.includes(RECALL_MARKER), "directive must not appear with spelling off");
});

test("combined-edit prompt demands full spelling recall when copy-edit spelling is on", () => {
  const p = buildCombinedEditPrompt(
    DEFAULT_COPY_EDIT_OPTIONS,
    DEFAULT_LINE_EDIT_OPTIONS,
  );
  assert.ok(p.includes(RECALL_MARKER), "spelling-recall directive missing in combined prompt");
});

// The whole-chunk rewrite path fixes text in place rather than emitting
// {original,corrected} pairs, so it needs a "correct every one" phrasing.
const REWRITE_MARKER = "Correct EVERY spelling error and obvious typo";

test("rewrite prompt demands full spelling recall when spelling is on", () => {
  const p = buildCopyEditRewritePrompt(DEFAULT_COPY_EDIT_OPTIONS);
  assert.ok(p.includes(REWRITE_MARKER), "spelling-recall directive missing in rewrite prompt");
});

test("rewrite prompt omits the spelling directive when spelling is off", () => {
  const p = buildCopyEditRewritePrompt({
    ...DEFAULT_COPY_EDIT_OPTIONS,
    spelling: false,
  });
  assert.ok(!p.includes(REWRITE_MARKER), "directive must not appear with spelling off");
});

// ── buildSpellHintBlock: per-chunk spell suspects fed to the LLM editor ──
// Hunspell reliably DETECTS misspellings; the LLM picks the right in-context
// fix. Feeding detected suspects as hints unites both. Recall-leaning wording.

test("buildSpellHintBlock: empty list yields an empty string", () => {
  assert.equal(buildSpellHintBlock([]), "");
});

test("buildSpellHintBlock: lists the suspects and pushes to fix genuine misspellings", () => {
  const b = buildSpellHintBlock(["teh", "recieve"]);
  assert.ok(b.includes("teh") && b.includes("recieve"), "suspects must be listed");
  assert.ok(/misspell/i.test(b), "must reference misspelling");
  assert.ok(/proper noun|name/i.test(b), "must keep the proper-noun caveat");
});

test("copy-edit corrections prompt embeds the hint block when suspects are supplied", () => {
  const p = buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS, undefined, [
    "recieve",
    "teh",
  ]);
  assert.ok(p.includes("recieve") && p.includes("teh"), "hint words missing from prompt");
});
