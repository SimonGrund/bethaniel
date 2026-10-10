// ── Betty's house-style answers → settings and style-guide lines ──
//
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyEditAnswers,
  editQuestionOptions,
  mergeHouseStyle,
  settingQuestions,
  type EditQuestion,
} from "../../frontend/src/houseStyleAnswers.ts";
import { DEFAULT_COPY_EDIT_OPTIONS } from "../../frontend/src/types.ts";

const unsure = { status: "unsure" as const, support: 31, against: 24, sample: 55 };
const sure = { status: "detected" as const, value: true, support: 40, against: 2, sample: 42 };

test("a setting is asked only when detection was unsure and the author has not changed it", () => {
  const qs = settingQuestions({ oxfordComma: unsure, englishDialect: unsure, quoteStyle: { ...sure, value: "curly" } }, DEFAULT_COPY_EDIT_OPTIONS);
  assert.deepEqual(qs.map((q) => q.id).sort(), ["dialect", "oxfordComma"]);
  const changed = settingQuestions({ oxfordComma: unsure }, { ...DEFAULT_COPY_EDIT_OPTIONS, oxfordComma: false });
  assert.deepEqual(changed, [], "the author set it by hand");
  assert.deepEqual(settingQuestions(undefined, DEFAULT_COPY_EDIT_OPTIONS), []);
  // Answered before with the default value: nothing else records it.
  assert.deepEqual(settingQuestions({ oxfordComma: unsure }, DEFAULT_COPY_EDIT_OPTIONS, ["oxfordComma"]), []);
});

test("each question offers its forms and a way to leave it mixed", () => {
  const spelling: EditQuestion = { id: "spelling:grey|gray", kind: "spelling", forms: [{ form: "grey", count: 14 }, { form: "gray", count: 3 }] };
  assert.deepEqual(editQuestionOptions(spelling), ["grey", "gray", "mixed"]);
  const numbers: EditQuestion = { id: "numbers", kind: "numbers", forms: [{ form: "digits", count: 77 }, { form: "words", count: 75 }] };
  assert.deepEqual(editQuestionOptions(numbers), ["words", "digits", "underTen", "mixed"]);
});

const rule = (key: string, params: Record<string, string> = {}) =>
  ({
    hs_rule_form: "Write {form}, not {others}.",
    hs_rule_numbers_words: "Spell out numbers under 100.",
    hs_rule_numbers_underTen: "Spell out numbers under ten; write 10 and above as digits.",
    hs_rule_dash_closed_em: "Use an em dash with no spaces (—).",
    hs_rule_form_mixed: "Both {forms} are fine; leave each as it is.",
    hs_rule_dash_mixed: "Dashes: leave each as it is.",
  })[key]?.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? "") ?? key;

test("answers become settings and style-guide lines; 'leave it mixed' says so", () => {
  const questions: EditQuestion[] = [
    { id: "dialect", kind: "setting", setting: "dialect", options: ["american", "british"] },
    { id: "oxfordComma", kind: "setting", setting: "oxfordComma", options: ["yes", "no"] },
    { id: "spelling:grey|gray", kind: "spelling", forms: [{ form: "grey", count: 14 }, { form: "gray", count: 3 }] },
    { id: "compound:email", kind: "compound", forms: [{ form: "email", count: 9 }, { form: "e-mail", count: 6 }, { form: "e mail", count: 1 }] },
    { id: "numbers", kind: "numbers", forms: [{ form: "digits", count: 77 }, { form: "words", count: 75 }] },
    { id: "dashes", kind: "dashes", forms: [{ form: "closed-em", count: 5 }, { form: "spaced-en", count: 2 }] },
    { id: "spelling:colour|color", kind: "spelling", forms: [{ form: "colour", count: 4 }, { form: "color", count: 2 }] },
  ];
  const { options, lines } = applyEditAnswers(
    questions,
    { dialect: "british", oxfordComma: "no", "spelling:grey|gray": "grey", "compound:email": "email", numbers: "underTen", dashes: "mixed", "spelling:colour|color": "mixed" },
    rule,
  );
  assert.deepEqual(options, { englishDialect: "british", oxfordComma: false });
  assert.deepEqual(lines, [
    "Write “grey”, not “gray”.",
    "Write “email”, not “e-mail”, “e mail”.",
    "Spell out numbers under ten; write 10 and above as digits.",
    "Dashes: leave each as it is.",
    "Both “colour”, “color” are fine; leave each as it is.",
  ]);
});

test("the lines join the style guide under one heading, without duplicates", () => {
  const heading = "House style";
  const first = mergeHouseStyle("Keep the dialogue tags simple.", ["Write “grey”, not “gray”."], heading);
  assert.equal(first, "Keep the dialogue tags simple.\n\n## House style\n- Write “grey”, not “gray”.");
  const second = mergeHouseStyle(first, ["Write “grey”, not “gray”.", "Use an em dash with no spaces (—)."], heading);
  assert.equal(second, "Keep the dialogue tags simple.\n\n## House style\n- Write “grey”, not “gray”.\n- Use an em dash with no spaces (—).");
  assert.equal(mergeHouseStyle("", ["A."], heading), "## House style\n- A.");
  assert.equal(mergeHouseStyle("Guide.", [], heading), "Guide.");
});
