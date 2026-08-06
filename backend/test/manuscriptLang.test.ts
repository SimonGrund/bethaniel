// Tests for the manuscript-language plumbing: prompt builders must state the
// manuscript's language and forbid translation, English-only rules must be
// suppressed for non-English manuscripts, and English/unset must remain
// byte-identical to the pre-language-setting behavior.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  manuscriptLangName,
  buildCopyEditCorrectionsPrompt,
  buildLineEditCorrectionsPrompt,
  buildCombinedEditPrompt,
  buildReviewerPrompt,
  buildStyleCompliancePrompt,
  buildDevelopmentalReviewPrompt,
  buildWritingReportPrompt,
  buildPassageCritiquePrompt,
  buildStoryReadPrompt,
  buildPartSynthesisPrompt,
  buildStorySynthesisPrompt,
  buildAnalysisSummaryPrompt,
  buildBlurbPrompt,
} from "../src/prompts.ts";
import {
  DEFAULT_COPY_EDIT_OPTIONS,
  DEFAULT_LINE_EDIT_OPTIONS,
} from "../src/types.ts";

test("manuscriptLangName: maps codes, passes free text, null for English/unset", () => {
  assert.equal(manuscriptLangName("da"), "Danish");
  assert.equal(manuscriptLangName("de"), "German");
  assert.equal(manuscriptLangName("es"), "Spanish");
  assert.equal(manuscriptLangName("en"), null);
  assert.equal(manuscriptLangName(undefined), null);
  assert.equal(manuscriptLangName(""), null);
  assert.equal(manuscriptLangName("French"), "French");
});

test("copy-edit prompt: Danish language block present, never-translate rule stated", () => {
  const p = buildCopyEditCorrectionsPrompt(
    DEFAULT_COPY_EDIT_OPTIONS,
    undefined,
    undefined,
    "da",
  );
  assert.match(p, /MANUSCRIPT LANGUAGE: Danish/);
  assert.match(p, /NEVER translate/);
  assert.match(p, /NOT by English rules/);
});

test("line-edit prompt: Danish language block present", () => {
  const p = buildLineEditCorrectionsPrompt(
    DEFAULT_LINE_EDIT_OPTIONS,
    undefined,
    undefined,
    "da",
  );
  assert.match(p, /MANUSCRIPT LANGUAGE: Danish/);
  assert.match(p, /NEVER translate/);
});

test("combined-edit prompt: Danish language block present", () => {
  const p = buildCombinedEditPrompt(
    DEFAULT_COPY_EDIT_OPTIONS,
    DEFAULT_LINE_EDIT_OPTIONS,
    undefined,
    undefined,
    "da",
  );
  assert.match(p, /MANUSCRIPT LANGUAGE: Danish/);
  assert.match(p, /NEVER translate/);
});

test("reviewer prompt: translation-is-always-a-mistake rule for Danish", () => {
  const p = buildReviewerPrompt(undefined, "copy_edit", "da");
  assert.match(p, /MANUSCRIPT LANGUAGE: Danish/);
  assert.match(p, /score it 1/);
});

test("style-compliance prompt: Danish language block present", () => {
  const p = buildStyleCompliancePrompt("Use serial commas.", "copy_edit", "da");
  assert.match(p, /MANUSCRIPT LANGUAGE: Danish/);
  assert.match(p, /NEVER translate/);
});

test("free-text 'Other' language passes through to prompts verbatim", () => {
  const p = buildCopyEditCorrectionsPrompt(
    DEFAULT_COPY_EDIT_OPTIONS,
    undefined,
    undefined,
    "French",
  );
  assert.match(p, /MANUSCRIPT LANGUAGE: French/);
  assert.match(p, /written in French/);
});

test("regression: English/unset prompts carry no language block and keep dialect rules", () => {
  const unset = buildCopyEditCorrectionsPrompt(DEFAULT_COPY_EDIT_OPTIONS);
  const en = buildCopyEditCorrectionsPrompt(
    DEFAULT_COPY_EDIT_OPTIONS,
    undefined,
    undefined,
    "en",
  );
  assert.equal(unset, en, "explicit 'en' must be byte-identical to unset");
  assert.doesNotMatch(unset, /MANUSCRIPT LANGUAGE/);
  // Defaults: americanDialect + oxfordComma rules still present
  assert.match(unset, /AMERICAN ENGLISH|BRITISH ENGLISH/);
  const reviewer = buildReviewerPrompt(undefined, "copy_edit");
  assert.doesNotMatch(reviewer, /MANUSCRIPT LANGUAGE/);
});

test("non-English suppresses English-only rules even when the options are on", () => {
  const opts = {
    ...DEFAULT_COPY_EDIT_OPTIONS,
    oxfordComma: true,
    englishDialect: "american" as const,
  };
  const p = buildCopyEditCorrectionsPrompt(opts, undefined, undefined, "da");
  assert.doesNotMatch(p, /AMERICAN ENGLISH/);
  assert.doesNotMatch(p, /BRITISH ENGLISH/);
  assert.doesNotMatch(p, /OXFORD COMMA/);
  const combined = buildCombinedEditPrompt(
    opts,
    DEFAULT_LINE_EDIT_OPTIONS,
    undefined,
    undefined,
    "da",
  );
  assert.doesNotMatch(combined, /AMERICAN ENGLISH/);
  assert.doesNotMatch(combined, /OXFORD COMMA/);
});

// ── Report/analysis output language ──
// The whole-manuscript modes produce prose ABOUT the book rather than edits to
// it, so they take the opposite directive from the editor prompts: write the
// output in the manuscript's language, but never translate quoted text.

const REPORT_BUILDERS: [string, (lang?: string) => string][] = [
  ["developmental review", (l) => buildDevelopmentalReviewPrompt(l)],
  ["writing report", (l) => buildWritingReportPrompt(undefined, l)],
  ["passage critique", (l) => buildPassageCritiquePrompt(undefined, l)],
  ["story read", (l) => buildStoryReadPrompt(undefined, l)],
  ["part synthesis", (l) => buildPartSynthesisPrompt(l)],
  ["story synthesis", (l) => buildStorySynthesisPrompt(undefined, l)],
  ["analysis summary", (l) => buildAnalysisSummaryPrompt(l)],
  ["blurb", (l) => buildBlurbPrompt(l)],
];

for (const [name, build] of REPORT_BUILDERS) {
  test(`${name} prompt: Danish output-language directive present`, () => {
    const p = build("da");
    assert.match(p, /OUTPUT LANGUAGE: Danish/);
    assert.match(p, /entire response in Danish/i);
  });

  test(`${name} prompt: English/unset carries no output-language block`, () => {
    const unset = build(undefined);
    assert.equal(
      unset,
      build("en"),
      "explicit 'en' must be byte-identical to unset",
    );
    assert.doesNotMatch(unset, /OUTPUT LANGUAGE/);
  });

  test(`${name} prompt: free-text language passes through verbatim`, () => {
    assert.match(build("Icelandic"), /OUTPUT LANGUAGE: Icelandic/);
  });
}

test("report prompts protect verbatim quotes from being translated", () => {
  // The writing report and developmental report both quote the manuscript;
  // translating a quote would misrepresent the author's own words.
  for (const build of [
    (l: string) => buildWritingReportPrompt(undefined, l),
    (l: string) => buildDevelopmentalReviewPrompt(l),
    (l: string) => buildPassageCritiquePrompt(undefined, l),
  ]) {
    assert.match(build("da"), /never translate a quote/i);
  }
});

test("JSON analysis prompts keep keys and role values in English", () => {
  // Story-read output is parsed by field name and `role` is a controlled
  // vocabulary the merge logic compares — only free-text values are localized.
  for (const build of [
    (l: string) => buildStoryReadPrompt(undefined, l),
    (l: string) => buildPartSynthesisPrompt(l),
    (l: string) => buildStorySynthesisPrompt(undefined, l),
  ]) {
    const p = build("da");
    assert.match(p, /JSON keys.*English/is);
  }
  assert.match(buildStorySynthesisPrompt(undefined, "da"), /role.*English/is);
});
