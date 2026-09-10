# Commas are two measurements wearing one number

Commas are the worst-scoring category in every benchmark this repo has run,
and the front page says so. This is the investigation into whether that
number means what it appears to mean.

It half does. The category really is measuring two unlike things at once, and
separating them moves the figure by about 3x. It does not, however, turn a
bad number into a good one, and the split surfaces a defect worse than the
one it explains away.

## The objection

Ground truth here is recovered by diffing an errored fixture against its clean
twin (`buildGroundTruth`). Every planted error is therefore scored as: *did
the model restore what the author originally wrote?*

For a misspelling that is the same question as "is the text now correct".
For a comma it often is not. `"and she resented it, and the letter had
softened"` and the same sentence without that comma are both defensible; two
careful editors would punctuate them differently. A model that declines to
reproduce **this** author's choice has not made an error, and counting it as
one measures reconstruction rather than correctness.

Some commas are not like that. A comma the author never wrote is wrong in
every language. A missing comma inside a list runs two items together. German
requires one before a subordinate clause. Those are settled by a reference
grammar, and for them "restore the original" and "produce correct text" are
the same instruction.

Pooling the two gives a number that is neither.

## The split

`classifyComma` in `backend/src/benchScoring.ts` assigns each planted comma to
one of eight kinds, in three buckets. The rules come from CMOS, Duden and RAE,
and were **fixed before any score was computed** — the classification of all
145 comma spans was dumped and reviewed first, precisely because re-cutting a
category after seeing a bad result on it is how motivated reasoning works.

| Bucket | Kinds | Why |
|---|---|---|
| **rule-governed** | `spurious`, `seriesInner`, `relativeEn`, `subordDe` | A reference grammar settles it. Restoring the original *is* correcting the text. |
| **contested** | `subordDa` | Danish sanctions two systems — grammatisk komma sets the comma before `som`/`der`/`at`, nyt komma does not. Neither presence nor absence is an error alone; only inconsistency within one text is. |
| **discretionary** | `seriesOxford`, `coordClause`, `freeAdjunct` | The style guides disagree with each other, not with the writer. |

Two classifier bugs were found and fixed during that review, both before any
number existed: a list test loose enough to fire on any nearby comma (it had
swallowed every relative clause in ordinary prose, because well-punctuated
prose has commas everywhere), and a `\b` that had become a literal backspace
character, so the series regex could never match at all. Both are pinned by
tests in `backend/test/benchScoring.test.ts`.

## Results

Three engines, four languages, 145 planted comma spans. No model was re-run —
the stored corrections were re-matched against the same ground truth the
headline uses.

| Engine | rule-governed | contested (da) | discretionary | non-comma |
|---|---|---|---|---|
| Qwen3.5-4B | 38% ±12 | 50% ±19 | **13% ±9** | 80% ±5 |
| Qwen3.5-9B | 48% ±12 | 38% ±18 | **14% ±9** | 77% ±5 |
| deepseek-v4-flash | 31% ±11 | 67% ±18 | **14% ±9** | 81% ±5 |

The objection is confirmed: rule-governed commas score roughly **3x**
discretionary ones, consistently across three engines that otherwise disagree
with each other. That is not noise at these intervals. The pooled comma figure
is being dragged down by errors that arguably aren't errors.

And it changes nothing worth advertising. Even on the rule-governed half the
engines manage 31–48%, against ~80% on everything else. The honest restatement
is *"39% of rule-governed commas, 14% of discretionary ones"* rather than
*"about a third"*, and the first half of that is still not a good number.

## The finding that actually matters

Broken out by kind, pooled across engines:

| Kind | n | fixed | surfaced |
|---|---|---|---|
| `subordDe` — German subordinate clause | 72 | **78%** | 78% |
| `subordDa` — Danish som/der/at | 72 | 51% | 58% |
| `seriesInner` — list-internal | 48 | 29% | 35% |
| `coordClause` — joined main clauses | 42 | 29% | 29% |
| `freeAdjunct` — fronted/trailing adjuncts | 108 | 9% | 13% |
| **`spurious` — author never wrote it** | **57** | **9%** | **12%** |
| `relativeEn` — English non-restrictive | 18 | 6% | 6% |
| `seriesOxford` — Oxford comma | 18 | 6% | 6% |

**Betty almost never removes a comma.** The `spurious` row is the one place
with no discretion in any language: the author did not write it, it is wrong,
and there is nothing to argue about. 9% get fixed and 88% are never even
flagged. These are realistic error shapes — `da, forstod`, `lupa, y`,
`constante, que` — not artifacts; one of the nineteen is a silly `dark,.`
Whatever the comma logic is doing, it adds and does not subtract. This is a
defect, and it is the opposite of the direction the objection points.

**German scores 78% while English relatives score 6%**, on rules of the same
standing. That is almost certainly not the model: LanguageTool ships a strong
German comma rule set and a weak English one. It is consistent with
[languagetool-is-load-bearing.md](languagetool-is-load-bearing.md), and unlike
the taxonomy question it is fixable.

## What this does and does not license

- **Do** keep reporting commas at the pooled figure on the website. It is
  accurate, the low number is what makes the 91%/93% credible, and replacing
  it with "actually commas are subjective" spends that credibility to buy a
  39%.
- **Do** read the per-kind rows when judging a model or a prompt change. A
  regression in `spurious` or `subordDe` is a real regression; movement in
  `freeAdjunct` mostly is not.
- **Don't** treat `freeAdjunct` recall as a quality target. Optimising it means
  training the tool to impose one author's comma habits on another's prose,
  which is the opposite of what a copy editor should do.
- **Do** treat the stray-comma and English-relative gaps as bugs to chase.

## Reproducing

The breakdown prints in every `scripts/test-models.ts` report, under the
per-category rows, marked `!` for rule-governed and `?` for contested:

```
    commas (fixed/seen)        planted    wen3.5-4B
      ! subordDe                     7       43/57%
        coordClause                  4         0/0%
        freeAdjunct                  6       33/50%
```

The rows are built from the same `scoreCorrections` result as
`recallByCategory`, reusing its `missedErrors` object references, so they
always add up to its `comma` row — a test pins that.
