// ── The house-style lines, applied by code ──
//
// "Write “traveled”, not “travelled”." used to be left to the style-sheet
// agent, which on Local Betty wrote "traveled" into unrelated sentences.
// houseStyleRules.ts reads the lines and replaces the avoided forms itself.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HOUSE_STYLE_FORM_TEMPLATES,
  getHouseStyleCorrections,
  parseHouseStyleRules,
} from "../src/houseStyleRules.ts";
import TRANSLATIONS from "../../frontend/src/i18n.ts";

test("the templates are the app's own hs_rule_form, in every language", () => {
  const app = (TRANSLATIONS as unknown as Record<string, Record<string, string>>).hs_rule_form;
  assert.deepEqual(HOUSE_STYLE_FORM_TEMPLATES, app);
});

test("the lines are read in any interface language; other lines are not rules", () => {
  const guide = [
    "Pirates speak grammatically wrong on purpose.",
    "",
    "## House style",
    "- Use a long dash without spaces (—) for a break in a sentence.",
    "- Write “traveled”, not “travelled”.",
    "- Write “midair”, not “mid-air”, “mid air”.",
    "- Skriv “grå”, ikke “graa”.",
    "- Leave “grey”, “gray” as written.",
  ].join("\n");
  assert.deepEqual(parseHouseStyleRules(guide), [
    { prefer: "traveled", avoid: ["travelled"] },
    { prefer: "midair", avoid: ["mid-air", "mid air"] },
    { prefer: "grå", avoid: ["graa"] },
  ]);
});

test("each avoided form becomes a pre-approved correction, in the case it was written", () => {
  const text =
    "Travelled far, they had travelled long. A bird hung mid-air over the travelled road. " +
    "The unravelled rope. Mr Travelled, mid-sentence, is a name.";
  const cs = getHouseStyleCorrections(text, [
    { prefer: "traveled", avoid: ["travelled"] },
    { prefer: "midair", avoid: ["mid-air"] },
  ]);
  const pairs = cs.map((c) => [c.original, c.corrected]);
  assert.deepEqual(pairs, [
    ["Travelled far,", "Traveled far,"],
    ["had travelled long.", "had traveled long."],
    ["the travelled road.", "the traveled road."],
    ["hung mid-air over", "hung midair over"],
  ]);
  assert.ok(cs.every((c) => c.preApproved && c.reason === "house-style"));
  // Part of another word, or a capitalised form mid-sentence: left alone.
  assert.ok(!pairs.some(([o]) => /unravelled|Mr Travelled/.test(o)));
});
