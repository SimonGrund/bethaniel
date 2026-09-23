# One reading of a quotation mark

**Date:** 2026-09-23
**Status:** approved, not yet implemented

## The problem, measured

The publication scan's unbalanced-quotation check misses most of what it is
for. Measured against the two manuscripts of the last two runs, pulled from
the installed app's database (`~/Library/Application Support/Bethaniel/data`):

| manuscript | paragraphs | genuinely unbalanced | scan reported |
|---|---|---|---|
| Rage of the Rule (2026-09-23) | 2,715 | 15 | **5** |
| Path of the Taker (2026-09-23) | 3,339 | 8 | **0** |

All 23 were read by hand. They fall into three groups.

**Correctly forgiven.** `Path of the Taker`, Chapter Four #83–#89: a story
told aloud over seven paragraphs, each re-opening with `“`, the last one
closing. Legitimate continued speech. Whatever replaces the current check
must leave this silent — it is the reason the tolerances exist.

**Missed, and all one defect** — a curly opener closed by a straight mark:

```
Taker  Ch. Eight #50    “But—"
Taker  Ch. Fifteen #4   “Probably not… to be any threat to them," Laura said.
Rage   Ch. eight #28    “…and you will do well in remembering so."
Rage   Ch. nine #81     “I hope it won’t get too boring for you."
Rage   Frontmatter #48  _"Share your knowledge and powers…I will destroy you.”_
```

`QUOTE_FAMILIES` (`backend/src/publicationScan.ts:241`) has no entry for `"`.
The paragraph reads as one open and no close, and the continued-speech
tolerance then absorbs it. Mark counts: `“` 1,653 / `”` 1,654 / `"` 5 in Rage;
`“` 2,406 / `”` 2,398 / `"` 34 in Taker.

**Reported correctly.** The remaining 5 in Rage — genuine stray or missing
curly marks.

### It is a blind spot, not non-determinism

`buildPublicationScan` returns byte-identical output across three runs on both
manuscripts. Hunspell likewise: 66 corrections, identical across three runs.
The scan has no LLM and no randomness, so **a second run of the publication
scan cannot find anything the first missed**, and adding one would be waste.

All 5 findings in today's `Rage of the Rule` were also reported on 2026-09-16.
The Sep 16 run reported 15, ten were fixed, today reports the remaining five.
Nothing new appeared. The same defects are invisible on every run and will
stay invisible until the mark-reading changes.

(Spelling is different and out of scope here: Hunspell's detection is
deterministic, but `queue.ts:2556` routes every correction including spell
ones through the LLM reviewer — only editor-confirmed ones are `preApproved`
and skip it, `correctionHygiene.ts:511`. The reviewer never deletes a
deterministic finding (`queue.ts:1813`) but does decide applied-vs-flagged,
which is what varies run to run. Fixing that is a separate change.)

### Why one file could not see what the other could

`quoteRepair.marksOpen` counts straight `"` as a quotation mark.
`publicationScan.quoteBalance` does not. The two files disagree about what a
quotation mark is, and every missed defect above lives exactly in that gap.

## Design

### 1. Quote style is a declared convention, not a majority vote

Quote style belongs where the manuscript's other conventions already live:
`detectSettings.ts`, read off the text at upload and confirmed by the author
in the wizard beside the dialect and comma controls. A new
`detectQuoteStyle(md)` returns `Detection<"curly" | "straight">`, able to
answer "unsure" like every other detector, and joins `DetectedSettings`.
It carries through `editOptions` to both consumers.

This is not a preference. CLAUDE.md records that `publicationScan`'s English
dialect check was changed to measure against the dialect the author
**declared**, falling back to the draft's own majority only when no job
setting exists — because deciding by majority inside the check advised a
manuscript set to British to standardise on American, the exact opposite of
what the copy edit would do to the same text. Quote style has the identical
failure mode: a book that is 60% curly would be "normalised" to curly even
if the author wants straight. Declared setting first, manuscript majority as
fallback, same as dialect.

It also gives the genuinely-mixed case an answer. Today `dominantStyle`
returns `null` below a 75% majority and both files silently give up — which
is precisely the manuscript most in need of normalising. A declared setting
turns "no majority" from a reason to do nothing into a reason to ask.

Note this is *not* the free-text style sheet (`buildStyleCompliancePrompt`,
`prompts.ts:1583`). That is an LLM pass, and the model is on record here as
unreliable with quotation marks — it is why `quoteRepair.ts` exists at all,
and why the copy-edit prompt warns the model off quotes entirely. Routing
this through the compliance agent would reintroduce exactly the
non-determinism established above.

### 2. `backend/src/quoteMarks.ts` — the single reading

A new module owns the reading of quotation marks, as `dialectEvidence.ts` owns
the reading of dialect. Both `publicationScan.ts` and `quoteRepair.ts` consume
it, so they cannot drift apart again.

- `resolveConvention(text, declared?)` → `{ family, style }`. Merges today's
  `detectQuoteFamily` (publicationScan, which family of marks) and
  `dominantStyle` (quoteRepair, curly or straight) — two answers about the
  same book that are currently computed separately and never compared — and
  prefers the author's declared style over the manuscript's majority.
  Fallback thresholds are quoteRepair's existing ones: 75% majority,
  minimum 4 marks.
- `readMarks(paragraph, convention)` → one entry per double-quote mark: its
  index, its character, and its role (open or close). Family marks take their
  role from their character; straight marks take it from alternation, exactly
  as `marksOpen` already does.

Single quotes and apostrophes are out of scope. `’` appears 2,002 times in
Taker as an apostrophe; telling those from a nested closing quote is a
different and riskier job, and `quoteRepair` already declines it.

### 3. Two checks, because one cannot do it

`“But—"` is *balanced* — two marks — and wrong only in **style**. No balance
check, however strict, can find it. The check therefore splits.

**A. Balance, style-agnostic.** Every double-quote mark counts, whatever its
style or family.

The tolerance fix: today's loop re-decides "continued speech or block
quotation?" at every paragraph, so a run can switch readings mid-way and be
forgiven by whichever one fits. Instead, **commit to one reading at the first
paragraph after the opener** and require the rest to conform:

- next paragraph starts with an open mark → *continued speech*: every
  paragraph until the closer must also start with one;
- next paragraph carries no marks → *block quotation*: the middles carry
  none, and the closer has exactly one close mark and no open mark;
- either way the run must close before the chapter ends.

Anything else reports the paragraph that opened the run — that is where the
fix goes — and the scan then resumes at the paragraph that broke it, so one
defect never hides the next.

This is what today's code cannot do. An unclosed line followed by a plain
narration paragraph is currently absorbed (the narration is read as a block
quotation's middle) and then cleared by the next line of dialogue (read as
continued speech). Committing to a reading at the first paragraph breaks that
chain: the block-quotation reading requires a closer with no open mark, and
the next line of dialogue has one.

**B. Style consistency.** Every mark not in the resolved style is reported
with its passage. This is what catches all five defects the last runs missed.
It is its own check — `quote_style`, added to `STRUCTURAL_CHECKS`
(`types.ts:389`) — not another `truncation` finding: a straight mark among
curly ones is a house-style inconsistency, not evidence the text is cut off.
Adding the value obliges a frontend label, which `publicationScanLabels.test.ts`
already enforces.

### 4. Reporting and fixing are separate

The publication scan never rewrites text; it produces findings. So:

- **The scan reports.** Balance findings stay `truncation`/`info` as today;
  style findings are `quote_style`/`info`. Both carry the passage.
- **The copy/line edit fixes.** `getQuoteCorrections` regains straight→curly
  conversion for a manuscript whose dominant style is curly.

Restoring that conversion reverses commit `a342be5` (2026-09-12), which
removed it on the grounds that "straight or curly is the author's choice, not
an error", and which also added the filter at `correctionHygiene.ts:575`
dropping any correction whose only difference is quote style. Both need
changing: the conversion restored, and a carve-out so the filter stops eating
it. The reason it was removed was noise — dozens of separate quote
corrections in the review list.

**So it arrives as one decision.** The corrections carry `reason:
"quote-style"` (the same mechanism `reason: "dialect"` already uses for
grouping in `ReviewExport.tsx:179`) and the review screen presents the whole
group as a single accept/dismiss: "Normalise 34 quotation marks to the book's
curly style." They are `preApproved` — the manuscript's own majority decides
the style, so there is no judgement for a reviewer to add, and no tokens to
spend on one.

### 5. The one case that stays a judgement

An unclosed line followed by a *new* line of dialogue is structurally
identical to two-paragraph continued speech:

```
“That will never work.              ← defect: unclosed
“It has to,” he answered.

“My story unfolds…                  ← legitimate: continued speech
“Prince Tua Tiranin ruled…”
```

Counting cannot separate these. The rule — likely that a short second
paragraph carrying a dialogue tag is not proof of legitimacy — is chosen and
then **calibrated against these two manuscripts**, the way `dialectEvidence.ts`
was scored against twelve public-domain novels. The numbers go in the module
header so the next person to change a threshold knows what it cost.

## Acceptance

Measured on `Rage of the Rule` and `Path of the Taker` (2026-09-23 uploads):

1. All five straight-among-curly defects listed above are reported.
2. `Path of the Taker` Chapter Four #83–#89 stays silent.
3. False positives are counted and reported, not assumed away. A rule that
   catches everything by reporting the Chapter Four legend is a failure.
4. `buildPublicationScan` stays byte-identical across repeated runs.
5. Accepting the normalization group changes only quotation-mark characters —
   no word added, removed or altered.

## Out of scope

- Single quotes and apostrophes.
- Inventing a missing closing mark. Where it belongs is a judgement
  (end of sentence, before or after the dialogue tag); `quoteRepair` already
  refuses this and continues to.
- The spelling run-to-run variation described above.
- Changing which text the publication scan reads.
