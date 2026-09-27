# Missing words — what was measured

A dropped word ("they expect us to look each other" for "look *for* each
other") reached no layer of the pipeline: every word that is there is spelled
correctly, and the copy-edit prompt told the model never to add words. This
records how the check in `backend/src/missingWords.ts` was chosen, so the
routes that failed are not tried again.

All numbers are the bundled model (Qwen3.5-4B, Q4_K_M) unless marked, measured
27 September 2026 on an RTX 5090. Engine-level results for both Local Betty and
Betty in the Cloud are in `sample_texts/benchmark_results_{local,cloud}.json`
and `sample_texts/performance_summary.json`.

## Fixtures

Planted by `scripts/plant-errors.ts` from each language's clean twin; every
planted error is one function word removed so the sentence no longer parses.
Category `missingWord` in `benchScoring.ts`.

| Fixture | Base text | Planted |
|---|---|---|
| `missing300en` | `stress300en_correct` | 29 |
| `missingda` | `stress100da_correct` | 18 |
| `missingde` | `stress100de_correct` | 20 |
| `missinges` | `stress100es_correct` | 20 |
| `missingfr` | `stress100fr_correct` | 19 |

False positives were also measured on real prose that is not in the
repository: four chapters of one of the author's novels and two of another
(18,700 words, English), and ~4,000-word slices of public-domain novels from
Project Gutenberg — Jensen's *Kongens Fald* (da), Kafka's *Die Verwandlung*
(de), Galdós's *Marianela* (es), Voltaire's *Zadig* (fr).

## Routes that failed

**1. Tell the copy editor to look for missing words.** A directive in the
copy-edit prompt, A/B on one backend:

| | without | with |
|---|---|---|
| Missing words shown to the author (fixture, of 29) | 6 | 6 |
| Confusable words caught on `stress100` (of 15) | 12 | **8** |

No gain, and it cost the confusables — "by than", "weather/whether",
"it's/its", "quiet/quite" were no longer proposed. The small model's attention
is zero-sum.

**2. Tell the reviewer and the precision pass that an insertion can be a
fix.** The editor already proposes some insertions without being asked; the
reviewer rejects them ("a valid elliptical construction") and the precision
pass scores them 1-2. A rule in both prompts raised the fixture from 6 to 7
shown, and leaked into other verdicts: the precision pass began scoring
correct Oxford commas 2.

**3. Neither can help the case that started this.** On the chapter where the
author found the error, the editor never proposed the fix at all, with or
without the directive.

## What works: a pass of its own

Sweep (250-word batches, one question) → deterministic shape filter → verdict.

Raw, the sweep is noise — about 70 candidates per 3,000 words of clean prose.
The shape filter (one function word of the language, spliced into the
interior of a uniquely anchored span, letters only) removes about 98% of them.

**The verdict.** 55 candidates that survived the filter, hand-labelled across
the five languages (33 real, 22 not):

| Verdict prompt | Real errors kept | Non-errors let through |
|---|---|---|
| A/B: which sentence is grammatical | 20 / 33 | 2 / 22 |
| A/B, naming the inserted word | 7 / 33 | 0 / 22 |
| "REQUIRED / OPTIONAL / WRONG" | 33 / 33 | 21 / 22 |
| Each sentence judged alone | 18 / 33 | 2 / 22 |
| **A/B, else each sentence alone** (shipped) | **25 / 33** | **4 / 22** |

**Sweep details that mattered.**
- The model stopped after the first finding in a batch; "do not stop after the
  first" raised recall in every language.
- German answers mostly in arrays (`["als","könnte","fortlaufen"]`), which the
  first parser dropped; parsing arrays, and anchoring words the text separates
  with a comma, doubled German from 1-3 to 5 of 20.
- 500-word batches cut English recall from 9 to 3 of 29.
- Asking the sweep never to repeat an unchanged sentence saved 10% of tokens
  and cost recall and precision; reverted.
- Words the grammar lets a writer omit (English "that", Danish "som"/"der")
  are excluded — the model kept proposing them.

## Final result of the check on its own (module benchmark, Local Betty)

| | Planted errors surfaced | False positives, clean twin | False positives, real prose |
|---|---|---|---|
| en | 9 / 29 | 0 | 2 in 18.7k words (+1 borderline) |
| da | 4 / 18 | 0 | 1 in 4.0k words |
| de | 5 / 20 | 0 | 0 in 4.1k words |
| es | 6 / 20 | 0 | 3 in 4.1k words |
| fr | 2 / 19 | 0 | 0 in 3.9k words |

Every kept correction on a planted fixture is at a real gap; some insert a
different valid word from the one removed. On the author's chapters it found
four real dropped words the pipeline had never shown, including the one that
prompted this. The 19th-century prose (da, es) is the harshest false-positive
test: archaic constructions read as dropped words.

The same module run on Betty in the Cloud (deepseek-v4-flash, through a real
credential):

| | Planted errors surfaced | False positives, clean twin | False positives, real prose |
|---|---|---|---|
| en | 18 / 29 | 0 | 0 in 18.7k words |
| da | 4 / 18 | 0 | 3 in 4.0k words (1900 prose) |
| de | 6 / 20 | 0 | 0 in 4.1k words |
| es | 12 / 20 | 0 | 6 in 4.1k words (1878 prose) |
| fr | 2 / 19 | 0 | 0 in 3.9k words |

## Through the whole pipeline (27 September 2026)

`scripts/test-models.ts` on both engines, then `scripts/performance-summary.ts`;
shown corrections only (a reviewer's 1 is held back). Surfaced, then correct fix
as a share of surfaced:

| | Local Betty | Betty in the Cloud |
|---|---|---|
| en (29) | 41% / 83% | 76% / 96% |
| da (18) | 39% / 86% | 61% / 82% |
| de (20) | 15% / 67% | 90% / 94% |
| es (20) | 40% / 88% | 80% / 100% |
| fr (19) | 32% / 50% | 84% / 94% |
| pooled (106) | 34% / 78% | 78% / 94% |
| false alarms classed as a missing word | 7 | 19 |

The pipeline beats the module alone on the cloud because the cloud editor also
proposes insertions itself; on the bundled model the two are close.

**Cost.** On the bundled model, 3,974 input and 2,129 output tokens per 1,000
words (60,700 words, five languages) — `MISSING_WORD_TOKENS_PER_KWORD` in
`cloudEstimate.ts`. About 20-25 s per 3,000 words locally, started alongside
the editor. The cloud model answers "NONE" for a clean batch where the 4B lists
sentences that are fine, so it wrote ~210 output tokens per 1,000 words;
provider-billed usage confirmed 3 completion tokens and 0 reasoning tokens for
a clean batch. The quote keeps the 4B's figure, which over-reserves for the
cloud — the safe direction.
