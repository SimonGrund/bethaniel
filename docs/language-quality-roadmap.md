# Language quality: what to fix next, and why

Derived from the four-language stress benchmark (80 tasks, both bundled
models, ~100 planted errors per language). Every claim here is a measured
number from `sample_texts/benchmark_results.json`, not an impression.

The ordering rule is **points per unit of work**: a fix that moves a big
category in a language that is far behind outranks a fix that polishes a
category already at 90%. Where a fix is cheap and certain it is ranked above a
larger but speculative one.

## Baseline

The first four-language stress run, before any of the fixes below. Copy-edit
recall by error type, ~100 planted errors per language, Baby Betty / Big Bad
Betty:

| Error type | English | Danish | German | Spanish |
|---|---|---|---|---|
| Misspelling | 97 / 94 | 85 / 87 | **55 / 56** | 97 / 95 |
| Wrong word | 53 / 67 | **12 / 33** | 54 / 57 | 83 / 83 |
| Comma | **32 / 30** | **26 / 27** | 55 / 72 | **5 / 16** |
| Capitalization | **36 / 29** | 80 / 80 | 79 / 86 | 80 / 80 |
| Duplicated word | 100 / 100 | 100 / 67 | 100 / 100 | 100 / 100 |

Headline: recall 47–68%, precision 31–79%, clean-text false positives 0–131.

## Where it stands now

Measured 8 September 2026, **one request at a time** — see the method note
before comparing any of this with an older number. Copy edit, four languages,
all four models on identical settings.

| Language | Baby Betty 4B | Big Bad Betty 9B | Cloud 70B | Cloud 9B |
|---|---|---|---|---|
| English | 68 / 76 | 67 / 74 | 78 / 74 | **80 / 79** |
| Danish | **54 / 86** | 49 / 72 | 39 / 85 | 35 / 83 |
| German | 58 / 69 | 63 / 77 | 65 / 78 | **68 / 73** |
| Spanish | **61 / 75** | 61 / 78 | 57 / 79 | 59 / 77 |
| **Mean recall** | 60 | 60 | 60 | 59 |

Recall / precision. **All four models are within one point of each other on
the mean.** Size is close to irrelevant for copy editing; the per-language
split is where every real difference lives, which is the argument for keeping
this table split rather than reporting a headline.

Line edit tells a different story, and it is the one place model choice
matters: Cloud 9B and Baby Betty both reach 52% mean recall, Big Bad Betty
49%, and the Llama-70B **24%** — less than half the free bundled model.
Translation is the mirror image: the 70B leads on chrF (78.3 against 76.7)
and by 5.0 points on Danish, which is its *worst* language for copy edit.
That split is why the cloud now runs Qwen3.5-9B for editing and keeps the
70B for translation alone.

By error type, copy edit, the bundled models:

| Error type | English | Danish | German | Spanish |
|---|---|---|---|---|
| Misspelling | 94 / 94 | 88 / 85 | **47 / 47** | 88 / 88 |
| Wrong word | 80 / 73 | **23 / 23** | 38 / 46 | 92 / 92 |
| Comma | **35 / 38** | **34 / 30** | 57 / 70 | **11 / 11** |

Three things in that table are worth naming rather than averaging away:

- **Commas are still the largest hole**, and the largest planted category in
  every fixture. Spanish at 11% is the worst cell on the page.
- **German misspelling has regressed**, and §3 below is now a description of
  that rather than a fix. It also no longer differs between the two models,
  which is itself the clue.
- **Danish wrong words are all-or-nothing.** Across four languages and every
  model there was not one case where a wrong word was flagged in the right
  place with the wrong replacement: if it notices, it is right. That makes a
  Danish miss invisible — no flag for the author to review — which is the one
  failure mode the human-in-the-loop design cannot catch.

## Done

**8 September 2026 — the harness itself.** The benchmark now runs one request
at a time by default. Everything below this line that predates it was measured
with ±20 points of batching noise; see the method note.

**A dictionary is not an opinion.** The precision pass deleted any correction
it scored below threshold, including the deterministic layer's. It now
annotates rather than deletes: nothing is removed, and what it doubts arrives
flagged. Deletion is the only irreversible act in a pipeline a human reads,
and unmarked false positives on clean text stayed flat at 2 across every
setting while recall rose 54→60%.

**The agent fan-out never produced a second opinion.** Two to four editor
agents and N reviewers all ran the same prompt at temperature 0 — and the
reviewers shared a seed as well — so every extra agent returned a byte-
identical answer that the union-dedupe collapsed. Measured across four
languages and three models: one editor and two gave identical output in every
cell, and one was 15-20% faster. Removed, along with `characterDedup`, which
was plumbed end to end and read by nothing.

**A capitalised misspelling is not a name.** The proper-noun filter dropped any
correction changing the letters of a capitalised non-dictionary word — which
describes every sentence-initial typo, and in German nearly every noun typo
there is. It discarded 10 of 10 correct German fixes and `Recieve` → `Receive`
in English.

**A reasoning model is not identified by its name.** Qwen3.5-9B reasons and is
called none of `reason`, `think` or `r1`, so it received no chain-of-thought
headroom, spent every completion token thinking and returned `content: null`.
A paid cloud line-edit run produced nothing but deterministic corrections while
being billed in full. Detection is now observational, and reasoning is turned
off rather than paid for.


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

### 1. Commas — 63% of everything missed, and now partly explained

Commas are where the misses are. Counting planted errors that neither model
caught, across all four fixtures:

| category | missed | share |
|---|---|---|
| **comma** | **116.5** | **62.6%** |
| misspelling | 25.8 | 13.8% |
| wrong word | 21.0 | 11.3% |
| capitalization | 13.0 | 7.0% |

And almost nothing deterministic is looking. LanguageTool covers 5 of 47
planted English commas, 13 of 40 German, and **0 of 50 Danish and 0 of 41
Spanish**.

**Two prompt interventions were run, and the contrast between them is the
finding.** On the canonical two-repeat run, Danish comma directives (behind the
new comma-system toggle) moved Big Bad Betty 9 → 20; Baby Betty went 23 → 20,
which is inside the noise. Spanish directives moved nothing on either model:
5 → 4 and 11 → 8.

Read that honestly: it is one model gaining eleven points on one category, and
the total missed-comma pool only fell from 116.5 to 114.5. A real effect, and a
small one. The single-repeat run that first showed it reported 9 → 19 and
23 → 28 — better than the truth, which is what one repeat buys you.

The difference is not the language, it is the shape of the rule:

- The Danish rules name a **closed set of trigger words** — put a comma before
  `at`, `som`, `fordi`, `hvis`, `da`, `når`, `der`. A model can pattern-match
  that.
- The Spanish rules describe a **syntactic relation** — bracket an inciso,
  separate an apposition. There is no lexical marker to match on.

The fixtures confirm it: **1 of 30** Spanish missing-comma plants sits before a
trigger word; the other 29 are incisos, appositions and enumerations. Danish's
are all before conjunctions.

So the rule for anyone adding comma rules to a new language: **name the trigger
words or expect nothing.** Where the comma depends on recognising a
parenthetical, a 4B-9B will not find it however the instruction is phrased, and
that is not a prompt-engineering problem to keep retrying.

That leaves Spanish commas (36 missed, the single largest remaining pool) with
no cheap lever. The options are a real LanguageTool Spanish rule set, or a
deterministic apposition detector of our own — both substantial, and both
needing to clear the ledger bar before shipping, because a comma rule that
misfires on clean prose is the failure mode this pipeline is most sensitive to.

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

### 3. German misspelling — REGRESSED, and quantisation is the new suspect

This section used to say FIXED and record 68 / 68. Both halves need correcting.

**The 68 was inflated by the harness.** It came from a run with several
requests in flight, where batching moved the same German fixture between 50%
and 71% on consecutive repeats. Measured one-at-a-time against the commit
before the spellcheck guard (1fec295), German misspelling recall was **50%
(4B) and 62% (9B)** — never 68 on both.

**Against that honest baseline there is still a real regression**, measured
the same way on both builds:

| | 4B | 9B |
|---|---|---|
| before the guard (1fec295) | 50% | 62% |
| today | 47% | 47% |

Three points off the small model and **fifteen off the large one**. Overall
German recall fell 60→58 and 70→63.

The cause is the spellcheck suggestion guard (bee4caa) and the proper-noun
filter around it. Both were right to exist — the guard stopped `siebzehn-
zähnige` being rewritten to `siebzehnjährige` on clean prose, and the filter
was discarding every capitalised misspelling in the language — and both were
narrowed once already (aa905bd, 6a82614), which recovered most of what the
first version cost. What remains is the residue.

**The tell is that the two models now agree exactly.** Before the guard they
differed by twelve points; today both sit at 47%, which is what the
deterministic layer alone produces. Whatever the model knew about German
spelling is no longer reaching the author.

**A quantisation lead was raised here and is now withdrawn.** It rested on the
cloud Qwen3.5-9B scoring 88% on German misspellings against the local models'
47%, and on reading that as full precision beating 4-bit. The 88% came from a
run with the reasoning misconfiguration still present. Measured after that fix,
the same cloud model scores **35%** — below the quantised local models, not
above them. There is no evidence that quantisation is the constraint.

What the two runs actually differed on was chain-of-thought, so that was tested
directly: the same model and fixture with reasoning enabled and 32k of
headroom did not finish a single German chapter inside the harness's one-hour
per-task ceiling. Reasoning is not a lever here — at any quality it is too slow
to ship, which is why `reasoning_effort: "none"` stands.

So German misspelling is a regression with a known cause (the spellcheck guard
and proper-noun filter, both since narrowed) and no cheap remedy identified.
The next thing worth trying is a straight precision comparison that holds the
serving stack constant — the same Q8 GGUF against the Q4 locally, on llama.cpp
both times. The cloud comparison could never have answered it, because
quantisation, serving stack and reasoning all changed at once.

**The dictionary was never the problem**, and that part of the old section
stands: all four dictionaries were checked against upstream and are current;
the German one rejected all 44 planted misspellings. Detection was never the
weak link. What is fragile is everything between detection and the author.

### 4. English wrong word (53/67%) — the confusable list is English-first

English wrong-word recall is *below* Spanish (83%) despite having the largest
confusable list. Spanish wins because its wrong words are dropped accents,
which stay visible; English `their`/`there` needs the model to read the
sentence. The 14-point gap between Baby and Big Bad here (53 vs 67) is the
largest model-size effect anywhere in the benchmark — this is the one category
where the bigger model earns its size.

Cheapest lever: raise `maxSets` (currently 40) for English, or order the sets
by observed miss rate rather than assumed frequency. Measure before changing —
a longer hint block costs prompt budget on every chunk.

### 5. Size buys nothing for copy editing — settled, with four models

The old version of this section hedged, because it compared two models on a
noisy harness. With all four measured one-at-a-time on identical settings it
is not a hedge any more:

| | copy edit | line edit | translation (chrF) |
|---|---|---|---|
| Baby Betty 4B | 60% | 52% | 75.8 |
| Big Bad Betty 9B | 60% | 49% | 76.5 |
| Llama-3.3-70B | 60% | **24%** | **78.3** |
| Qwen3.5-9B (cloud) | 59% | 52% | 76.7 |

**Copy edit is a four-way tie inside one point**, from a 4B that runs on a
laptop to a 70B that costs money per token. **Line edit is where models
differ**, and there the 70B is the worst of the four by a wide margin. Only
**translation** rewards size, and it does so consistently.

The product follows the table: the cloud runs Qwen3.5-9B for editing and keeps
the 70B for translation alone.

The standing conclusion holds and is now better evidenced — effort spent on
the deterministic layers helps every model equally, and effort spent on a
bigger model buys almost nothing outside translation.

## The guard against the next one

Five bugs have now been found here, and they are the same bug five times: a
heuristic correct in English, silently wrong in exactly one other language,
invisible until a large fixture in that language existed. Each was found weeks
late by reading benchmark output by hand.

`backend/test/languageRegression.test.ts` computes the numbers that would have
caught them, in eleven seconds, with no model, no GPU and no network. It
asserts the deterministic layer from **both** sides, per language:

| | catches |
|---|---|
| ceiling on the clean fixture | a checker that started inventing |
| floor on the errored fixture | a checker that stopped looking |
| confusable sets non-empty | a language with no wrong-word detection at all |
| LanguageTool ceiling on clean text | a rule that started firing on house style |

Only the two-sided form covers all five. The Spanish quote rule, the Danish
tags and the German case collision all blow the clean ceiling. The German
proper-noun guard does not move the clean column by a single flag — it is a
pure recall loss, which is why it hid longest, and only the errored floor sees
it. Each of the four was reintroduced and confirmed to fail the guard before
it was committed.

The LanguageTool leg needs a live server, so it skips unless `LANGUAGETOOL_JAR`
is set — green locally, skipped in CI. The other twelve assertions run
everywhere.

Bounds are ~3× the measured noise and ~0.75× the measured detections. They are
not a quality target; tightening them buys nothing. They exist to catch the
10–30× swing every one of these bugs actually produced without flapping when a
dictionary is updated.

## Method note

Every number above comes from `scripts/test-models.ts` against the ~100-error
fixtures, run **one request at a time**. That is not a detail — it is what
makes the numbers mean anything.

Corrections decode greedily (temperature 0), so a run ought to repeat exactly.
It did not, because with several requests in flight llama.cpp batches them into
one decode and the batch composition changes the floating-point arithmetic. On
the German fixture the same configuration scored 50% and 71% on consecutive
repeats. At one slot, four repeats came back bit-identical, as did five runs
with different seeds.

**Any figure in this file older than 8 September 2026 carries roughly twenty
points of that noise** and should not be compared with a current one without
re-measuring. The 68% that §3 used to report for German is exactly this
mistake, and it sent a real regression undiagnosed for a week.

The consistency column in the generated report means nothing for copy edit: at
one slot it is always 100, and the spread it used to show was batching noise
rather than the model disagreeing with itself. It still means something for
line edit, which rewrites at the model's configured temperature.

Before changing a rule, measure it against the ledger bar documented in
`languageTool.ts`: **zero real errors found, at least one invented**.
