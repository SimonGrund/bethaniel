// ── The author's style-sheet rules, enforced ──

import { test } from "node:test";
import assert from "node:assert/strict";

import { dropCasingChanges, dropDialogueEdits, sheetFixCorrections } from "../src/sheetGates.ts";

test("casing: the capital on the author's words is theirs, and none is written in", () => {
  const terms = ["Take", "Taking", "Giver", "Givers"];
  const { kept, dropped } = dropCasingChanges(
    [
      { original: "the Givers came", corrected: "the givers came" }, // re-cased
      { original: "to take her", corrected: "to Take her" }, // re-cased, other way
      { original: "fast bolt.", corrected: "fast Take." }, // written in (Local Betty did this)
      { original: "chokehold.", corrected: "Taking." },
      { original: "the Givers came", corrected: "the Givers arrived" }, // around the word: fine
      { original: "teh road", corrected: "the road" },
      { original: "would take the", corrected: "would Take the", reason: "style-sheet" }, // the author's tick
    ],
    terms,
  );
  assert.deepEqual(
    kept.map((c) => c.corrected),
    ["the Givers arrived", "the road", "would Take the"],
  );
  assert.equal(dropped.length, 4);
  assert.equal(dropCasingChanges([{ original: "a", corrected: "b" }], []).kept.length, 1);
});

test("dialogue: the picked characters' speech is left alone, the narration around it is not", () => {
  const text = [
    "“Ye be wrong, it were me,” Lulu said, and teh crew laughed.",
    "",
    "“It were me,” Bria said.",
  ].join("\n");
  const { kept, dropped } = dropDialogueEdits(
    [
      { original: "it were me,” Lulu", corrected: "it was me,” Lulu" }, // in Lulu's speech
      { original: "teh crew", corrected: "the crew" }, // narration
      { original: "“It were me,” Bria", corrected: "“It was me,” Bria" }, // another character
      { original: "Ye be wrong", corrected: "You are wrong", reason: "style-sheet" }, // the author's
    ],
    text,
    ["Lulu", "Seraphina"],
  );
  assert.deepEqual(
    kept.map((c) => c.corrected),
    ["the crew", "“It was me,” Bria", "You are wrong"],
  );
  assert.equal(dropped.length, 1);
});

test("the ticked spellings become pre-approved corrections where their text is", () => {
  const cs = sheetFixCorrections("She would take the road.", [
    { original: "would take the", corrected: "would Take the" },
    { original: "not in this chunk", corrected: "Not in this chunk" },
  ]);
  assert.deepEqual(cs, [
    { original: "would take the", corrected: "would Take the", reason: "style-sheet", kind: "copy", preApproved: true },
  ]);
});
