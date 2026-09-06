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
(Big Bad); German 54% → 57%.

**3. Danish — the dictionary was broken.** 26,232 entries carried Hunspell
morphological tags that nspell did not strip, so `den`, `havde`, `kom` were
all unknown words. Clean-text false positives 34 → 3.

## Next, in order

### 1. German misspelling (55% vs 85–97% elsewhere) — dictionary content

`de_DE.dic` lists `Kommen` but not `kommen`, `Recht` but not `recht`, and the
same for `gehen`, `stand`, `paar`, `alter` — lowercase infinitives and
adjectives sharing a stem with a capitalised noun. 43 words in the clean
German fixture are flagged for this.

Do **not** fix by loosening the case rule: that would accept `haus` for `Haus`
and gut the capitalization row, which German scores 79–86% on. The fix is a
fuller dictionary. Hunspell's `de_DE_frami` is the usual replacement and is
LGPL. Verify with the ledger method in `scripts/plant-errors.ts`'s sibling
check: count flags on all four clean fixtures before and after.

Expected: misspelling 55% → 85%+, worth ~10 points of German recall.

### 2. Spanish and Danish commas (5–16% and 26–27%)

The largest planted category in both, and the weakest result. The prompt gate
at `prompts.ts:462` sends comma directives only for English — but that is not
the whole story, because **German scores best of the four (55/72%) with no
prompt help at all**, carried by LanguageTool's German rules. What predicts
comma recall is LanguageTool coverage, not the prompt.

So the lever is per-language comma rules, in this order:

- **Spanish** (5/16%) — LanguageTool's Spanish comma coverage is thin. Add the
  two directives the English prompt already has, translated to Spanish
  convention (Spanish does not take the serial comma; it does take the comma
  before `pero`/`sino` and after a fronted adverbial).
- **Danish** (26/27%) — Danish has two competing comma systems (grammatisk and
  nyt komma), and which one applies is the author's choice. Enforcing the
  wrong one is worse than enforcing neither, so this needs a style-guide
  option before it needs a prompt rule. Rank it after Spanish for that reason.

Expected: Spanish +15 points of recall; Danish smaller and contingent on the
style question.

### 3. English capitalization (36/29%) — the odd one out

English scores *worst* of the four on capitalization (36/29% against 79–86%),
which is backwards: it is the language with the most prompt support. Worth
diagnosing before fixing — the likely cause is that the English fixture plants
mid-sentence proper-noun errors (`scarface` → `Scarface`) while the other three
plant sentence-initial ones, and `collectMidSentenceCapitals()` in
`spellcheck.ts` deliberately protects mid-sentence capitals to avoid mangling
names. If so the fixture is testing the one case the code is designed not to
touch, and the honest fix is to the fixture, not the code.

Diagnose first. Do not "fix" a 36% that is measuring the wrong thing.

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

### 5. Big Bad Betty is not worth its size except on wrong words

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
