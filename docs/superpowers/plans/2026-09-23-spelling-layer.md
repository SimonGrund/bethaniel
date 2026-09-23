# Spelling Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two holes that let real misspellings through — a typo repeated three times, and a name unprotected because of where a chunk boundary fell — and stop the layer proposing fabricated replacements like `Tobias` → `To bias`.

**Architecture:** One new module, `backend/src/wordKnowledge.ts`, becomes the single answer to "is this a word, and to whom", consumed by `spellcheck.ts`, `lexicon.ts` and `routes.ts`. Protected capitals move from per-chunk to per-manuscript. The lexicon's coinage bar rises to 5 and gains a near-miss rule for the tail. Findings and suggestions separate, so a word can be reported without a guess attached.

**Tech Stack:** TypeScript, `node:test` via the `tsx` loader. No new dependencies.

## Global Constraints

- **Tests:** `cd backend && npm test`. Single file: `cd backend && npx tsx --test test/<name>.test.ts`. `node:test` + `node:assert/strict` only.
- **Recall is the objective.** This is the last check before publication: a missed misspelling is a printed misspelling, a noisy finding costs a moment. Never suppress a *finding* to reduce noise — suppress the *suggestion*.
- **Never delete a deterministic finding on a model's say-so.** Measured: doing so cost German misspelling recall 68% → 30% and German comma recall 68% → 5% (`reviewResilience.ts:228-240`).
- **Double quotes only** in any quotation handling touched here; single quotes and apostrophes are out of scope.
- **Corpus:** `/tmp/quote-corpus/{rage,taker}.md`, obtained by `scripts/fetch-confusable-corpus.sh` (written by the confusable-patterns plan; if that has not run, the sqlite3 commands are in its Task 1). 203,000 words, contemporary.
- **Baselines to beat, measured 2026-09-23:**
  - 400 injected non-word typos → 196/200 and 194/200 caught. Must not drop.
  - Every miss was a typo injected 3+ times.
  - 125 corrections reach the author across both books; ~2 are genuine typos.
  - `Tobias` appears 610 times in Path of the Taker and is proposed as `To bias`.

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/wordKnowledge.ts` | **New.** The single reading: is this a word, in the declared dialect and in the other English. Pure. |
| `backend/src/spellcheck.ts` | Consumes `wordKnowledge`; `collectMidSentenceCapitals` becomes an injectable, manuscript-wide set; findings separate from suggestions. |
| `backend/src/lexicon.ts` | `DEFAULT_MIN_COUNT` 3 → 5; near-miss beats coinage. |
| `backend/src/routes.ts` | `harvestForUpload` consumes `wordKnowledge` instead of building its own validator. |
| `backend/src/queue.ts` | Computes protected capitals once per task and passes them per chunk. |
| `backend/src/correctionSeverity.ts` | (Only if the confusable plan has not already done it) `quote-style` joins the deterministic guard. |

Tasks 1–2 are independent. Task 3 depends on 1. Tasks 4–5 depend on 2.
Task 6 depends on 1 and 4, Task 7 on 6. Task 8 depends on everything and must
run last.

---

### Task 1: `wordKnowledge.ts` — the single reading

**Files:**
- Create: `backend/src/wordKnowledge.ts`
- Test: `backend/test/wordKnowledge.test.ts`

**Interfaces:**
- Consumes: `getWordValidator` from `./spellcheck.js`.
- Produces:
  - `type EnglishDialect = "american" | "british"`
  - `interface WordVerdict { inDeclared: boolean; inOtherEnglish: boolean }`
  - `function wordKnowledge(lang: string, declared?: EnglishDialect): ((word: string) => WordVerdict) | null`
  - `function isWordAnywhere(lang: string, declared?: EnglishDialect): ((word: string) => boolean) | null`

- [ ] **Step 1: Write the failing test**

Create `backend/test/wordKnowledge.test.ts`:

```ts
// One reading of "is this a word".
//
// harvestForUpload asked en_US OR en_GB; getSpellCorrections asked en_US
// alone. "Tobias" appears 610 times in one real manuscript, is in en_GB and
// not en_US, and so was a real word to the lexicon (never harvested, never
// protected) and a misspelling to the speller, which proposed "To bias".
// Every one of the 75 findings in that class lived in that gap.

import { test } from "node:test";
import assert from "node:assert/strict";

import { initSpellchecker } from "../src/spellcheck.ts";
import { wordKnowledge, isWordAnywhere } from "../src/wordKnowledge.ts";

test("a word only the other English knows is reported as exactly that", async () => {
  await initSpellchecker();
  const know = wordKnowledge("en", "american")!;
  const v = know("Tobias");
  assert.equal(v.inDeclared, false, "en_US does not have it");
  assert.equal(v.inOtherEnglish, true, "en_GB does");
});

test("a word both dictionaries know is in both", async () => {
  await initSpellchecker();
  const know = wordKnowledge("en", "american")!;
  assert.deepEqual(know("harbour").inOtherEnglish, true);
  assert.deepEqual(know("table"), { inDeclared: true, inOtherEnglish: true });
});

test("a word neither knows is in neither", async () => {
  await initSpellchecker();
  const know = wordKnowledge("en", "american")!;
  assert.deepEqual(know("Ricko"), { inDeclared: false, inOtherEnglish: false });
});

test("the declared dialect decides which one is 'declared'", async () => {
  await initSpellchecker();
  const us = wordKnowledge("en", "american")!;
  const gb = wordKnowledge("en", "british")!;
  // "grey" is en_GB only.
  assert.equal(us("grey").inDeclared, false);
  assert.equal(us("grey").inOtherEnglish, true);
  assert.equal(gb("grey").inDeclared, true);
});

test("a non-English language has no 'other English'", async () => {
  await initSpellchecker();
  const da = wordKnowledge("da")!;
  const v = da("hund");
  assert.equal(v.inDeclared, true);
  assert.equal(v.inOtherEnglish, false, "there is no other dictionary to ask");
});

test("a language with no dictionary returns null", async () => {
  await initSpellchecker();
  assert.equal(wordKnowledge("xx"), null);
});

test("isWordAnywhere is true when either English knows it", async () => {
  await initSpellchecker();
  const any = isWordAnywhere("en", "american")!;
  assert.equal(any("Tobias"), true, "this is what the lexicon harvest asks");
  assert.equal(any("Ricko"), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/wordKnowledge.test.ts`
Expected: FAIL — `Cannot find module '../src/wordKnowledge.ts'`

- [ ] **Step 3: Write the module**

Create `backend/src/wordKnowledge.ts`:

```ts
// ── One reading of "is this a word" ──
//
// Two callers used to answer this question separately and differently:
//
//   routes.ts   harvestForUpload     isWord = en_US(w) OR en_GB(w)
//   queue.ts    getSpellCorrections(chunk.body, "en_US")
//
// "Tobias" appears 610 times in one real manuscript. It is in en_GB and not
// in en_US. So the lexicon asked "is this a word?", got yes, and did not
// harvest it — correctly, by its own rule, since it only collects what no
// dictionary knows. Nothing then protected it. The speller asked the same
// question of en_US alone, got no, and proposed "To bias". 75 of the 125
// findings that reached the author came from that gap, including "Anima" ->
// "Anita", "Scarface" -> "Scarce" and "barque" -> "baroque".
//
// So there is one reading now. The point is not that the two dictionaries
// merge — it is that a word the OTHER English knows is a different thing
// from a word neither knows, and the caller gets told which.

import { getWordValidator } from "./spellcheck.js";

export type EnglishDialect = "american" | "british";

export interface WordVerdict {
  /** In the dictionary for the dialect this manuscript declares. */
  inDeclared: boolean;
  /**
   * In the OTHER English dictionary. Always false outside English, where
   * there is no other dictionary to ask — which is also why callers must not
   * read this as "correct elsewhere".
   */
  inOtherEnglish: boolean;
}

function otherOf(d: EnglishDialect): EnglishDialect {
  return d === "american" ? "british" : "american";
}

/**
 * The verdict on one word, or null when no dictionary is available for this
 * language — in which case callers skip rather than guess, as they already do.
 */
export function wordKnowledge(
  lang: string,
  declared: EnglishDialect = "american",
): ((word: string) => WordVerdict) | null {
  const base = lang.toLowerCase().split(/[-_]/)[0];
  if (base === "en") {
    const inDeclared = getWordValidator("en", { englishDialect: declared });
    const inOther = getWordValidator("en", {
      englishDialect: otherOf(declared),
    });
    if (!inDeclared || !inOther) return null;
    return (word) => ({
      inDeclared: inDeclared(word),
      inOtherEnglish: inOther(word),
    });
  }
  const only = getWordValidator(base);
  if (!only) return null;
  return (word) => ({ inDeclared: only(word), inOtherEnglish: false });
}

/**
 * "Does ANY dictionary for this language know the word" — the question the
 * lexicon harvest asks, because a word one English knows is not a coinage
 * whatever the other thinks.
 */
export function isWordAnywhere(
  lang: string,
  declared: EnglishDialect = "american",
): ((word: string) => boolean) | null {
  const know = wordKnowledge(lang, declared);
  if (!know) return null;
  return (word) => {
    const v = know(word);
    return v.inDeclared || v.inOtherEnglish;
  };
}
```

- [ ] **Step 4: Run the test**

Run: `cd backend && npx tsx --test test/wordKnowledge.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/wordKnowledge.ts backend/test/wordKnowledge.test.ts
git commit -m "feat(spell): one reading of whether something is a word

harvestForUpload asked en_US OR en_GB; getSpellCorrections asked en_US alone.
Tobias appears 610 times in a real manuscript, is in en_GB and not en_US, and
so was a real word to the lexicon — never harvested, never protected — and a
misspelling to the speller, which proposed 'To bias'. 75 of 125 findings came
from that gap.

The module does not merge the two dictionaries. It reports which of them
knows the word, because 'the other English knows it' and 'nobody knows it'
are different findings."
```

---

### Task 2: Raise the coinage bar to 5

**Files:**
- Modify: `backend/src/lexicon.ts:68` (`DEFAULT_MIN_COUNT`)
- Test: `backend/test/lexiconMinCount.test.ts`

**Interfaces:**
- Consumes: `harvestLexicon` from `./lexicon.js`.
- Produces: nothing new.

Measured: this closes the 3-and-4-occurrence case on its own, for two extra
findings per book. It does **not** reduce false positives — it slightly
increases them and removes false negatives, which is the trade this plan wants.

- [ ] **Step 1: Write the failing test**

Create `backend/test/lexiconMinCount.test.ts`:

```ts
// A typo made three times used to disappear.
//
// harvestLexicon collects lowercase non-dictionary words occurring at least
// DEFAULT_MIN_COUNT times as the author's coinages, and gateProtectedTerms
// then removes any correction touching one. Hunspell flagged the typo every
// time; the gate deleted it. A typo repeated three times is not rarer than a
// coinage — it is a find-and-replace slip, a habitual misspelling, or a
// character's name consistently misspelled, which are the errors most worth
// catching.

import { test } from "node:test";
import assert from "node:assert/strict";

import { initSpellchecker } from "../src/spellcheck.ts";
import { isWordAnywhere } from "../src/wordKnowledge.ts";
import { harvestLexicon } from "../src/lexicon.ts";

const PROSE = "Han gik gennem skoven en tidlig morgen. ".repeat(2);

function bookWith(word: string, times: number): string {
  const filler = Array.from(
    { length: 60 },
    (_, i) => `This is ordinary sentence number ${i} of the manuscript.`,
  ).join(" ");
  return `${filler} ${Array.from({ length: times }, () => `The ${word} was there.`).join(" ")} ${filler}`;
}

test("a coinage used three times is no longer protected", async () => {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const lex = harvestLexicon(bookWith("woth", 3), { lang: "en", isWord });
  assert.equal(
    lex.terms.some((t) => t.term.toLowerCase() === "woth"),
    false,
    "three occurrences is not enough to call it the author's word",
  );
});

test("a coinage used five times still is", async () => {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const lex = harvestLexicon(bookWith("warhammer", 5), { lang: "en", isWord });
  assert.equal(
    lex.terms.some((t) => t.term.toLowerCase() === "warhammer"),
    true,
  );
});

test("an explicit minCount still overrides the default", async () => {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const lex = harvestLexicon(bookWith("woth", 3), {
    lang: "en",
    isWord,
    minCount: 3,
  });
  assert.equal(
    lex.terms.some((t) => t.term.toLowerCase() === "woth"),
    true,
  );
});

test("PROSE is unused but keeps the Danish path honest", () => {
  assert.ok(PROSE.length > 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/lexiconMinCount.test.ts`
Expected: FAIL on the first test — `woth` IS harvested at 3.

- [ ] **Step 3: Raise the default**

In `backend/src/lexicon.ts`, change line 68:

```ts
/**
 * Occurrences before a spelling counts as the author's own word.
 *
 * Was 3. A typo made three times — a find-and-replace slip, a habitual
 * misspelling, a character's name consistently misspelled — was harvested as
 * a coinage and then deleted from the corrections by gateProtectedTerms, so
 * the layer was blind to exactly the errors most worth catching. Measured on
 * two real manuscripts, raising it to 5 closes that case for two extra
 * findings per book.
 *
 * It narrows the hole rather than closing it: a typo repeated five or more
 * times is still swallowed. The near-miss rule covers that tail.
 */
const DEFAULT_MIN_COUNT = 5;
```

- [ ] **Step 4: Run the test**

Run: `cd backend && npx tsx --test test/lexiconMinCount.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole suite**

Run: `cd backend && npm test`
Expected: PASS. If a lexicon test asserts a term harvested at 3 or 4
occurrences, it was pinning the old bar — update the fixture to 5 occurrences
and say why in a comment. Do not pass `minCount: 3` to make it pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/lexicon.ts backend/test/lexiconMinCount.test.ts
git commit -m "fix(lexicon): a typo made three times is not a coinage

The harvest collected lowercase non-dictionary words at 3+ occurrences as the
author's own, and gateProtectedTerms then deleted any correction touching
one. Hunspell flagged the typo every time; the gate removed it. So a one-off
typo was caught and a systematic one — the kind most worth catching — was
invisible.

Measured on two manuscripts: raising the bar to 5 closes the three- and
four-occurrence case for two extra findings per book. It raises false
positives slightly and removes false negatives, which is the trade."
```

---

### Task 3: The lexicon harvest asks the shared question

**Files:**
- Modify: `backend/src/routes.ts:312-329` (`harvestForUpload`)
- Test: `backend/test/lexiconHarvestDialect.test.ts`

**Interfaces:**
- Consumes: `isWordAnywhere` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `backend/test/lexiconHarvestDialect.test.ts`:

```ts
// The harvest and the speller must ask one question. This pins the half of
// that contract that lives in the harvest: a word either English knows is not
// a coinage, whichever dialect the manuscript declares.

import { test } from "node:test";
import assert from "node:assert/strict";

import { initSpellchecker } from "../src/spellcheck.ts";
import { isWordAnywhere } from "../src/wordKnowledge.ts";
import { harvestLexicon } from "../src/lexicon.ts";

function bookWith(word: string, times: number): string {
  const filler = Array.from(
    { length: 60 },
    (_, i) => `This is ordinary sentence number ${i} of the manuscript.`,
  ).join(" ");
  return `${filler} ${Array.from({ length: times }, () => `Then ${word} spoke again.`).join(" ")} ${filler}`;
}

test("a word only en_GB knows is not harvested as a coinage", async () => {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const lex = harvestLexicon(bookWith("Tobias", 12), { lang: "en", isWord });
  assert.equal(
    lex.terms.some((t) => t.term === "Tobias"),
    false,
    "en_GB knows Tobias, so it is not the author's coinage",
  );
});

test("a word neither English knows still is", async () => {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const lex = harvestLexicon(bookWith("Ricko", 12), { lang: "en", isWord });
  assert.equal(
    lex.terms.some((t) => t.term === "Ricko"),
    true,
  );
});
```

- [ ] **Step 2: Run it**

Run: `cd backend && npx tsx --test test/lexiconHarvestDialect.test.ts`
Expected: PASS already — this pins existing behaviour so Task 3's refactor
cannot change it. Note the result before continuing.

- [ ] **Step 3: Route `harvestForUpload` through the shared module**

In `backend/src/routes.ts`, replace the body of `harvestForUpload`
(lines 312-329) with:

```ts
function harvestForUpload(md: string, detected: DetectedSettings): Lexicon | undefined {
  try {
    const lang =
      detected.manuscriptLang?.status === "detected" ? detected.manuscriptLang.value : "en";
    // The SAME question the speller asks, from the same module. These two
    // used to build their own validators and disagree: the harvest accepted
    // en_US OR en_GB, the speller only en_US, and every word in the gap
    // (Tobias, Anima, Scarface, barque) was unprotected here and a
    // misspelling there. See wordKnowledge.ts.
    const declared =
      detected.englishDialect?.status === "detected"
        ? detected.englishDialect.value
        : "american";
    const isWord = isWordAnywhere(lang, declared);
    return harvestLexicon(md, { lang, isWord });
  } catch (err) {
    console.warn("[lexicon] harvest failed:", err);
    return undefined;
  }
}
```

Add the import at the top of `backend/src/routes.ts`:

```ts
import { isWordAnywhere } from "./wordKnowledge.js";
```

Remove the now-unused `getWordValidator` import from `routes.ts` **only if
nothing else in the file uses it** — check with
`grep -n getWordValidator backend/src/routes.ts` first.

- [ ] **Step 4: Run the test and the suite**

Run: `cd backend && npx tsx --test test/lexiconHarvestDialect.test.ts && npm test && npm run build`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes.ts backend/test/lexiconHarvestDialect.test.ts
git commit -m "refactor(lexicon): the harvest asks the shared word question

Same behaviour, one source. harvestForUpload built its own pair of validators
and the speller built another; that divergence is what this module exists to
end. It now also consults the DECLARED dialect rather than hard-coding
American as the primary."
```

---

### Task 4: Protected capitals are manuscript-wide

**Files:**
- Modify: `backend/src/spellcheck.ts:489-509` (`collectMidSentenceCapitals`), `:701` (`getSpellCorrections` options)
- Modify: `backend/src/queue.ts:1975-1992`
- Test: `backend/test/spellChunkIndependence.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export function collectMidSentenceCapitals(text: string, lang?: string): Set<string>` (was private)
  - `getSpellCorrections(text, lang, opts)` where `opts` gains
    `protectedNames?: Set<string>`

This is the determinism fix: a name that falls only at sentence starts inside
one chunk is unprotected in that chunk and protected in the next, and chunk
boundaries move whenever the author accepts the previous run's corrections.

- [ ] **Step 1: Write the failing test**

Create `backend/test/spellChunkIndependence.test.ts`:

```ts
// The spell layer must not care where the chunk boundaries fell.
//
// collectMidSentenceCapitals protects a capitalised word appearing
// mid-sentence in THE TEXT IT IS HANDED, and queue.ts hands it one ~2,500
// word chunk. A name that happens to sit only at sentence starts inside one
// chunk is unprotected there and protected next door. Chunk boundaries move
// when the text changes — and it changes between runs, because the author
// accepted the last run's corrections — so a second run surfaced findings the
// first did not, from code with no randomness in it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initSpellchecker,
  getSpellCorrections,
  collectMidSentenceCapitals,
} from "../src/spellcheck.ts";
import { splitIntoChunks } from "../src/chunking.ts";

// "Vashti" opens every sentence it appears in near the top, and appears
// mid-sentence only much later — so a chunk cut between the two sees an
// unprotected name.
const HEAD = Array.from(
  { length: 40 },
  (_, i) => `Vashti walked on through the ${i} quiet halls of the keep.`,
).join("\n\n");
const TAIL = Array.from(
  { length: 40 },
  (_, i) => `The captain greeted Vashti warmly on the ${i} morning of the voyage.`,
).join("\n\n");
const BOOK = `${HEAD}\n\n${TAIL}`;

function chunkedFindings(words: number): string[] {
  const names = collectMidSentenceCapitals(BOOK, "en");
  const out: string[] = [];
  for (const ch of splitIntoChunks(BOOK, words, 1)) {
    for (const c of getSpellCorrections((ch as never as { body: string }).body, "en_US", {
      protectedNames: names,
    })) {
      out.push(c.original.trim());
    }
  }
  return [...new Set(out)].sort();
}

test("the same text yields the same findings at any chunk size", async () => {
  await initSpellchecker();
  const a = chunkedFindings(1500);
  const b = chunkedFindings(2500);
  const c = chunkedFindings(5000);
  assert.deepEqual(a, b, "1500 vs 2500");
  assert.deepEqual(b, c, "2500 vs 5000");
});

test("a name seen mid-sentence anywhere in the book is protected everywhere", async () => {
  await initSpellchecker();
  assert.equal(
    chunkedFindings(1500).includes("Vashti"),
    false,
    "Vashti appears mid-sentence later in the book",
  );
});

test("the manuscript-wide set is what makes that true", async () => {
  await initSpellchecker();
  const names = collectMidSentenceCapitals(BOOK, "en");
  assert.equal(names.has("vashti"), true);
  // The head alone never shows it mid-sentence.
  assert.equal(collectMidSentenceCapitals(HEAD, "en").has("vashti"), false);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/spellChunkIndependence.test.ts`
Expected: FAIL — `collectMidSentenceCapitals` is not exported, and
`protectedNames` is not an option.

- [ ] **Step 3: Export the collector and accept an injected set**

In `backend/src/spellcheck.ts`:

1. Change `function collectMidSentenceCapitals(` (line 489) to
   `export function collectMidSentenceCapitals(` and extend its doc comment:

```ts
/**
 * ...existing comment...
 *
 * EXPORTED and computed once per MANUSCRIPT by the caller, not per chunk.
 * Handed one ~2,500-word chunk it protects whatever that chunk happened to
 * show mid-sentence, so a name sitting only at sentence starts in one chunk
 * was reported there and silent next door — and chunk boundaries move
 * whenever the author accepts the previous run's corrections. That is where
 * "a few extra spelling errors on the second run" came from: deterministic
 * code carrying chunk-dependent state.
 */
```

2. In `getSpellCorrections`'s options (line 701), add:

```ts
    /**
     * Names to protect, collected once over the whole manuscript. When
     * absent the set is computed from `text` alone, which is correct for a
     * caller passing a whole document and wrong for one passing a chunk.
     */
    protectedNames?: Set<string>;
```

3. Where `getSpellCorrections` computes `nameSet`, replace:

```ts
  const nameSet = collectMidSentenceCapitals(text, lang);
```

with:

```ts
  const nameSet = opts?.protectedNames ?? collectMidSentenceCapitals(text, lang);
```

- [ ] **Step 4: Run the test**

Run: `cd backend && npx tsx --test test/spellChunkIndependence.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Compute it once per task in the queue**

In `backend/src/queue.ts`, the spell block around line 1975. Before the
per-chunk loop that calls `getSpellCorrections`, compute the set once from
the whole unit text and reuse it. The unit's full text is the variable the
chunk loop splits — in `runEditTask` that is `sourceText`.

Add near the other per-task setup (beside `detectedDialect`, line ~1634):

```ts
  // Collected once over the WHOLE unit, not per chunk. Per chunk it protected
  // only what that chunk happened to show mid-sentence, which made the
  // findings depend on where the boundaries fell — and they move whenever the
  // author accepts the previous run's corrections.
  const { collectMidSentenceCapitals } = await import("./spellcheck.js");
  const protectedNames = collectMidSentenceCapitals(
    sourceText,
    job.manuscriptLang ?? "en",
  );
```

Then at the `getSpellCorrections` call (line ~1989), pass it:

```ts
                spellCorrections = getSpellCorrections(chunk.body, spellLang, {
                  styleGuideNames: job.styleGuide ? [job.styleGuide] : undefined,
                  protectedNames,
                });
```

- [ ] **Step 6: Run the suite and build**

Run: `cd backend && npm test && npm run build`
Expected: PASS, exit 0.

If `sourceText` is not in scope at the point you added the collection, move
the two lines to wherever the chunk loop's source text is available — it must
be the whole unit, never `chunk.body`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/spellcheck.ts backend/src/queue.ts backend/test/spellChunkIndependence.test.ts
git commit -m "fix(spell): protect names across the manuscript, not the chunk

collectMidSentenceCapitals protected a capitalised word appearing
mid-sentence in the text it was handed, and queue.ts handed it one chunk. A
name sitting only at sentence starts inside one chunk was reported there and
silent next door. Chunk boundaries move when the author accepts the previous
run's corrections, so a second run surfaced findings the first did not — from
deterministic code with no randomness in it.

Collected once per unit and passed in. The test pins the property that
matters: identical findings at chunk sizes 1500, 2500 and 5000."
```

---

### Task 5: Near-miss beats coinage

**Files:**
- Modify: `backend/src/lexicon.ts` (the coinage branch, around `:361`)
- Test: `backend/test/lexiconNearMiss.test.ts`

**Interfaces:**
- Consumes: `harvestLexicon`, `isWordAnywhere`.
- Produces: `LexiconNearMiss` entries gain coverage of dictionary words (the
  type at `lexicon.ts:43` is unchanged).

Covers the tail Task 2 leaves: a typo repeated five or more times.

- [ ] **Step 1: Write the failing test**

Create `backend/test/lexiconNearMiss.test.ts`:

```ts
// A coinage one edit from a dictionary word the book uses far more often is
// a repeated typo, not a word.
//
// The lexicon already had this idea for NAMES — "Silverhnad beside forty
// Silverhands is the typo the author wants caught" — but a typo of an
// ordinary dictionary word was not covered, and that is the one the author
// makes: a find-and-replace slip, or a habitual misspelling.

import { test } from "node:test";
import assert from "node:assert/strict";

import { initSpellchecker } from "../src/spellcheck.ts";
import { isWordAnywhere } from "../src/wordKnowledge.ts";
import { harvestLexicon } from "../src/lexicon.ts";

function book(opts: { typo?: [string, number]; coinage?: [string, number] }): string {
  const common = Array.from(
    { length: 400 },
    (_, i) => `She went with him through the ${i} halls that evening.`,
  ).join(" ");
  const typo = opts.typo
    ? Array.from({ length: opts.typo[1] }, () => `He went ${opts.typo![0]} her.`).join(" ")
    : "";
  const coin = opts.coinage
    ? Array.from({ length: opts.coinage[1] }, () => `He raised the ${opts.coinage![0]} high.`).join(" ")
    : "";
  return `${common} ${typo} ${coin} ${common}`;
}

const lex = async (md: string) => {
  await initSpellchecker();
  return harvestLexicon(md, {
    lang: "en",
    isWord: isWordAnywhere("en", "american")!,
  });
};

test("a repeated typo of a common word is a near-miss, not a coinage", async () => {
  // "woth" x8 against "with" x800.
  const l = await lex(book({ typo: ["woth", 8] }));
  assert.equal(
    l.terms.some((t) => t.term.toLowerCase() === "woth"),
    false,
    "must not be protected as the author's word",
  );
  assert.equal(
    l.nearMisses.some((n) => n.term.toLowerCase() === "woth"),
    true,
    "must be reported as a near-miss of 'with'",
  );
});

test("the near-miss names the word it is one edit from", async () => {
  const l = await lex(book({ typo: ["woth", 8] }));
  const n = l.nearMisses.find((x) => x.term.toLowerCase() === "woth");
  assert.equal(n?.of.toLowerCase(), "with");
});

test("a genuine coinage is left alone", async () => {
  // "warhammer" is nothing's near-miss.
  const l = await lex(book({ coinage: ["warhammer", 8] }));
  assert.equal(
    l.terms.some((t) => t.term.toLowerCase() === "warhammer"),
    true,
  );
  assert.equal(
    l.nearMisses.some((n) => n.term.toLowerCase() === "warhammer"),
    false,
  );
});

test("a coinage one edit from a RARE word is still a coinage", async () => {
  // The ratio is what decides. "blackwood" is one edit from nothing frequent.
  const l = await lex(book({ coinage: ["blackwood", 8] }));
  assert.equal(
    l.terms.some((t) => t.term.toLowerCase() === "blackwood"),
    true,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/lexiconNearMiss.test.ts`
Expected: FAIL — `woth` is harvested as a coinage and is not a near-miss.

- [ ] **Step 3: Implement the rule**

In `backend/src/lexicon.ts`, add above `harvestLexicon`:

```ts
/** How much more common the real word must be before the rare one reads as a
 *  typo of it rather than a word of its own. Measured on two manuscripts: at
 *  20x, an injected repeated typo is caught in both books and all seven
 *  genuine coinages — warhammer, chokehold, blackwood, snuck, lordling and
 *  the two books' names — are left alone. */
const NEAR_MISS_RATIO = 20;

/** True when `a` and `b` differ by one insertion, deletion or substitution. */
function isOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++diff > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}
```

Then, in the coinage branch (currently
`if (!isCapitalised(canonical) && inDictionary === false && canonicalCount >= minCount) {`),
before pushing the term, check for a far more frequent dictionary neighbour
and file a near-miss instead:

```ts
    if (!isCapitalised(canonical) && inDictionary === false && canonicalCount >= minCount) {
      // A coinage one edit from a dictionary word the book uses far more
      // often is a repeated typo, not a word — a find-and-replace slip, or a
      // habitual misspelling. Protecting it is what made the layer blind to
      // exactly the errors most worth catching.
      let neighbour: { word: string; count: number } | null = null;
      for (const [other, otherCount] of counts) {
        if (other === canonical) continue;
        if (otherCount < canonicalCount * NEAR_MISS_RATIO) continue;
        if (opts.isWord && !opts.isWord(other)) continue;
        if (!isOneEdit(canonical.toLowerCase(), other.toLowerCase())) continue;
        if (!neighbour || otherCount > neighbour.count) {
          neighbour = { word: other, count: otherCount };
        }
      }
      if (neighbour) {
        nearMisses.push({ term: canonical, of: neighbour.word, count: canonicalCount });
        continue;
      }
      terms.push({ term: canonical, count: canonicalCount, kind: "word", source: "harvest", enabled: true });
      continue;
    }
```

**Read the surrounding code before pasting this.** The variable names
(`counts`, `canonical`, `canonicalCount`, `nearMisses`, `terms`) must match
what `harvestLexicon` already uses; if the frequency map is named differently,
use its name. The near-miss push must match the existing `LexiconNearMiss`
shape at `lexicon.ts:43` — `{ term, of, count }`.

- [ ] **Step 4: Run the test**

Run: `cd backend && npx tsx --test test/lexiconNearMiss.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the suite and build**

Run: `cd backend && npm test && npm run build`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/lexicon.ts backend/test/lexiconNearMiss.test.ts
git commit -m "fix(lexicon): a coinage one edit from a frequent word is a typo

The lexicon already had this idea for names — Silverhnad beside forty
Silverhands — but a typo of an ordinary dictionary word was not covered, and
that is the one an author actually makes. At 20x, an injected repeated typo
is caught in both test manuscripts and all seven genuine coinages are left
alone."
```

---

### Task 6: A finding is not a suggestion

**Files:**
- Modify: `backend/src/spellcheck.ts` (`getSpellCorrections` options and the push site)
- Modify: `backend/src/queue.ts` (pass the declared dialect)
- Test: `backend/test/spellSuggestionQuality.test.ts`

**Interfaces:**
- Consumes: `wordKnowledge` from Task 1; `protectedNames` option from Task 4.
- Produces: `getSpellCorrections(text, lang, opts)` where `opts` gains
  `englishDialect?: string`. A `Correction` whose suggestion was withheld
  carries `corrected === original` and `reason: "spell-check-unknown"`.

The layer keeps reporting every word it does not recognise. It offers a
replacement only when it can vouch for one. This is the rule two withdrawn
draft rules got backwards — the guess is what is wrong, not the finding.

- [ ] **Step 1: Write the failing test**

Create `backend/test/spellSuggestionQuality.test.ts`:

```ts
// Report the word; withhold the guess.
//
// Measured on two real manuscripts, the suggestions were the damaging part:
// "Tobias" (610 occurrences) -> "To bias", "seagrass" -> "Seagram",
// "Krogman" -> "Frogman", "sworddancers" -> "sword dancers". Every one of
// those words is worth REPORTING — a misspelled character name is among the
// most important things to catch before publishing — and none of those
// replacements is worth proposing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { initSpellchecker, getSpellCorrections } from "../src/spellcheck.ts";

const opts = { englishDialect: "american" } as const;

/** The correction for one word, if the layer reports it at all. */
async function only(text: string) {
  await initSpellchecker();
  const cs = getSpellCorrections(text, "en_US", opts as never);
  return cs[0];
}

test("a word the other English knows is reported without a guess", async () => {
  const c = await only("Then Tobias spoke again to the captain of the ship.");
  assert.ok(c, "Tobias must still be REPORTED");
  assert.equal(c.corrected, c.original, "but no replacement is proposed");
  assert.equal(c.reason, "spell-check-unknown");
});

test("a lowercase word is never given a Capitalised replacement", async () => {
  const c = await only("The seagrass swayed in the shallow water below them.");
  if (c && c.corrected !== c.original) {
    assert.ok(
      !/^\p{Lu}/u.test(c.corrected),
      `proposed a capitalised replacement: ${c.corrected}`,
    );
  }
});

test("a closed compound is not split by a bare space insertion", async () => {
  const c = await only("The sworddancers moved together across the sand.");
  if (c && c.corrected !== c.original) {
    assert.notEqual(
      c.corrected.replace(/\s+/g, ""),
      c.original.replace(/\s+/g, ""),
      "the only difference was a space",
    );
  }
});

test("eye-dialect keeps its spelling", async () => {
  const c = await only("\u2018Per\u2019aps,\u2019 he said, \u2018we should wait here.\u2019");
  if (c) assert.equal(c.corrected, c.original);
});

test("a capitalised unknown is reported but never guessed at", async () => {
  const c = await only("Then Krogman turned away from the fire without speaking.");
  assert.ok(c, "Krogman must still be REPORTED — a misspelled name matters");
  assert.equal(c.corrected, c.original, "Frogman is not a proposal worth making");
});

test("an ordinary typo still gets its suggestion", async () => {
  const c = await only("He walked thruogh the hall and out into the yard.");
  assert.ok(c);
  assert.notEqual(c.corrected, c.original, "this one the dictionary can vouch for");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/spellSuggestionQuality.test.ts`
Expected: FAIL — `Tobias` comes back as `To bias`, and `reason` is not
`spell-check-unknown`.

- [ ] **Step 3: Add the dialect option and the suggestion gates**

In `backend/src/spellcheck.ts`, add to `getSpellCorrections`'s options:

```ts
    /**
     * The manuscript's declared English dialect. Lets a word the OTHER
     * English knows be told from one no dictionary knows: "Tobias" is in
     * en_GB and not en_US, and "To bias" is never the right proposal for it.
     */
    englishDialect?: string;
```

Add this helper beside `isConfidentSuggestion`:

```ts
/**
 * Whether a proposed replacement is worth showing at all.
 *
 * The word is reported either way — this decides only whether a REPLACEMENT
 * rides along. Measured on two real manuscripts, the suggestions were the
 * damaging part of the layer while the findings were merely noisy.
 */
export function suggestionIsWorthOffering(
  original: string,
  suggestion: string,
): boolean {
  const o = original.trim();
  const s = suggestion.trim();
  if (!s || s === o) return false;
  // A lowercase word never wants a Capitalised replacement: "seagrass" ->
  // "Seagram", "southlander's" -> "Netherlander's".
  if (/^\p{Ll}/u.test(o) && /^\p{Lu}/u.test(s)) return false;
  // A bare space insertion into a closed compound: "sworddancers" ->
  // "sword dancers", "woodsmoke" -> "wood smoke". The author wrote one word
  // on purpose often enough that guessing otherwise is not worth it.
  if (o.replace(/\s+/g, "") === s.replace(/\s+/g, "")) return false;
  // Eye-dialect: an inner apostrophe standing in for dropped letters
  // ("Per'aps", "s'pose", "G'evening"), or a stretched interjection
  // ("Shhh", "Mhmm"). Deliberate, every time.
  if (/[’']/.test(o) && !/[’']s$/i.test(o)) return false;
  if (/(.){2,}/iu.test(o)) return false;
  // A capitalised unknown is a name. "Krogman" -> "Frogman" is not a
  // proposal; the NAME is still reported, which is the point.
  if (/^\p{Lu}/u.test(o)) return false;
  return true;
}
```

Then at the site where `getSpellCorrections` pushes a correction, decide the
suggestion separately from the finding:

```ts
      // A word the other English knows is not a misspelling at all — it is a
      // name or a term, and the dictionary has nothing to offer for it.
      const verdict = know?.(word);
      const suggestion =
        verdict?.inOtherEnglish || !suggestionIsWorthOffering(word, best)
          ? word
          : best;
      out.push({
        original: word,
        corrected: suggestion,
        reason: suggestion === word ? "spell-check-unknown" : "spell-check",
      } as Correction);
```

where `know` is built once at the top of `getSpellCorrections`:

```ts
  const { wordKnowledge } = await import("./wordKnowledge.js");
```

**`getSpellCorrections` is synchronous.** Import `wordKnowledge` statically
at the top of the file instead — `wordKnowledge.ts` imports
`getWordValidator` from this file, so use `import type` plus a lazy local
`require`-free call, or move `wordKnowledge` to accept the two validators as
arguments. Read both files and pick whichever avoids the import cycle; the
simplest is for `getSpellCorrections` to call `getWordValidator` for the
other dialect directly, since it is in the same module.

- [ ] **Step 4: Add `spell-check-unknown` to the deterministic guard**

In `backend/src/correctionSeverity.ts`, `isDeterministicCorrection` already
lists `spell-check` and `spell-check-uncommon`. Add:

```ts
    // A word no dictionary knows, reported with no replacement. Still the
    // dictionary talking.
    reason === "spell-check-unknown" ||
```

- [ ] **Step 5: Pass the dialect from the queue**

In `backend/src/queue.ts`, at the `getSpellCorrections` call, add the option
beside `protectedNames`:

```ts
                  englishDialect: dialect,
```

- [ ] **Step 6: Run the tests, suite and build**

Run: `cd backend && npx tsx --test test/spellSuggestionQuality.test.ts && npm test && npm run build`
Expected: PASS, exit 0.

A correction whose `corrected` equals its `original` will be removed by
`dropNoOpCorrections` (`correctionHygiene.ts:575`). Carve `spell-check-unknown`
out there the same way `quote-style` is, or the findings vanish:

```ts
    if (c.reason === "spell-check-unknown") return true;
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/spellcheck.ts backend/src/queue.ts backend/src/correctionSeverity.ts backend/src/correctionHygiene.ts backend/test/spellSuggestionQuality.test.ts
git commit -m "feat(spell): report the word, withhold the guess

Measured on two manuscripts, the suggestions were the damaging part while the
findings were merely noisy: Tobias (610 occurrences) -> 'To bias', seagrass ->
'Seagram', Krogman -> 'Frogman', sworddancers -> 'sword dancers'. Every one of
those words is worth reporting — a misspelled character name is among the most
important things to catch before publishing — and none of those replacements
is worth proposing.

A word the other English knows gets no replacement at all; nor does a
lowercase word offered a capitalised one, a closed compound offered a space,
eye-dialect, or a capitalised unknown."
```

---

### Task 7: Deterministic findings skip the reviewer

**Files:**
- Modify: `backend/src/queue.ts` (where `spellCorrections` are merged, around `:2485`)
- Test: `backend/test/spellPreApproved.test.ts`

**Interfaces:**
- Consumes: `isDeterministicCorrection` from `./correctionSeverity.js`.
- Produces: nothing new.

Whether a dictionary finding reads as a finding or as a suggestion should not
vary between two runs over identical text. It currently does: the reviewer
decides applied-vs-flagged, and the reviewer is an LLM.

- [ ] **Step 1: Write the failing test**

Create `backend/test/spellPreApproved.test.ts`:

```ts
// A dictionary is not an opinion to be out-voted.
//
// isDeterministicCorrection already stops the PRECISION pass deleting these —
// doing so cost German misspelling recall 68% -> 30%. The same argument
// covers flagging: whether a dictionary finding reads as a finding or as a
// suggestion should not differ between two runs over the same text, and the
// reviewer that decides it is an LLM.

import { test } from "node:test";
import assert from "node:assert/strict";

import { isDeterministicCorrection } from "../src/correctionSeverity.ts";
import { markDeterministicPreApproved } from "../src/queue.ts";

test("a spell-check correction comes back pre-approved", () => {
  const cs = markDeterministicPreApproved([
    { original: "thruogh", corrected: "through", reason: "spell-check" },
  ] as never);
  assert.equal(cs[0].preApproved, true);
});

test("so do the other deterministic producers", () => {
  const cs = markDeterministicPreApproved([
    { original: "a", corrected: "b", reason: "spell-check-unknown" },
    { original: "c", corrected: "d", reason: "retext:doubled-word" },
    { original: "e", corrected: "f", reason: "grammar:COMMA" },
    { original: "g", corrected: "h", reason: "dialect" },
  ] as never);
  for (const c of cs) assert.equal(c.preApproved, true, c.reason);
});

test("an editor's own correction is untouched", () => {
  const cs = markDeterministicPreApproved([
    { original: "a", corrected: "b" },
  ] as never);
  assert.equal(cs[0].preApproved, undefined);
});

test("the guard and the marker agree", () => {
  for (const reason of ["spell-check", "dialect", "retext:x", "grammar:y"]) {
    const c = { original: "a", corrected: "b", reason } as never;
    assert.equal(
      isDeterministicCorrection(c),
      markDeterministicPreApproved([c])[0].preApproved === true,
      reason,
    );
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/spellPreApproved.test.ts`
Expected: FAIL — `markDeterministicPreApproved` is not exported from
`queue.ts`.

- [ ] **Step 3: Add the marker**

In `backend/src/queue.ts`, near the other correction helpers, add:

```ts
/**
 * Mark every deterministic finding pre-approved, so the reviewer never sees
 * it.
 *
 * A dictionary saying a word is absent, LanguageTool saying a comma is
 * missing, or a confusable pattern scored on a corpus, are not judgements for
 * a model to second-guess. The precision pass already refuses to DELETE
 * them — measured, deleting them cost German misspelling recall 68% -> 30%
 * and German comma recall 68% -> 5%. This extends the same reasoning to
 * flagging, which is what made two runs over identical text present the same
 * finding differently. It also saves the tokens spent asking.
 */
export function markDeterministicPreApproved(cs: Correction[]): Correction[] {
  for (const c of cs) {
    if (isDeterministicCorrection(c)) c.preApproved = true;
  }
  return cs;
}
```

Import `isDeterministicCorrection` in `queue.ts` if it is not already there.

- [ ] **Step 4: Call it where the deterministic bucket is assembled**

In `backend/src/queue.ts`, at the merge site (around line 2485, immediately
after the `for (const sc of spellCorrections) sc.reason ??= "spell-check";`
loop):

```ts
          markDeterministicPreApproved(spellCorrections);
```

- [ ] **Step 5: Run the tests, suite and build**

Run: `cd backend && npx tsx --test test/spellPreApproved.test.ts && npm test && npm run build`
Expected: PASS, exit 0.

If a queue test asserts a reviewer score on a spell correction, it was
pinning the old routing — read it, and update it to assert `preApproved`
instead.

- [ ] **Step 6: Commit**

```bash
git add backend/src/queue.ts backend/test/spellPreApproved.test.ts
git commit -m "fix(review): a dictionary is not an opinion to be out-voted

The precision pass already refused to delete a deterministic finding —
deleting them cost German misspelling recall 68% -> 30%. But the reviewer
still decided applied-vs-flagged, so the same finding over the same text read
differently between two runs. Deterministic findings are pre-approved now and
skip the reviewer, which also saves the tokens spent asking a model to
second-guess a dictionary."
```

---

### Task 8: Measure the whole thing

**Files:**
- Create: `backend/test/spellRecall.test.ts`
- Modify: `backend/src/spellcheck.ts` (record the result in the header)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

This is the task the plan exists for. Tasks 1–7 are each locally testable;
only here do the numbers that justified them get pinned.

- [ ] **Step 1: Write the recall harness**

Create `backend/test/spellRecall.test.ts`:

```ts
// Recall, measured by injection.
//
// Skipped unless the corpus is present — the manuscripts are the author's own
// and are not checked in. Get them with scripts/fetch-confusable-corpus.sh.
//
// Baseline before this work (2026-09-23): 196/200 and 194/200 one-off typos
// caught, and EVERY miss was a typo injected three or more times, which the
// lexicon harvested as a coinage and the gate then deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  initSpellchecker,
  getSpellCorrections,
  collectMidSentenceCapitals,
} from "../src/spellcheck.ts";
import { isWordAnywhere } from "../src/wordKnowledge.ts";
import {
  harvestLexicon,
  protectedTermsOf,
  gateProtectedTerms,
} from "../src/lexicon.ts";

const DIR = "/tmp/quote-corpus";
const have = existsSync(`${DIR}/rage.md`) && existsSync(`${DIR}/taker.md`);

/** Deterministic PRNG — the run must be repeatable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296);
}

/** Everything the author would actually see, for one manuscript. */
async function findingsFor(md: string): Promise<Set<string>> {
  await initSpellchecker();
  const isWord = isWordAnywhere("en", "american")!;
  const prot = protectedTermsOf(harvestLexicon(md, { lang: "en", isWord }));
  const names = collectMidSentenceCapitals(md, "en");
  const cs = getSpellCorrections(md, "en_US", { protectedNames: names });
  return new Set(
    gateProtectedTerms(cs, prot).kept.map((c) =>
      c.original.trim().replace(/[^\p{L}'’-]/gu, "").toLowerCase(),
    ),
  );
}

test("one-off typos: recall stays at or above 97%", { skip: !have }, async () => {
  await initSpellchecker();
  const us = isWordAnywhere("en", "american")!;
  for (const f of ["rage", "taker"]) {
    const clean = readFileSync(`${DIR}/${f}.md`, "utf8");
    const rand = rng(20260923);
    const cands = [...clean.matchAll(/\b[a-z]{5,}\b/g)];
    const injected: { from: string; to: string }[] = [];
    const used = new Set<number>();
    let guard = 0;
    let dirty = clean;
    const edits: { at: number; from: string; to: string }[] = [];
    while (injected.length < 100 && guard++ < 20000) {
      const pick = cands[Math.floor(rand() * cands.length)];
      if (!pick || used.has(pick.index!)) continue;
      const w = pick[0];
      const i = 1 + Math.floor(rand() * (w.length - 2));
      const bad = w.slice(0, i) + w[i] + w.slice(i); // doubled letter
      if (us(bad)) continue;
      used.add(pick.index!);
      injected.push({ from: w, to: bad });
      edits.push({ at: pick.index!, from: w, to: bad });
    }
    for (const e of [...edits].sort((a, b) => b.at - a.at)) {
      dirty = dirty.slice(0, e.at) + e.to + dirty.slice(e.at + e.from.length);
    }
    const found = await findingsFor(dirty);
    const hit = injected.filter((i) => found.has(i.to.toLowerCase())).length;
    assert.ok(
      hit / injected.length >= 0.97,
      `${f}: ${hit}/${injected.length} one-off typos caught`,
    );
  }
});

test("a typo repeated 3, 5 and 10 times is caught every time", { skip: !have }, async () => {
  const clean = readFileSync(`${DIR}/rage.md`, "utf8");
  for (const times of [3, 5, 10]) {
    let done = 0;
    const dirty = clean.replace(/\bwith\b/g, (m) => (done++ < times ? "woth" : m));
    const found = await findingsFor(dirty);
    assert.ok(found.has("woth"), `a typo repeated ${times} times was swallowed`);
  }
});

test("the genuine coinages are still protected", { skip: !have }, async () => {
  for (const [f, words] of [
    ["rage", ["warhammer"]],
    ["taker", ["blackwood", "snuck"]],
  ] as const) {
    const found = await findingsFor(readFileSync(`${DIR}/${f}.md`, "utf8"));
    for (const w of words) {
      assert.equal(found.has(w), false, `${w} should be the author's word`);
    }
  }
});

test("Tobias is never proposed as 'To bias'", { skip: !have }, async () => {
  await initSpellchecker();
  const md = readFileSync(`${DIR}/taker.md`, "utf8");
  const isWord = isWordAnywhere("en", "american")!;
  const prot = protectedTermsOf(harvestLexicon(md, { lang: "en", isWord }));
  const names = collectMidSentenceCapitals(md, "en");
  const cs = gateProtectedTerms(
    getSpellCorrections(md, "en_US", { protectedNames: names }),
    prot,
  ).kept;
  const bad = cs.filter((c) => /^To bias/.test(c.corrected ?? ""));
  assert.deepEqual(bad, [], JSON.stringify(bad));
});
```

- [ ] **Step 2: Run it**

Run: `cd backend && ./../scripts/fetch-confusable-corpus.sh && npx tsx --test test/spellRecall.test.ts`
Expected: PASS, 4 tests.

If `Tobias is never proposed as 'To bias'` fails, Task 6 is incomplete —
the `englishDialect` option is not reaching `getSpellCorrections`, or the
`inOtherEnglish` branch is not suppressing the replacement. Fix it there, not
here.

- [ ] **Step 3: Run the whole suite and both builds**

Run: `cd backend && npm test && npm run build`
Expected: PASS, exit 0.

Run: `cd frontend && npm run build`
Expected: exit 0.

- [ ] **Step 4: Record the measurement in the module header**

Add to the top of `backend/src/spellcheck.ts`, with the real numbers:

```ts
// MEASURED on two real manuscripts (2026-09-23).
//
//   BEFORE  one-off typos caught          196/200 and 194/200
//           typos repeated 3+ times       0 — harvested as coinages, gate
//                                         deleted the corrections
//           corrections reaching author   125, of which ~2 were genuine
//           worst finding                 "Tobias" (610 occurrences) -> "To bias"
//
//   AFTER   <fill in from spellRecall.test.ts and a corpus run>
//
// The tests that pin this are spellRecall.test.ts (recall, injection) and
// spellChunkIndependence.test.ts (the same findings at any chunk size).
```

- [ ] **Step 5: Commit**

```bash
git add backend/test/spellRecall.test.ts backend/src/spellcheck.ts
git commit -m "test(spell): pin recall by injection, and the two holes closed

Skipped unless the corpus is present — the manuscripts are the author's own.
One-off recall stays at or above 97%; a typo repeated 3, 5 and 10 times is
now caught every time where all three were swallowed before; the genuine
coinages stay protected; and Tobias is never proposed as 'To bias'."
```

---

## Notes for the implementer

- **Never suppress a finding to reduce noise.** This is the last check before
  publication. Suppress the *suggestion* — report the word, withhold the
  guess. Two rules were withdrawn from an earlier draft of the spec for
  getting this backwards.
- **Never delete a deterministic finding on a model's say-so.** Measured at
  68% → 30% German misspelling recall. `isDeterministicCorrection`
  (`correctionSeverity.ts:48`) is the guard; if you add a new `reason`, add it
  there.
- **Task 5's paste is approximate on purpose.** `harvestLexicon`'s internal
  variable names must be read from the file — the plan cannot guarantee them
  and a blind paste will not compile. The *rule* is exact; the bindings are
  yours to match.
- **Task 8 is not optional.** Tasks 1–7 are locally testable but only Task 8
  demonstrates the thing the plan is for: that recall went up and nothing
  fabricated survives.
- **If a lexicon test fails after Task 2**, it was pinning the old bar of 3.
  Update the fixture to 5 occurrences and comment why. Do not pass
  `minCount: 3` to make it green.
