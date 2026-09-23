# One reading of a word

**Date:** 2026-09-23
**Status:** proposed, not yet approved

## Summary

The spell layer reports 125 corrections across two real novels. Around two of
them are genuine typos. The dominant cause is the same defect the quotation
work just fixed, in a different place: **two components each hold half the
answer to "is this a word", and the false positives live in the gap.**

The run-to-run variation that prompted this — "a few extra spelling errors
come up on the second run" — is real, and is *not* what I first said it was.
It is not the LLM reviewer. It is deterministic code carrying chunk-dependent
state.

## Measured

Both manuscripts from the last two runs, spell-checked exactly as `queue.ts`
does it — per chunk, deduped, then through `gateProtectedTerms` with the
lexicon each book actually has:

| | corrections reaching the author |
|---|---|
| Rage of the Rule (2,715 paragraphs) | 73 |
| Path of the Taker (3,339 paragraphs) | 52 |
| **total** | **125** |

Five deterministic rules account for 105 of them:

| rule | removed |
|---|---|
| A — the other English dictionary knows the word | 75 |
| C — closed compound; the suggestion only inserts a space | 11 |
| D — eye-dialect (`Per’aps`, `s’pose`, `Mhmm`, `Shhh`) | 7 |
| E — a capitalised name Hunspell guessed at | 5 |
| B — reported only because of chunking | 5 |
| F — lowercase word, Capitalised suggestion | 2 |
| **survive all six** | **20** |

Of those 20, most are still author coinages — `unknighted`, `unalignment`,
`hammerboy`, `lifeforce`, `manyfold`, `bloodthirst`, `bladesmen`,
`unplaceable`, `captainly`, `plantlife` — plus `snuck`, which is ordinary
informal English. The plausible genuine typos are `skulled` → `skilled` and
`undeterminable` → `indeterminable`.

**Roughly 2 useful findings in 125.**

## Root cause 1: two dictionaries

```
routes.ts:316   harvestForUpload   isWord = en_US(w) OR en_GB(w)
queue.ts:1989   getSpellCorrections(chunk.body, "en_US")
```

`Tobias` appears **610 times** in Path of the Taker. It is in `en_GB` and not
in `en_US`. So:

1. the lexicon harvest asks "is this a word?", gets **yes**, and does not
   harvest it — correctly, by its own rule: it only collects what no
   dictionary knows;
2. nothing therefore protects it;
3. the spell check asks the same question of `en_US` alone, gets **no**, and
   proposes **`Tobias` → `To bias`**.

The same chain produces `Anima` → `Anita`, `Scarface` → `Scarce`, `Sian` →
`Siam`, `barque` → `baroque`, `sigil` → `vigil`, `grey` → `Grey`. 75 of 125.

This is `quoteRepair` counting a straight mark while `publicationScan` did
not, one module over. The fix is the same shape: one reading, consumed by
both.

## Root cause 2: chunk-scoped name protection

`spellcheck.ts:489`'s `collectMidSentenceCapitals(text)` protects a
capitalised word that appears mid-sentence in **the text it is handed** — and
`queue.ts` hands it `chunk.body`, about 2,500 words. A name that happens to
fall only at sentence starts within one chunk is unprotected *in that chunk*
and protected in the next.

Measured: 5 corrections exist only because of chunking, including `Tobias` →
`To bias` and `Tails’s` → `Tail's`.

**This is the run-to-run variation.** Chunk boundaries move when the text
changes — and the text changes between runs, because the author accepted
corrections from the first one. Different names then fall into the
unprotected position, so a second run surfaces findings the first did not,
from code with no randomness in it at all.

My earlier answer — that the variation came from the LLM reviewer deciding
applied-vs-flagged — was wrong as a primary cause. The reviewer effect is
real (`queue.ts:2556`; only editor-confirmed spell fixes are `preApproved`
and skip it, `correctionHygiene.ts:511`) but it changes how a finding is
*presented*, never whether it exists. Chunk scope changes whether it exists.

## Root cause 3: the wrong frame

For secondary-world fiction, "this word is not in the dictionary" is almost
never "this word is misspelled". It is "this is the author's word". Hunspell's
suggestion for such a word is not a correction but a guess, and the guesses
are actively harmful: `sworddancers` → `sword dancers`, `lifeforce` →
`lifeforms`, `Krogman` → `Frogman`, `Sjöblom` → `Blossom`.

The app already has the right home for this — the lexicon, "the author's
confirmed list for one document" (`routes.ts:331`). Its `nearMisses` field is
already exactly the right idea: `Drylander` beside forty `Drylanders` is the
typo worth catching. What is missing is that unknown words currently reach the
author as *corrections with a guessed replacement* instead of as *a list to
confirm once*.

## Design

### 1. `backend/src/wordKnowledge.ts` — the single reading

One module answers "is this a word, and to whom", consumed by
`spellcheck.ts`, `lexicon.ts` and `routes.ts`:

- `knownTo(word)` → `{ inDeclared: boolean; inOtherEnglish: boolean }` for
  English; a single verdict for every other language.
- The declared dialect decides which dictionary is `declared` — from
  `editOptions.englishDialect`, the same precedence the quote work
  established, falling back to `detectEnglishDialect`.

No caller may load a validator of its own. That is what let the two drift.

### 2. A word the other dialect knows is never a spelling error

It is one of two other things, and both already have owners:

- **a dialect marker** (`grey`, `travelled`, `onwards`, `amidst`) — routed to
  the dialect pass, which knows the declared dialect and proposes the right
  word. `dialectEvidence.ts` already owns this reading;
- **anything else** (`Tobias`, `barque`, `sigil`) — not an error at all.
  Silent.

Removes 75 of 125 and, more importantly, stops proposing `To bias` for a
character who appears on almost every page.

### 3. Name protection is computed once per manuscript

`collectMidSentenceCapitals` moves out of the per-chunk call: computed once
for the whole manuscript and passed into each chunk's spell run, exactly as
`buildPublicationScan` reads the quote convention off the whole book rather
than per chapter.

This is the determinism fix. The deterministic layer becomes chunk-independent
and therefore stable across runs, whatever the author accepted last time.

### 4. Unknown words become a list, not corrections

A word no dictionary knows and that the lexicon did not harvest (below
`minCount`) is reported as **a word to confirm**, with its occurrences and no
suggested replacement — feeding the same panel the lexicon already owns. The
author confirms it once and it is protected for every future run of that
document.

A suggestion is offered only when it is worth offering, which the existing
`isConfidentSuggestion` already tries to judge and which rules C, D, E and F
sharpen: never a bare space-insertion into a closed compound, never a
capitalisation flip on a lowercase word, never against eye-dialect.

### 5. Deterministic findings are not judged by a model

The original ask, and it stands on its own. `isDeterministicCorrection`
(`correctionSeverity.ts:48`) already stops the precision pass *deleting* a
Hunspell finding — measured, deleting them cost German misspelling recall
68% → 30%. The same argument applies to flagging: whether a dictionary
finding reads as a finding or as a suggestion should not vary between two
runs over the same text.

Deterministic corrections become `preApproved` and skip the reviewer
altogether, as editor-confirmed spell fixes already do. That also saves the
tokens currently spent asking a model to second-guess a dictionary.

Note `reason: "quote-style"` (just shipped) is not in
`isDeterministicCorrection` and should be added; it is safe today only
because it is independently `preApproved`.

## Acceptance

Measured on the same two manuscripts:

1. `Tobias` → `To bias` is not proposed. Nor `Anima`, `Scarface`, `Sian`.
2. Spell output is **identical whatever the chunk size**, which is the
   property that makes it identical across runs.
3. Corrections reaching the author drop from 125 to at most 25, and
   `skulled` → `skilled` and `undeterminable` → `indeterminable` are still
   among them.
4. German misspelling recall does not regress — the benchmark that governs
   `isDeterministicCorrection` (`benchScoring.test.ts`) still passes.
5. No dictionary finding's presence or flagged state changes between two runs
   over identical text.

## Out of scope

- Adding words to the shipped dictionaries.
- The LLM proofread agent's own spelling suggestions. It is a separate
  producer with separate behaviour; this spec is about the deterministic
  layer only.
- Languages other than English for rule 2 — `knownTo` reports a single
  verdict elsewhere, and the dialect question does not arise.

## Ranked backlog — other measured candidates

Not specced here; listed with what is actually known about each.

1. **The lexicon is not offered per run.** Both books have a harvested
   lexicon (73 and 71 terms) and it does real work — it gated 26 of the 151
   raw corrections. Nothing measured about whether authors ever see or
   confirm it. Worth instrumenting before building anything.
2. **`nearMisses` is underused.** Rage's lexicon carries exactly two
   (`Drylander` beside `Drylanders`, `Tiranins` beside `Tiranin`) and these
   are the highest-precision typo signal in the whole system — a rare token
   one edit from a term used hundreds of times. Two findings, both plausible,
   against Hunspell's 125 for two. Deserves to be promoted, not buried.
3. **Scene-break consistency.** `sceneBreaks.ts` normalises on upload; no
   check reports a manuscript that mixes markers. Unmeasured — would need
   counting on the corpus first.
4. **Chapter-title casing drift.** `chapters.ts` already extracts every
   title; comparing their shape is cheap. Rage's are lowercase
   ("Chapter six"), Taker's are title case ("Chapter Four") — each internally
   consistent, so there is nothing to report on this corpus. Build only if a
   manuscript that mixes them turns up.
5. **Heading-level jumps** (h1 → h3). Deterministic and cheap; occurrences on
   the corpus not yet counted.

Nothing above needs a cloud run to evaluate. The offer to use cloud credit on
smaller texts was not taken up: every number in this document came from
deterministic code run locally, which is also why they can be pinned in tests.
