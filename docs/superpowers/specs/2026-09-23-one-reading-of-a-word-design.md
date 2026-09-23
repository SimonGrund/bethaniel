# Catching every spelling error

**Date:** 2026-09-23
**Status:** proposed, not yet approved

## What this replaces

An earlier draft of this spec optimised for **precision** — it led with "five
deterministic rules remove 105 of 125 findings". That was the wrong objective.
The readthrough is the last check before a book is published; a missed
misspelling is a printed misspelling, and a noisy finding only costs the
author a moment. **Recall is the goal.** Precision matters only where noise
buries a real finding, or where a wrong suggestion gets auto-applied.

Two rules from that draft are withdrawn outright, because they cost recall:

- suppressing a rare capitalised word Hunspell guessed at (`Krogman` →
  `Frogman`) would bury a misspelled character name, which is among the most
  important things to catch before publishing;
- suppressing a closed compound (`sworddancers` → `sword dancers`) would bury
  a real error whenever the author did mean two words.

What those two rules were right about is narrower and is kept: **the
suggestion is wrong, not the finding.** Report the word; withhold the guess.

## Where spelling actually happens

The readthrough card submits two tasks:

- **`proofread`** — the chunk pipeline, carrying Hunspell (`queue.ts:1989`),
  LanguageTool, retext, and an LLM pass;
- **`publication_scan`** — `buildPublicationScan`, deterministic and
  structural only. It has no spell check at all.

Everything below concerns the deterministic spelling in the `proofread` task.

## Measured: recall is already high

400 typos injected into the two manuscripts of the last two runs — common
dictionary words corrupted by doubling, dropping, transposing and
adjacent-key slips, keeping only corruptions that are genuinely not words —
then run through the pipeline exactly as `queue.ts` does it (per chunk,
through `gateProtectedTerms` with each book's real lexicon):

| | caught |
|---|---|
| Rage of the Rule | 196 / 200 (98.0%) |
| Path of the Taker | 194 / 200 (97.0%) |

By kind, every category is at or near 100%: dropped-letter 93/93,
transposed 94/94, doubled-letter 102/105, adjacent-key 101/108.

So the deterministic layer is not broadly leaky. The misses are one specific
thing.

## The hole: a typo made three times disappears

Every miss was a typo injected **three or more times**. Reproducible on the
real manuscript, injecting the same slip a varying number of times:

```
"woth" ×1  | lexicon: not harvested        | speller flags it: yes | reaches author: yes
"woth" ×2  | lexicon: not harvested        | speller flags it: yes | reaches author: yes
"woth" ×3  | lexicon: PROTECTED (word x3)  | speller flags it: yes | reaches author: NO
"woth" ×5  | lexicon: PROTECTED (word x5)  | speller flags it: yes | reaches author: NO
```

`harvestLexicon` collects lowercase non-dictionary words occurring at least
`DEFAULT_MIN_COUNT` (3) times as the author's coinages — "a spell, a coined
verb, a made-up drink" (`lexicon.ts:248`). `gateProtectedTerms` then removes
any correction touching one. Hunspell flags the typo correctly every time;
the gate deletes it.

The rule is right for what it was built for and wrong at its edge. A typo
repeated three times is not rarer than a coinage — it is a find-and-replace
slip, a habitual misspelling, or a character's name consistently misspelled.
**Those are the errors most worth catching, and they are the only ones the
layer is blind to.**

The lexicon already carries the right idea in `nearMisses` — "`Silverhnad`
beside forty `Silverhand`s is the typo the author wants caught"
(`lexicon.ts:254`) — but it only compares a rare token against a frequent
**harvested name**. A typo of an ordinary dictionary word is not covered.

### The fix, measured

A harvested coinage that is one edit from a dictionary word the book uses at
least 20× more often is a near-miss, not a word. Run over both manuscripts
with one repeated typo injected into each:

```
rage    warhammer x31  -> kept as the author's word
        chokehold x3   -> kept as the author's word
        woth      x3   -> NEAR-MISS of "with" (x708) — report it

taker   blackwood x19  -> kept as the author's word
        snuck     x6   -> kept as the author's word
        lordling  x3   -> kept as the author's word
        woth      x3   -> NEAR-MISS of "with" (x917) — report it
```

Both injections caught; all seven genuine coinages untouched. The threshold
is a ratio rather than an absolute count, so it scales with the book.

## The second hole: chunk-scoped protection

`collectMidSentenceCapitals` (`spellcheck.ts:489`) protects a capitalised word
appearing mid-sentence in **the text it is handed** — and `queue.ts` hands it
`chunk.body`, about 2,500 words. A name that happens to fall only at sentence
starts inside one chunk is unprotected in that chunk and protected in the
next.

This is the run-to-run variation reported as "a few extra spelling errors come
up on the second run". Chunk boundaries move when the text changes, and the
text changes between runs because the author accepted the previous run's
corrections. Different names then land in the unprotected slot. No randomness
is involved — my earlier answer, that the LLM reviewer was the cause, was
wrong. The reviewer changes how a finding is *presented* (applied vs flagged,
`queue.ts:2556`); it never changes whether the finding exists.

Fix: compute the protected-capitals set once per manuscript and pass it into
each chunk's run — the same move `buildPublicationScan` already makes by
reading the quote convention off the whole book rather than per chapter.

## The third hole: two dictionaries, one question

```
routes.ts:316   harvestForUpload     isWord = en_US(w) OR en_GB(w)
queue.ts:1989   getSpellCorrections(chunk.body, "en_US")
```

`Tobias` appears **610 times** in Path of the Taker. It is in `en_GB`, not in
`en_US`. The lexicon asks "is this a word?", gets yes, and does not harvest
it — correctly, by its own rule. Nothing then protects it. The speller asks
the same question of `en_US` alone, gets no, and proposes **`Tobias` → `To
bias`**. The same chain yields `Anima` → `Anita`, `Scarface` → `Scarce`,
`barque` → `baroque`, `sigil` → `vigil`. 75 of 125 findings.

This is the defect the quotation work just fixed, one module over: two
components each holding half an answer.

**Re-scoped for recall.** The fix is not to silence these. It is that the two
must ask one question, and that a word the *other* English dictionary knows
is reported as what it is rather than as a misspelling with a fabricated
replacement:

- if it is a dialect marker (`grey`, `travelled`, `onwards`, `amidst`), the
  dialect pass owns it and proposes the right word — `gray`, not `Grey`;
- otherwise it is reported **without a suggestion**, as a word one dictionary
  does not recognise. The author decides. Nothing is auto-applied, so a name
  can never be rewritten to `To bias`.

## Design

### 1. `backend/src/wordKnowledge.ts` — the single reading

One module answers "is this a word, and to whom", consumed by
`spellcheck.ts`, `lexicon.ts` and `routes.ts`. No caller loads a validator of
its own — that is what let the two drift.

- `knownTo(word)` → `{ inDeclared, inOtherEnglish }` for English; one verdict
  for every other language.
- Which dictionary is `declared` comes from `editOptions.englishDialect`,
  falling back to `detectEnglishDialect` — the precedence the quotation work
  established.

### 2. Near-miss beats coinage

`harvestLexicon` keeps collecting coinages, but a candidate one edit from a
dictionary word the manuscript uses ≥20× more often is filed as a near-miss
instead, and near-misses are **never** used to gate a correction. Closes the
recall hole above.

### 3. Protected capitals are manuscript-wide

Computed once per task, passed into each chunk. Closes the determinism hole.

### 4. A finding is not a suggestion

Two fields, not one. The deterministic layer keeps reporting every word it
does not recognise; it offers a replacement only when it can vouch for one.
Never a bare space-insertion into a closed compound, never a capitalisation
flip on a lowercase word (`seagrass` → `Seagram`), never against eye-dialect
(`Per’aps`, `s’pose`, `Mhmm`), never a guess at a capitalised name
(`Krogman` → `Frogman`).

The word is still reported in every one of those cases. Only the guess is
withheld.

### 5. Deterministic findings are not judged by a model

`isDeterministicCorrection` (`correctionSeverity.ts:48`) already stops the
precision pass *deleting* a Hunspell finding — deleting them cost German
misspelling recall 68% → 30%. The same argument covers flagging: whether a
dictionary finding reads as a finding or a suggestion should not vary between
two runs over identical text. Deterministic corrections become `preApproved`
and skip the reviewer, as editor-confirmed spell fixes already do — which
also saves the tokens spent asking a model to second-guess a dictionary.

`reason: "quote-style"` (shipped) should be added to
`isDeterministicCorrection`; today it is safe only because it is
independently `preApproved`.

## The ceiling, stated plainly

No dictionary catches a **real-word error** — `form` for `from`, `their` for
`there`, `desert` for `dessert`. Both are words. That is what the LLM
proofread pass is for, and it is why the deterministic layer's job is to be
exhaustive about the errors it *can* see rather than clever about the ones it
cannot.

## Acceptance

Measured on the two manuscripts:

1. **Recall does not drop.** The 400-typo injection still catches ≥ 98%.
2. **The repeated-typo hole closes.** A typo injected 3, 5 and 10 times is
   reported every time, and all seven genuine coinages
   (`warhammer`, `chokehold`, `blackwood`, `snuck`, `lordling`, and both
   books' names) remain protected.
3. **Output is chunk-independent** — identical findings at chunk sizes 1,500,
   2,500 and 5,000 words, which is the property that makes it identical
   across runs.
4. **`Tobias` → `To bias` is never proposed.** `Tobias` may still be
   reported; the fabricated replacement may not.
5. German misspelling recall does not regress (`benchScoring.test.ts`).
6. No dictionary finding's presence or flagged state differs between two runs
   over identical text.

## Out of scope

- Adding words to the shipped dictionaries.
- The LLM proofread agent's own suggestions — a separate producer.
- Real-word errors; see the ceiling above.

## Ranked backlog

1. **Promote `nearMisses`.** Rage's lexicon carries two
   (`Drylander` beside `Drylanders`, `Tiranins` beside `Tiranin`) and they
   are the highest-precision typo signal in the system. Once rule 2 extends
   them to dictionary words they become the most valuable output of the
   spelling layer, and they currently have no surface of their own.
2. **Is the lexicon ever confirmed?** Both books have a harvested lexicon
   (73 and 71 terms) doing real work — it gated 26 of 151 raw corrections.
   Nothing is known about whether authors see or confirm it. Instrument
   before building.
3. **Scene-break consistency.** `sceneBreaks.ts` normalises on upload; no
   check reports a manuscript that mixes markers. Occurrences not yet counted.
4. **Heading-level jumps** (h1 → h3). Cheap and deterministic; not yet
   counted on the corpus.
5. **Chapter-title casing drift.** Rage is lowercase ("Chapter six"), Taker
   title case ("Chapter Four"), each internally consistent — nothing to
   report on this corpus. Build only if a mixed manuscript turns up.

Every number here came from deterministic code run locally, which is why each
can be pinned in a test. No cloud credit was spent.
