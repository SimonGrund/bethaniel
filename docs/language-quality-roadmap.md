# Language quality: what to fix next, and why

Derived from the four-language stress benchmark (80 tasks, both bundled
models, ~100 planted errors per language). Every claim here is a measured
number from `sample_texts/benchmark_results.json`, not an impression.

The ordering rule is **points per unit of work**: a fix that moves a big
category in a language that is far behind outranks a fix that polishes a
category already at 90%. Where a fix is cheap and certain it is ranked above a
larger but speculative one.

## Baseline

Copy-edit recall by error type, ~100 planted errors per language, Baby Betty /
Big Bad Betty:

| Error type | English | Danish | German | Spanish |
|---|---|---|---|---|
| Misspelling | 97 / 94 | 85 / 87 | **55 / 56** | 97 / 95 |
| Wrong word | 53 / 67 | **12 / 33** | 54 / 57 | 83 / 83 |
| Comma | **32 / 30** | **26 / 27** | 55 / 72 | **5 / 16** |
| Capitalization | **36 / 29** | 80 / 80 | 79 / 86 | 80 / 80 |
| Duplicated word | 100 / 100 | 100 / 67 | 100 / 100 | 100 / 100 |

Headline: recall 47–68%, precision 31–79%, clean-text false positives 0–131.

## Done

**1. Spanish — LanguageTool rewrote every quotation mark.** `COMILLAS_TIPOGRAFICAS`
converted `"` to `«»` once per quote: 124 flags on one clean fixture, 248
across the corpus, 0 on a real error. Precision **31% → 67%**, clean-text
false positives **71 → 0** (Baby) and **131 → 3** (Big Bad), recall unchanged.
The single highest-value fix found, and it cost one line.

**2. Danish and German — no wrong-word detection existed.** `findConfusables()`
returned `[]` for anything but English, so nothing looked for `nogen`/`nogle`
or `das`/`dass`. Danish wrong word **12% → 25%** (Baby) and **33% → 42%**
(Big Bad); German **54% → 64%** (Baby) once measured alongside the dictionary
fix. Spanish, already at 83% without help, reached **92%**.

**3. Danish — the dictionary was broken.** 26,232 entries carried Hunspell
morphological tags that nspell did not strip, so `den`, `havde`, `kom` were
all unknown words. Clean-text false positives 34 → 3.

**4. German — nspell rejected a third of its own dictionary.** Not a content
gap: `kommen/DIVXW` is in `de_DE.dic` at line 179,634 and `correct("kommen")`
answered false. German capitalises every noun, so 93,148 lowercase words
collide with a capitalised twin and nspell keeps only one of each — rejecting
87,955. Danish loses 1 of 1,240 such pairs, Spanish and English 0.

Measured effect, and it is not the one predicted:

| | before | after |
|---|---|---|
| Flags on clean German | 43 | **8** |
| Precision (Baby / Big Bad) | 63 / 62 | **70 / 78** |
| Clean-text false positives | 0 / 6 | 0 / **1** |
| Wrong word | 54 / 57 | **64** / 57 |
| Misspelling | 55 / 56 | **47 / 50** |
| Overall recall | 60 / 68 | 61 / 66 |

Misspelling recall went *down*. It is not a regression from the fix — the
rescue accepts 3 of 44 planted misspellings, the same 3 it accepted before
(`Maure`, `Fiele`, `Offen`, all real German words the fixture mis-plants). The
old 55% was partly luck: with 43 bogus corrections in flight, some
coincidentally covered a planted span and scored as a catch. The clean number
is the honest one, and the fixture should drop those three plants.

## Next, in order

### 1. Spanish and Danish commas — PROMPT LEVER TESTED AND DISPROVEN

Spanish comma directives were written (RAE convention, in Spanish, not a
translation of the English rules — those are opposite on the serial comma) and
measured. The result:

| Spanish | comma recall | overall recall | precision | clean-text FPs |
|---|---|---|---|---|
| Baby | 5 → **3** | 61 → 57 | 66 → **81** | 0 → 0 |
| Big Bad | 11 → **11** | 62 → 63 | 69 → **78** | 1 → **0** |

**Comma recall did not move.** The directives made the model more conservative
instead, which bought 12-15 points of precision and took clean-text false
positives to zero. Worth keeping on that basis, and kept — but it is a
precision fix, not the comma fix it was written as, and it should not be
described as one.

This is the second independent result pointing the same way. German scores
best of the four on commas with no directive at all, carried by LanguageTool;
Spanish now has directives and still scores 3-11%. **Comma recall tracks
deterministic rule coverage, and a prompt cannot substitute for it.** A 4B or
9B model does not reliably act on a comma rule it is told about, however
concretely it is phrased.

So the remaining lever for Spanish commas is LanguageTool's Spanish rule set,
not the prompt: either enabling more of its comma rules (measured against the
ledger bar, since picky-tier Spanish rules are where COMILLAS_TIPOGRAFICAS
came from) or supplying rules of our own. That is a bigger piece of work than
a prompt edit, and it should be costed before it is started.

Danish stays where it was, and for the same reason as before: two competing
comma systems, and enforcing the wrong one is worse than enforcing neither.
The Spanish result makes it less attractive still — a prompt rule is unlikely
to move it even once the style question is settled.

### 2. English capitalization (36/29%) — DIAGNOSED: the metric, not the product

Do not fix this. It is a fixture artifact, and the mechanism is now known.

The pipeline finds these errors. On the English fixture it emits **seven**
case-only corrections — `constance`, `tuesday`, `elias`, `thaddeus` via the
spell pass and three sentence-initial ones via LanguageTool casing — and
LanguageTool alone covers **76%** of the planted case spans (10 of 13). Danish
and Spanish sit at 100%, German 92%.

The 36% comes from how the plants are counted, not from what is caught.
`buildGroundTruth` merges planted errors that sit within ~20 characters of each
other, and a merged span is multi-word, so `classifyPlantedError` files it under
`other`. Six of the English fixture's 13 case plants merge away, which is why
English is the only fixture with a non-zero `other` count (12) and why its
capitalization row reads n=7 for 13 planted.

Two things this also disproves, both worth recording because they were the
obvious guesses:

- It is NOT `collectMidSentenceCapitals` protecting proper nouns. Nine of the
  13 plants are sentence-initial, and the four proper-noun ones are all caught
  and emitted anyway.
- It is NOT a downstream filter dropping detections. The corrections are in the
  run output.

The fix is to the fixture: re-space the English case plants so they stop
merging, the way `scripts/plant-errors.ts` guarantees for the three newer
fixtures (all three carry zero `other`). Until then English capitalization is
not comparable with the other three and should not be read as a defect.

### 3. English wrong word (53/67%) — the confusable list is English-first

English wrong-word recall is *below* Spanish (83%) despite having the largest
confusable list. Spanish wins because its wrong words are dropped accents,
which stay visible; English `their`/`there` needs the model to read the
sentence. The 14-point gap between Baby and Big Bad here (53 vs 67) is the
largest model-size effect anywhere in the benchmark — this is the one category
where the bigger model earns its size.

Cheapest lever: raise `maxSets` (currently 40) for English, or order the sets
by observed miss rate rather than assumed frequency. Measure before changing —
a longer hint block costs prompt budget on every chunk.

### 4. Big Bad Betty is not worth its size except on wrong words

Overall 47 vs 45 on the run scorecard; the 9B leads only on wrong word (Danish
+21, English +14) and costs ~30% more time and twice the VRAM. If the default
model choice is ever revisited, that is the trade — and it argues for
improving the deterministic layers, which help both models equally, over
recommending the larger one.

## Method note

Every number above came from `scripts/test-models.ts` against the ~100-error
fixtures. Before changing a rule, measure it against the ledger bar documented
in `languageTool.ts`: **zero real errors found, at least one invented**. Two of
the three fixes above were found by applying that bar to a rule nobody
suspected.
