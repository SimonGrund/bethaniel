# Confusable Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch real-word errors a dictionary can never see — `form` for `from`, `their` for `there`, `mand` for `man` — deterministically, so the same manuscript yields the same findings on every run.

**Architecture:** One new module, `backend/src/confusablePatterns.ts`, holding a table of narrow high-precision patterns with a word substitution each, plus an engine that turns matches into `Correction`s. A second, `confusableBalance.ts`, lists the rare member of a set the book otherwise leans on — what patterns cannot reach. Both wired into `queue.ts` beside the retext checks. Independent of the spelling-layer plan (`2026-09-23-spelling-layer.md`) — ships on its own.

**Tech Stack:** TypeScript, `node:test` via the `tsx` loader. No new dependencies.

## Global Constraints

- **Tests:** `cd backend && npm test`. Single file: `cd backend && npx tsx --test test/<name>.test.ts`. `node:test` + `node:assert/strict` only.
- **Every pattern must earn its place with two numbers:** it catches its planted sentence, and it fires as close to zero as possible on the corpus. A pattern with neither is not added.
- **Precision over coverage here.** These run on every proofread of every manuscript. A pattern that fires on correct prose trains the author to ignore the whole category — the opposite of the spec's recall goal, which is about the *dictionary* layer.
- **Deterministic.** No LLM, no randomness, no clock. Identical output for identical input, whatever the chunk size.
- **Existing module untouched in spirit:** `confusables.ts` stays exactly as it is. It answers "which confusable sets does this text use", for the LLM prompt hint. This plan adds a *second, independent* answer: "this specific phrasing is wrong". Do not merge them.
- **English corpus:** the two manuscripts at `/tmp/quote-corpus/{rage,taker}.md` — 203,000 words, contemporary. Extract per Task 1.
- **Danish corpus:** six public-domain texts, 333,455 words, Gutenberg ids `24747 33360 34178 35102 36942 41072`. Extract per Task 1. **19th/early-20th century orthography** — zero hits there is weaker evidence than on the English corpus. This is recorded in the spec and must be repeated in the module header.

---

### Task 1: The corpus harness

**Files:**
- Create: `backend/test/confusableCorpus.test.ts`
- Create: `scripts/fetch-confusable-corpus.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: a skipped-unless-present test harness that later tasks extend, and a documented way to obtain the corpora.

The corpora are not checked in — the English ones are the user's own manuscripts, the Danish ones are 1.5 MB of public-domain text. Every pattern task adds its rows to this one harness.

- [ ] **Step 1: Write the fetch script**

Create `scripts/fetch-confusable-corpus.sh`:

```bash
#!/bin/bash
# Corpora for scoring the confusable patterns. Not checked in: the English
# texts are the author's own manuscripts, the Danish ones are 1.5 MB of
# public-domain prose.
#
# English — the two manuscripts of the 2026-09-23 runs, from the installed
# app's database. Contemporary prose, which is what makes a zero-hit result
# on them strong evidence.
#
# Danish — Project Gutenberg. 19th/early-20th century orthography (aa for å,
# capitalised nouns), so a zero-hit result is WEAKER evidence than on the
# English side. See the header of confusablePatterns.ts.
set -euo pipefail
OUT=/tmp/quote-corpus
mkdir -p "$OUT"

DB="$HOME/Library/Application Support/Bethaniel/data/bethaniel.db"
if [ -f "$DB" ]; then
  sqlite3 "$DB" "select md from documents where name like 'Rage of the Rule-r56%' order by uploaded_at desc limit 1;" > "$OUT/rage.md" || true
  sqlite3 "$DB" "select md from documents where name like 'Path of the Taker 3.5%' order by uploaded_at desc limit 1;" > "$OUT/taker.md" || true
fi

for id in 24747 33360 34178 35102 36942 41072; do
  [ -s "$OUT/da_$id.txt" ] && continue
  curl -sL -m 60 "https://www.gutenberg.org/cache/epub/$id/pg$id.txt" -o "$OUT/da_$id.txt"
done

wc -c "$OUT"/*.md "$OUT"/da_*.txt 2>/dev/null || true
```

Make it executable: `chmod +x scripts/fetch-confusable-corpus.sh`

- [ ] **Step 2: Write the harness with one failing row**

Create `backend/test/confusableCorpus.test.ts`:

```ts
// Every confusable pattern is scored twice: it must catch its planted
// sentence, and it must fire as close to zero as possible on real prose.
//
// Skipped unless the corpora are present — they are not checked in. Get them
// with scripts/fetch-confusable-corpus.sh.
//
// The Danish corpus is 19th/early-20th century, so a zero-hit result there is
// weaker evidence than on the contemporary English manuscripts. Three
// candidate patterns were nonetheless killed by it during design; see the
// header of confusablePatterns.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";

import {
  CONFUSABLE_PATTERNS,
  findConfusablePatterns,
} from "../src/confusablePatterns.ts";

const DIR = "/tmp/quote-corpus";

function loadEnglish(): string[] {
  return ["rage.md", "taker.md"]
    .filter((f) => existsSync(`${DIR}/${f}`))
    .map((f) => readFileSync(`${DIR}/${f}`, "utf8"));
}

function loadDanish(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => /^da_\d+\.txt$/.test(f))
    .map((f) => readFileSync(`${DIR}/${f}`, "utf8"))
    // The Gutenberg search returns the odd English-language title; a Danish
    // text is identifiable by its æ/ø/å.
    .filter((raw) => (raw.match(/[æøåÆØÅ]/g) ?? []).length > 500);
}

const en = loadEnglish();
const da = loadDanish();

/** Total hits for one pattern id across a set of texts. */
function hitsFor(id: string, texts: string[]): number {
  let n = 0;
  for (const t of texts) {
    n += findConfusablePatterns(t, id.startsWith("da-") ? "da" : "en").filter(
      (c) => c.reason === `confusable:${id}`,
    ).length;
  }
  return n;
}

test("every pattern catches its own planted sentence", () => {
  for (const p of CONFUSABLE_PATTERNS) {
    const found = findConfusablePatterns(p.planted, p.lang);
    assert.ok(
      found.some((c) => c.reason === `confusable:${p.id}`),
      `${p.id} did not catch its planted sentence: ${p.planted}`,
    );
  }
});

test("every pattern proposes a correction that differs from the original", () => {
  for (const p of CONFUSABLE_PATTERNS) {
    for (const c of findConfusablePatterns(p.planted, p.lang)) {
      assert.notEqual(c.original, c.corrected, `${p.id} proposed a no-op`);
    }
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/confusableCorpus.test.ts`
Expected: FAIL — `Cannot find module '../src/confusablePatterns.ts'`

- [ ] **Step 4: Commit the harness and script**

```bash
chmod +x scripts/fetch-confusable-corpus.sh
git add scripts/fetch-confusable-corpus.sh backend/test/confusableCorpus.test.ts
git commit -m "test(confusables): the harness that scores a pattern twice

A pattern earns its place with two numbers: it catches its planted sentence,
and it fires as close to zero as possible on real prose. Corpora are not
checked in — the English texts are the author's manuscripts, the Danish ones
1.5 MB of public-domain prose — so the harness skips without them."
```

---

### Task 2: The module and the engine

**Files:**
- Create: `backend/src/confusablePatterns.ts`
- Create: `backend/test/confusablePatterns.test.ts`

**Interfaces:**
- Consumes: `Correction` from `./types.js`.
- Produces:
  - `interface ConfusablePattern { id: string; lang: "en" | "da"; source: string; wrong: string; right: string; note: string; planted: string }`
  - `const CONFUSABLE_PATTERNS: readonly ConfusablePattern[]`
  - `function findConfusablePatterns(text: string, lang?: string): Correction[]`

Each pattern is a regex plus a **word substitution**: the matched span is
rewritten by replacing `wrong` with `right` inside it. That keeps every
pattern one data row rather than a function, so adding one is a two-line
change that the harness scores automatically.

- [ ] **Step 1: Write the failing test**

Create `backend/test/confusablePatterns.test.ts`:

```ts
// The engine, tested apart from the pattern table: substitution, case
// preservation, span shape, and the language gate.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findConfusablePatterns } from "../src/confusablePatterns.ts";

test("a match becomes a correction over the matched span only", () => {
  const cs = findConfusablePatterns("He read the letter form the king.", "en");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].original, "form the");
  assert.equal(cs[0].corrected, "from the");
  assert.equal(cs[0].reason, "confusable:form-det");
});

test("an initial capital survives the substitution", () => {
  const cs = findConfusablePatterns("Weather or not they come, we sail.", "en");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "Whether or not");
});

test("a Danish substitution replaces the right word", () => {
  const cs = findConfusablePatterns("Der stod en man ved døren.", "da");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].original, "en man");
  assert.equal(cs[0].corrected, "en mand");
});

test("a two-word wrong form collapses to one word", () => {
  const cs = findConfusablePatterns("Han kom til bage om aftenen.", "da");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "tilbage");
});

test("patterns of another language do not run", () => {
  // "en man" is Danish; an English manuscript must not be scored against it.
  assert.equal(findConfusablePatterns("Der stod en man ved døren.", "en").length, 0);
  assert.equal(findConfusablePatterns("He read the letter form the king.", "da").length, 0);
});

test("a language with no table returns nothing", () => {
  assert.deepEqual(findConfusablePatterns("Il lut la lettre form le roi.", "fr"), []);
});

test("an absent language is treated as English", () => {
  // queue.ts passes job.manuscriptLang, which can be undefined.
  assert.equal(findConfusablePatterns("He read the letter form the king.").length, 1);
});

test("every correction carries a reason the precision pass recognises", () => {
  const cs = findConfusablePatterns("He could of told me sooner.", "en");
  assert.equal(cs.length, 1);
  assert.ok(cs[0].reason?.startsWith("confusable:"));
});

test("repeated hits in one text are all reported", () => {
  const cs = findConfusablePatterns(
    "He read the letter form the king. The soldiers came form the north.",
    "en",
  );
  assert.equal(cs.length, 2);
});

test("the same span is never reported twice", () => {
  const cs = findConfusablePatterns("Its a long way and its a cold one.", "en");
  const keys = cs.map((c) => `${c.original}→${c.corrected}`);
  assert.equal(new Set(keys).size <= keys.length, true);
  for (const c of cs) assert.notEqual(c.original, c.corrected);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/confusablePatterns.test.ts`
Expected: FAIL — `Cannot find module '../src/confusablePatterns.ts'`

- [ ] **Step 3: Write the module with the engine and the two patterns the tests need**

Create `backend/src/confusablePatterns.ts`:

```ts
// ── Real-word errors, caught by shape ──
//
// A dictionary cannot help with `form` for `from`, `their` for `there`, or
// `mand` for `man`: both members are real words. Two layers already try.
// LanguageTool catches about half of the English cases and NONE of the four
// canonical Danish ones, and its coverage is patchy per SENTENCE rather than
// per pair — measured on the bundled jar, it catches "on there own shelf" and
// misses "left there boots on the deck", catches "too quite" and misses
// "very quite". And confusables.ts feeds a hint into the LLM prompt, which
// makes the catch a model's decision and therefore different between two runs
// over the same text.
//
// So: narrow patterns, deterministic, each one scored twice before it is
// added — it must catch its planted sentence, and it must fire as close to
// zero as possible on real prose. Measured on 203,000 words of contemporary
// English and 333,455 words of Danish; see confusableCorpus.test.ts.
//
// WHAT THE CORPUS KILLED, so it is not re-proposed:
//
//   - `ud af (døren|vinduet)` → `ud ad` fired 4x. Prescriptive Danish wants
//     `ud ad`, but `ud af døren` is ordinary usage. A style preference, not
//     an error.
//   - `den man` → `mand` fired on "den man vil se". `den man` is a valid
//     relative construction in modern Danish too ("den man elsker"), so
//     `den` is not in the determiner list below.
//   - comparative + `en` first read "snarere en Grød" and "større en Dag" as
//     errors; both are a comparative followed by an article. It is narrowed
//     to comparative + `en` + PRONOUN, and `snarere` is gone — it takes `en`
//     legitimately.
//
// TWO TRAPS, likewise:
//
//   - Danish `og`/`at` cannot be separated by verb morphology. An exclusion
//     for past tense written as `-te` also excludes the infinitives `hente`,
//     `vente` and `lytte`. Hence a closed list of infinitives after `og`.
//   - A bare Danish verb stem is usually also a noun: `forsøg og skrive`
//     matched "et sidste Forsøg og skrive". Only INFLECTED forms are listed.
//
// CORPUS CAVEAT: the only public-domain Danish available is 19th and
// early-20th century — `aa` for `å`, capitalised nouns, older usage. A
// zero-hit result there is weaker evidence than on the English side, which is
// contemporary. The Danish patterns should be re-scored on a modern Danish
// manuscript before anyone leans on them hard.

import type { Correction } from "./types.js";

export interface ConfusablePattern {
  id: string;
  lang: "en" | "da";
  /** RegExp source. Stored as a string so every call gets a fresh lastIndex. */
  source: string;
  /** The word (or two words) inside the match that is wrong. */
  wrong: string;
  /** What it should be. */
  right: string;
  note: string;
  /** A sentence this pattern must catch. Scored by confusableCorpus.test.ts. */
  planted: string;
}

/** Danish infinitives that may follow `og` where `at` was meant. Closed, for
 *  the reason in the header: morphology cannot tell `hente` from `mødte`. */
const DA_INFINITIVE =
  "(græde|le|grine|gå|komme|se|høre|tale|sige|spise|drikke|sove|løbe|skrive|læse|arbejde|hjælpe|tænke|vente|hente|kigge|snakke|synge|danse|rejse|blive|tage|give|finde|lytte|spørge|svare|betale|købe|sælge)";

export const CONFUSABLE_PATTERNS: readonly ConfusablePattern[] = [
  {
    id: "form-det",
    lang: "en",
    // "form" is a noun and a verb; before a determiner it is almost always
    // "from". Excluded after a modal or auxiliary, which is the one real
    // false positive the corpus produced: "couldn't form the words".
    source:
      "(?<!\\b(?:to|can|could|couldn't|will|would|might|must|may|should|helps?|helped|began|begin|begins)\\s)\\bform\\s+(?:the|a|an|his|her|their|its|my|your|our|this|that|these|those)\\b",
    wrong: "form",
    right: "from",
    note: "\"form\" before a determiner is almost always \"from\".",
    planted: "He read the letter form the king.",
  },
  {
    id: "weather-or-not",
    lang: "en",
    source: "\\bweather\\s+or\\s+not\\b",
    wrong: "weather",
    right: "whether",
    note: "\"weather or not\" is always \"whether or not\".",
    planted: "Weather or not they come, we sail.",
  },
  {
    id: "modal-of",
    lang: "en",
    source: "\\b(?:could|would|should|must|might)\\s+of\\b",
    wrong: "of",
    right: "have",
    note: "A modal takes \"have\", not \"of\".",
    planted: "He could of told me sooner.",
  },
  {
    id: "its-a",
    lang: "en",
    source: "\\bits\\s+(?:a|an)\\s",
    wrong: "its",
    right: "it's",
    note: "\"its\" is possessive; before an article it is \"it's\".",
    planted: "Its a long way to the isles.",
  },
  {
    id: "da-en-man",
    lang: "da",
    // "den" is deliberately absent — see the header.
    source: "\\b(?:en|denne|gamle|unge|store|anden|hver)\\s+man\\b",
    wrong: "man",
    right: "mand",
    note: "Efter en artikel er det \"mand\", ikke pronominet \"man\".",
    planted: "Der stod en man ved døren.",
  },
  {
    id: "da-til-bage",
    lang: "da",
    source: "\\btil\\s+bage\\b",
    wrong: "til bage",
    right: "tilbage",
    note: "\"tilbage\" skrives i ét ord.",
    planted: "Han kom til bage om aftenen.",
  },
];

/** Which table applies. An absent tag is English, as elsewhere in the app. */
function tableFor(lang?: string): ConfusablePattern[] {
  const key = (lang ?? "en").toLowerCase().split(/[-_]/)[0];
  if (key !== "en" && key !== "da") return [];
  return CONFUSABLE_PATTERNS.filter((p) => p.lang === key);
}

/**
 * Replace `wrong` with `right` inside one matched span, keeping an initial
 * capital. "Weather or not" must come back as "Whether or not", not
 * "whether or not" — a correction that also changes the capitalisation reads
 * as two changes and invites the author to reject both.
 */
function substitute(span: string, wrong: string, right: string): string {
  const at = span.toLowerCase().indexOf(wrong.toLowerCase());
  if (at === -1) return span;
  const found = span.slice(at, at + wrong.length);
  const capitalised = /^\p{Lu}/u.test(found);
  const replacement = capitalised
    ? right.charAt(0).toUpperCase() + right.slice(1)
    : right;
  return span.slice(0, at) + replacement + span.slice(at + wrong.length);
}

/**
 * Corrections for the confusable phrasings this text contains.
 *
 * One correction per match, over the matched span only — never the whole
 * paragraph. The span is what makes the correction locatable and what keeps
 * two hits in one sentence from overlapping.
 */
export function findConfusablePatterns(
  text: string,
  lang?: string,
): Correction[] {
  const patterns = tableFor(lang);
  if (patterns.length === 0 || !text.trim()) return [];

  const out: Correction[] = [];
  for (const p of patterns) {
    const re = new RegExp(p.source, "giu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const original = m[0];
      const corrected = substitute(original, p.wrong, p.right);
      if (corrected === original) continue;
      out.push({
        original,
        corrected,
        reason: `confusable:${p.id}`,
        note: p.note,
      } as Correction);
      // A zero-length match would loop for ever. None of the patterns can
      // produce one, but the guard costs nothing.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run both test files**

Run: `cd backend && npx tsx --test test/confusablePatterns.test.ts test/confusableCorpus.test.ts`
Expected: PASS. The corpus test's two rows pass on the six patterns present.

If `the same span is never reported twice` fails on `its-a`, the two `its a`
spans differ in surrounding text — that is fine, the assertion allows equal
counts; read the output before changing the pattern.

- [ ] **Step 5: Commit**

```bash
git add backend/src/confusablePatterns.ts backend/test/confusablePatterns.test.ts
git commit -m "feat(proofread): catch real-word errors by shape

A dictionary cannot help with form/from or mand/man — both are words.
LanguageTool catches about half the English cases and none of the four
canonical Danish ones, and its coverage is patchy per sentence rather than
per pair. confusables.ts feeds the LLM a hint, which makes the catch a
model's decision and so different between two runs over one text.

Narrow patterns instead, each a data row with a word substitution, each
scored twice before it is added."
```

---

### Task 3: The rest of the English patterns

**Files:**
- Modify: `backend/src/confusablePatterns.ts` (extend `CONFUSABLE_PATTERNS`)
- Modify: `backend/test/confusableCorpus.test.ts` (add the corpus assertion)

**Interfaces:**
- Consumes: `ConfusablePattern`, `CONFUSABLE_PATTERNS`, `findConfusablePatterns` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Add the corpus assertion to the harness**

Append to `backend/test/confusableCorpus.test.ts`:

```ts
// The measured ceiling. English is contemporary prose, so this is the strong
// evidence: across 203,000 words the whole English table fired ONCE during
// design, on "couldn't form the words", which the modal exclusion now covers.
test("the English table is silent on 203,000 words of clean prose", { skip: en.length < 2 }, () => {
  const perPattern = new Map<string, number>();
  for (const p of CONFUSABLE_PATTERNS.filter((x) => x.lang === "en")) {
    perPattern.set(p.id, hitsFor(p.id, en));
  }
  const total = [...perPattern.values()].reduce((a, b) => a + b, 0);
  const detail = [...perPattern]
    .filter(([, n]) => n > 0)
    .map(([id, n]) => `${id}:${n}`)
    .join(" ");
  assert.equal(total, 0, `English patterns fired on clean prose — ${detail}`);
});
```

- [ ] **Step 2: Run it to see the current state**

Run: `cd backend && ./../scripts/fetch-confusable-corpus.sh && npx tsx --test test/confusableCorpus.test.ts`
Expected: PASS (or skipped if the manuscripts are absent). Note the number — it must stay 0 after step 3.

- [ ] **Step 3: Add the remaining six English patterns**

In `backend/src/confusablePatterns.ts`, insert these before the first `da-` entry:

```ts
  {
    id: "intensifier-quite",
    lang: "en",
    // LanguageTool catches "too quite" and misses "very quite"; this covers
    // both, which is the point of not relying on its per-sentence coverage.
    source: "\\b(?:very|so|too|really|dead|awfully)\\s+quite\\b",
    wrong: "quite",
    right: "quiet",
    note: "An intensifier before \"quite\" almost always wants \"quiet\".",
    planted: "The hall was very quite that evening.",
  },
  {
    id: "there-own",
    lang: "en",
    source: "\\bthere\\s+own\\b",
    wrong: "there",
    right: "their",
    note: "\"their own\" is the possessive.",
    planted: "They left there own boots behind.",
  },
  {
    id: "their-be",
    lang: "en",
    source: "\\btheir\\s+(?:is|are|was|were)\\b",
    wrong: "their",
    right: "there",
    note: "\"there is/are\" is the existential.",
    planted: "Their is a ship on the horizon.",
  },
  {
    id: "loose-verb",
    lang: "en",
    source: "\\b(?:to|will|would|might|can|could|may|must)\\s+loose\\b",
    wrong: "loose",
    right: "lose",
    note: "\"loose\" is the adjective; the verb is \"lose\".",
    planted: "We might loose the ship in this wind.",
  },
  {
    id: "then-comparative",
    lang: "en",
    source:
      "\\b(?:more|less|better|worse|bigger|smaller|taller|shorter|older|younger|faster|slower|higher|lower|greater|fewer)\\s+then\\b",
    wrong: "then",
    right: "than",
    note: "A comparative takes \"than\", not \"then\".",
    planted: "He was taller then his brother.",
  },
  {
    id: "have-went",
    lang: "en",
    source: "\\b(?:have|has|had)\\s+went\\b",
    wrong: "went",
    right: "gone",
    note: "The participle of \"go\" is \"gone\".",
    planted: "They have went to the harbour already.",
  },
```

- [ ] **Step 4: Run both tests**

Run: `cd backend && npx tsx --test test/confusablePatterns.test.ts test/confusableCorpus.test.ts`
Expected: PASS, with the English corpus total still **0**.

If a new pattern fires on the corpus, **read the passage before touching the
pattern**. During design that is exactly how `form-det`'s modal exclusion was
found. Either narrow the pattern and say why in a comment, or drop it — do
not raise the assertion's threshold.

- [ ] **Step 5: Commit**

```bash
git add backend/src/confusablePatterns.ts backend/test/confusableCorpus.test.ts
git commit -m "feat(proofread): ten English confusable patterns

Each catches its planted sentence and the table fires zero times across
203,000 words of contemporary prose. Three overlap LanguageTool and are kept
anyway: they cost nothing, and they hold when LanguageTool is absent, which
it is whenever Java or the jar is missing."
```

---

### Task 4: The Danish patterns

**Files:**
- Modify: `backend/src/confusablePatterns.ts`
- Modify: `backend/test/confusableCorpus.test.ts`
- Modify: `backend/src/confusables.ts:111-130` (add `mand`/`man` to the `da` sets)

**Interfaces:**
- Consumes: `ConfusablePattern`, `DA_INFINITIVE` from Task 2.
- Produces: nothing new.

Danish is where this earns most: LanguageTool catches **none** of the four
canonical Danish confusions, so these patterns are the only deterministic
Danish coverage there is.

- [ ] **Step 1: Add the Danish corpus assertion**

Append to `backend/test/confusableCorpus.test.ts`:

```ts
// Danish. Weaker evidence than the English row above — the only
// public-domain Danish is 19th/early-20th century — but it is what killed
// three candidate patterns during design, so it is worth running.
//
// One pattern is expected to fire: da-i-saer hits 4 times, all archaic
// ("i sær indre Bevægelse", and a line of 17th-century spelling). In modern
// Danish "i sær" is an error, so it is kept and the hits are allowed for by
// name rather than by raising a global threshold.
const DA_ALLOWED: Record<string, number> = { "da-i-saer": 4 };

test("the Danish table is silent on 333,455 words, bar the archaic i sær", { skip: da.length < 6 }, () => {
  const offenders: string[] = [];
  for (const p of CONFUSABLE_PATTERNS.filter((x) => x.lang === "da")) {
    const n = hitsFor(p.id, da);
    const allowed = DA_ALLOWED[p.id] ?? 0;
    if (n > allowed) offenders.push(`${p.id}: ${n} hits (allowed ${allowed})`);
  }
  assert.deepEqual(offenders, [], offenders.join("; "));
});
```

- [ ] **Step 2: Run it**

Run: `cd backend && npx tsx --test test/confusableCorpus.test.ts`
Expected: PASS — only `da-en-man` and `da-til-bage` exist so far, both silent.

- [ ] **Step 3: Add the remaining fifteen Danish patterns**

Append to `CONFUSABLE_PATTERNS` in `backend/src/confusablePatterns.ts`:

```ts
  // ── og / at — the error Danish style guides lead with ──
  {
    id: "da-lide-og",
    lang: "da",
    source: `\\b(?:lide|lyst til)\\s+og\\s+${DA_INFINITIVE}\\b`,
    wrong: "og",
    right: "at",
    note: "Infinitiv styres af \"at\", ikke \"og\".",
    planted: "Jeg kan godt lide og læse bøger om aftenen.",
  },
  {
    id: "da-for-og",
    lang: "da",
    source: `\\bfor\\s+og\\s+${DA_INFINITIVE}\\b`,
    wrong: "og",
    right: "at",
    note: "Hensigt udtrykkes med \"for at\".",
    planted: "Han gik ud for og hente vand ved brønden.",
  },
  {
    id: "da-verb-og",
    lang: "da",
    // Inflected forms only: a bare stem like "forsøg" is also a noun, and
    // "et sidste Forsøg og skrive" matched when stems were listed.
    source: `\\b(?:begynder|begyndte|prøver|prøvede|forsøger|forsøgte|nægter|nægtede|lover|lovede|beslutter|besluttede|glemmer|glemte|husker|huskede|ønsker|ønskede|lærer|lærte)\\s+og\\s+${DA_INFINITIVE}\\b`,
    wrong: "og",
    right: "at",
    note: "Disse verber styrer infinitiv med \"at\".",
    planted: "Han begyndte og græde ved bordet.",
  },
  // ── end / en ──
  {
    id: "da-komparativ-en",
    lang: "da",
    // Narrowed to a following PRONOUN: "snarere en Grød" and "større en Dag"
    // are a comparative plus an article and perfectly correct.
    source:
      "\\b(?:mere|mindre|bedre|værre|større|hurtigere|langsommere|ældre|yngre|højere|lavere|flere|færre|anderledes)\\s+en\\s+(?:jeg|du|han|hun|vi|de|mig|dig|ham|hende|os|jer|dem|sin|sit|sine|min|din|hans|hendes|vores|deres)\\b",
    wrong: "en",
    right: "end",
    note: "Sammenligning bruger \"end\".",
    planted: "Han var større en ham.",
  },
  // ── hver / vær / værd ──
  {
    id: "da-vaer-gang",
    lang: "da",
    source:
      "\\b(?:vær|værd)\\s+(?:gang|dag|uge|måned|morgen|aften|nat|time|år)\\b",
    wrong: "vær",
    right: "hver",
    note: "\"hver gang\", ikke \"vær gang\".",
    planted: "Vær gang han kom, sang hun for ham.",
  },
  {
    id: "da-hver-saa-god",
    lang: "da",
    source: "\\bhver\\s+så\\s+(?:god|venlig|artig)\\b",
    wrong: "hver",
    right: "vær",
    note: "\"vær så god\" er imperativ af \"være\".",
    planted: "Hver så god, sagde hun og rakte ham brødet.",
  },
  // ── the three transitive/intransitive pairs ──
  {
    id: "da-ligge-maerke",
    lang: "da",
    source: "\\bligge\\s+mærke\\s+til\\b",
    wrong: "ligge",
    right: "lægge",
    note: "Det faste udtryk er \"lægge mærke til\".",
    planted: "Han kunne ikke ligge mærke til nogen forskel.",
  },
  {
    id: "da-ligge-objekt",
    lang: "da",
    source:
      "\\b(?:vil|ville|skal|skulle|kan|kunne|må|måtte|at)\\s+ligge\\s+(?:den|det|dem|sig|bogen|hånden|brevet|hovedet)\\b",
    wrong: "ligge",
    right: "lægge",
    note: "Med objekt er verbet \"lægge\"; \"ligge\" er intransitivt.",
    planted: "Han ville ligge bogen på bordet ved vinduet.",
  },
  {
    id: "da-sidde-objekt",
    lang: "da",
    source:
      "\\b(?:vil|ville|skal|skulle|kan|kunne|må|måtte|at)\\s+sidde\\s+(?:den|det|dem|sig|barnet|koppen|kanden)\\b",
    wrong: "sidde",
    right: "sætte",
    note: "Med objekt er verbet \"sætte\"; \"sidde\" er intransitivt.",
    planted: "Han ville sidde koppen på bordet ved vinduet.",
  },
  {
    id: "da-staa-objekt",
    lang: "da",
    source:
      "\\b(?:vil|ville|skal|skulle|kan|kunne|må|måtte|at)\\s+stå\\s+(?:den|det|dem|bogen|flasken|kurven)\\b",
    wrong: "stå",
    right: "stille",
    note: "Med objekt er verbet \"stille\"; \"stå\" er intransitivt.",
    planted: "Han ville stå flasken ind i skabet igen.",
  },
  // ── nogen / nogle ──
  {
    id: "da-nogen-gange",
    lang: "da",
    source: "\\bnogen\\s+gange\\b",
    wrong: "nogen",
    right: "nogle",
    note: "Flertal tager \"nogle\".",
    planted: "Han kom nogen gange om ugen.",
  },
  // ── mand / man ──
  {
    id: "da-mand-modal",
    lang: "da",
    source:
      "(?:^|(?<=[.!?]\\s)|(?<=\\n))[Mm]and\\s+(?:kan|skal|vil|må|bør|ved|siger)\\b",
    wrong: "mand",
    right: "man",
    note: "Uden artikel er det pronominet \"man\".",
    planted: "Mand kan ikke vide det på forhånd.",
  },
  // ── ad / af ──
  {
    id: "da-hen-ned-af",
    lang: "da",
    // Only these motion phrases. "ud af døren" is deliberately NOT here:
    // prescriptive Danish wants "ud ad", but "ud af" is ordinary usage and
    // the pattern fired four times on the corpus.
    source:
      "\\b(?:hen|ned)\\s+af\\s+(?:vejen|gaden|trappen|bakken|stien|gangen)\\b",
    wrong: "af",
    right: "ad",
    note: "Bevægelse langs noget tager \"ad\".",
    planted: "Han gik ned af trappen.",
  },
  // ── split compounds ──
  {
    id: "da-i-saer",
    lang: "da",
    source: "\\bi\\s+sær\\b",
    wrong: "i sær",
    right: "især",
    note: "\"især\" skrives i ét ord.",
    planted: "Det gjaldt i sær om vinteren.",
  },
  {
    id: "da-al-tid",
    lang: "da",
    source: "\\bal\\s+tid\\b",
    wrong: "al tid",
    right: "altid",
    note: "\"altid\" skrives i ét ord.",
    planted: "Han var al tid træt om morgenen.",
  },
```

- [ ] **Step 4: Add `mand`/`man` to the confusable sets**

In `backend/src/confusables.ts`, in the `da` array (around line 112), add as
the first entry with a comment:

```ts
    // The error Danish style guides lead with, and LanguageTool catches none
    // of it — measured 0/4 on the canonical Danish confusions.
    ["mand", "man"],
```

- [ ] **Step 5: Run every test**

Run: `cd backend && npx tsx --test test/confusablePatterns.test.ts test/confusableCorpus.test.ts test/confusables.test.ts`
Expected: PASS. The Danish corpus row allows only `da-i-saer: 4`.

If another Danish pattern fires, read the passage. Remember the corpus is
19th-century: a hit may be archaic usage that is genuinely an error today
(as `da-i-saer`'s are), in which case add it to `DA_ALLOWED` **with the
passage quoted in a comment**. If it is ordinary modern usage, narrow or drop
the pattern instead.

- [ ] **Step 6: Commit**

```bash
git add backend/src/confusablePatterns.ts backend/src/confusables.ts backend/test/confusableCorpus.test.ts
git commit -m "feat(proofread): seventeen Danish confusable patterns

LanguageTool catches none of the four canonical Danish confusions, so these
are the only deterministic Danish coverage there is. Each catches its planted
sentence; sixteen of seventeen are silent across 333,455 words of Danish, and
the seventeenth's four hits are archaic usage allowed for by name.

mand/man also joins CONFUSABLE_SETS_BY_LANG.da, which did not have the pair
Danish style guides lead with."
```

---

### Task 5: Wire it into the proofread pass

**Files:**
- Modify: `backend/src/queue.ts` (after the retext block, around `:2035-2056`)
- Modify: `backend/src/correctionSeverity.ts:48-63` (`isDeterministicCorrection`)
- Test: `backend/test/correctionSeverity.test.ts`

**Interfaces:**
- Consumes: `findConfusablePatterns(text, lang)` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/correctionSeverity.test.ts`:

```ts
// A confusable pattern is a deterministic checker, not a model's opinion, so
// the precision pass must not delete its findings. The guard already covers
// spell-check, dialect, grammar and retext; deleting deterministic findings
// on a model's say-so cost German misspelling recall 68% -> 30%.

test("a confusable-pattern correction counts as deterministic", () => {
  assert.equal(
    isDeterministicCorrection({
      original: "form the",
      corrected: "from the",
      reason: "confusable:form-det",
    } as never),
    true,
  );
});

test("quote-style normalisation counts as deterministic too", () => {
  // It is safe today only because it is independently preApproved; the guard
  // should say so in its own right.
  assert.equal(
    isDeterministicCorrection({
      original: '"a"',
      corrected: "“a”",
      reason: "quote-style",
    } as never),
    true,
  );
});

test("an unlabelled correction is still not deterministic", () => {
  assert.equal(
    isDeterministicCorrection({ original: "a", corrected: "b" } as never),
    false,
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/correctionSeverity.test.ts`
Expected: FAIL on the first two — `false !== true`.

- [ ] **Step 3: Extend the guard**

In `backend/src/correctionSeverity.ts`, add to the `return` in
`isDeterministicCorrection`:

```ts
    reason === "dialect" ||
    // Normalising a quotation mark to the manuscript's declared style is the
    // manuscript's own convention talking, not a model's. Safe today only
    // because these are independently preApproved; stated here in its own
    // right so that stays true if that changes.
    reason === "quote-style" ||
    reason.startsWith("grammar:") ||
    reason.startsWith("retext:") ||
    // A narrow phrasing pattern, scored on a corpus before it was added.
    reason.startsWith("confusable:")
```

- [ ] **Step 4: Run the test**

Run: `cd backend && npx tsx --test test/correctionSeverity.test.ts`
Expected: PASS.

- [ ] **Step 5: Call it from the chunk pipeline**

In `backend/src/queue.ts`, immediately after the retext block that ends
around line 2056 (`}` closing `if (job.retextCheck) {`), add:

```ts
              // ── Confusable phrasings: real-word errors a dictionary
              // cannot see. Deterministic and unconditional — there is no
              // knob, because there is nothing to tune: every pattern was
              // scored on a corpus before it was added, and the table is
              // empty for languages that have none.
              {
                const { findConfusablePatterns } = await import(
                  "./confusablePatterns.js"
                );
                const confusableCs = findConfusablePatterns(
                  chunk.body,
                  job.manuscriptLang,
                );
                if (confusableCs.length > 0) {
                  spellCorrections = [...spellCorrections, ...confusableCs];
                  appendLog({
                    level: "info",
                    source: "engine",
                    taskId,
                    message: `confusable patterns produced ${confusableCs.length} corrections in chunk ${chunkLabel}`,
                    model,
                  });
                }
              }
```

- [ ] **Step 6: Run the whole suite and both builds**

Run: `cd backend && npm test && npm run build`
Expected: PASS, exit 0.

Run: `cd frontend && npm run build`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/queue.ts backend/src/correctionSeverity.ts backend/test/correctionSeverity.test.ts
git commit -m "feat(proofread): run the confusable patterns on every chunk

Unconditional and deterministic: there is no knob because there is nothing to
tune — each pattern was scored on a corpus before it was added, and the table
is empty for a language that has none.

isDeterministicCorrection learns confusable: and quote-style, so the
precision pass cannot delete either on a model's say-so. Deleting
deterministic findings that way cost German misspelling recall 68% -> 30%."
```

---

### Task 6: Measure it on the real manuscripts

**Files:**
- Modify: `backend/src/confusablePatterns.ts` (record the result in the header)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Run the table over both English manuscripts and read every hit**

```bash
cd backend && npx tsx -e '
const { findConfusablePatterns } = require("./src/confusablePatterns.ts");
const { readFileSync } = require("fs");
for (const f of ["rage", "taker"]) {
  const md = readFileSync(`/tmp/quote-corpus/${f}.md`, "utf8");
  const cs = findConfusablePatterns(md, "en");
  console.log(`${f}: ${cs.length} findings`);
  for (const c of cs) console.log(`  [${c.reason}] ${JSON.stringify(c.original)} -> ${JSON.stringify(c.corrected)}`);
}'
```

Expected: **0 findings on both.** These are finished books; anything here is
a false positive and must be fixed in the pattern, not accepted.

- [ ] **Step 2: Confirm the planted battery still passes end to end**

```bash
cd backend && npx tsx -e '
const { findConfusablePatterns, CONFUSABLE_PATTERNS } = require("./src/confusablePatterns.ts");
let ok = 0;
for (const p of CONFUSABLE_PATTERNS) {
  const hit = findConfusablePatterns(p.planted, p.lang).some((c) => c.reason === `confusable:${p.id}`);
  if (hit) ok++; else console.log(`MISSED ${p.id}: ${p.planted}`);
}
console.log(`${ok}/${CONFUSABLE_PATTERNS.length} planted sentences caught`);'
```

Expected: `27/27 planted sentences caught` (10 English + 17 Danish).

- [ ] **Step 3: Record the measurement in the module header**

Add to the header of `backend/src/confusablePatterns.ts`, with the real
numbers from steps 1 and 2 rather than these:

```ts
// MEASURED (2026-09-23, at the time of writing):
//   planted sentences caught          27/27
//   hits on 203,000 words of English   0
//   hits on 333,455 words of Danish    4, all da-i-saer, all archaic
```

- [ ] **Step 4: Run everything once more**

Run: `cd backend && npm test && npm run build`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add backend/src/confusablePatterns.ts
git commit -m "docs(proofread): record what the confusable table measures

27 planted sentences caught, zero hits on 203,000 words of contemporary
English, four on 333,455 words of Danish and all of them archaic. The numbers
belong in the header so the next person to add a pattern knows what the bar
is."
```

---

### Task 7: The rare member of a live confusable set

**Files:**
- Create: `backend/src/confusableBalance.ts`
- Test: `backend/test/confusableBalance.test.ts`

**Interfaces:**
- Consumes: `CONFUSABLE_SETS`, `CONFUSABLE_SETS_BY_LANG` from `./confusables.js`.
- Produces:
  - `interface RareMember { set: string[]; word: string; count: number; leader: string; leaderCount: number }`
  - `function findRareConfusableMembers(text: string, lang?: string): RareMember[]`

What the patterns cannot reach. Where a book uses one member of a set
overwhelmingly and another barely at all, the rare one is worth a look. This
is a **listing to inspect**, not corrections to accept — nothing is proposed,
because nothing can be: both words are real.

Measured at a 1:20 ratio it is a handful per book. At 1:10 it is 177 and 250,
which is why the ratio is not a knob.

- [ ] **Step 1: Write the failing test**

Create `backend/test/confusableBalance.test.ts`:

```ts
// Frequency, where patterns cannot help.
//
// Confusable words are 1 in every 20 words of a real novel — 4,251
// occurrences in one of the test manuscripts, 5,776 in the other, with
// to/too alone at 2,413 and 3,478. Reporting every occurrence would be some
// five thousand findings a book. But where the book uses one member 20x more
// than another, the rare one is worth a look: measured, that is 5 and 3
// occurrences per book.

import { test } from "node:test";
import assert from "node:assert/strict";

import { findRareConfusableMembers } from "../src/confusableBalance.ts";

const filler = (n: number) =>
  Array.from({ length: n }, (_, i) => `He turned right at the ${i} corner.`).join(" ");

test("a member used far less than its partner is reported", () => {
  // "right" x40 against one "write".
  const text = `${filler(40)} She had to write the letter.`;
  const found = findRareConfusableMembers(text, "en");
  const hit = found.find((r) => r.word === "write");
  assert.ok(hit, JSON.stringify(found));
  assert.equal(hit.leader, "right");
  assert.equal(hit.count, 1);
});

test("a balanced pair is not reported", () => {
  // their/there roughly even — nothing frequency-based can say anything.
  const text = `${"Their boots were there by the door. ".repeat(20)}`;
  const found = findRareConfusableMembers(text, "en");
  assert.equal(
    found.some((r) => r.word === "their" || r.word === "there"),
    false,
  );
});

test("a set the book uses only one member of is not reported", () => {
  // Nothing to confuse it with.
  const text = filler(40);
  const found = findRareConfusableMembers(text, "en");
  assert.equal(found.some((r) => r.word === "right"), false);
});

test("nothing is proposed — both words are real", () => {
  const text = `${filler(40)} She had to write the letter.`;
  for (const r of findRareConfusableMembers(text, "en")) {
    assert.equal(typeof r.word, "string");
    assert.ok(!("corrected" in r), "this is a listing, not a correction");
  }
});

test("Danish sets are used for a Danish text", () => {
  const da = `${"Han lagde bogen på bordet. ".repeat(40)} Den skulle ligge der.`;
  const found = findRareConfusableMembers(da, "da");
  assert.ok(Array.isArray(found));
});

test("a language with no table returns nothing", () => {
  assert.deepEqual(findRareConfusableMembers("Il lut la lettre.", "fr"), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && npx tsx --test test/confusableBalance.test.ts`
Expected: FAIL — `Cannot find module '../src/confusableBalance.ts'`

- [ ] **Step 3: Write the module**

Create `backend/src/confusableBalance.ts`:

```ts
// ── The rare member of a live confusable set ──
//
// Confusable words are 1 in every 20 words of a real novel: 4,251 occurrences
// in one test manuscript and 5,776 in the other, to/too alone accounting for
// 2,413 and 3,478. So reporting every occurrence is not an option — it would
// be some five thousand findings a book.
//
// What IS possible: where a book uses one member of a set overwhelmingly and
// another barely at all, the rare one is worth a look. Measured at 1:20 that
// is 5 occurrences in one book and 3 in the other —
//
//   write:3 vs right:72     breathe:2 vs breath:54     reign:1 vs rain:23
//
// At 1:10 it is 177 and 250, which is why the ratio is not a knob.
//
// This deliberately does NOT serve their/there (313 vs 191) or to/too.
// Nothing frequency-based can; those need confusablePatterns.ts.
//
// Nothing is proposed. Both words are real words, and which one belongs is a
// question only the author can answer — so this is a listing to inspect.

import { CONFUSABLE_SETS, CONFUSABLE_SETS_BY_LANG } from "./confusables.js";

/** How much more common the other member must be before the rare one is
 *  worth asking about. 1:10 produced 177 and 250 findings; 1:20 produced 5
 *  and 3. */
const RARE_RATIO = 20;

export interface RareMember {
  set: string[];
  /** The member the book barely uses. */
  word: string;
  count: number;
  /** The member it uses instead. */
  leader: string;
  leaderCount: number;
}

function setsFor(lang?: string): readonly (readonly string[])[] {
  const key = (lang ?? "en").toLowerCase().split(/[-_]/)[0];
  if (key === "en") return CONFUSABLE_SETS;
  return (CONFUSABLE_SETS_BY_LANG as Record<string, readonly (readonly string[])[]>)[key] ?? [];
}

export function findRareConfusableMembers(
  text: string,
  lang?: string,
): RareMember[] {
  const sets = setsFor(lang);
  if (sets.length === 0) return [];

  const freq = new Map<string, number>();
  for (const w of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
    freq.set(w, (freq.get(w) ?? 0) + 1);
  }

  const out: RareMember[] = [];
  for (const set of sets) {
    const counts = set.map((w) => freq.get(w.toLowerCase()) ?? 0);
    const max = Math.max(...counts);
    if (max === 0) continue;
    // A set the book uses only one member of has nothing to confuse.
    if (counts.filter((c) => c > 0).length < 2) continue;
    const leader = set[counts.indexOf(max)];
    for (let i = 0; i < set.length; i++) {
      const n = counts[i];
      if (n === 0 || set[i] === leader) continue;
      if (n * RARE_RATIO > max) continue;
      out.push({
        set: [...set],
        word: set[i],
        count: n,
        leader,
        leaderCount: max,
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the test**

Run: `cd backend && npx tsx --test test/confusableBalance.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Check it against the real manuscripts**

```bash
cd backend && npx tsx -e '
const { findRareConfusableMembers } = require("./src/confusableBalance.ts");
const { readFileSync } = require("fs");
for (const f of ["rage", "taker"]) {
  const md = readFileSync(`/tmp/quote-corpus/${f}.md`, "utf8");
  const rs = findRareConfusableMembers(md, "en");
  console.log(`${f}: ${rs.reduce((a, r) => a + r.count, 0)} occurrences to inspect`);
  for (const r of rs) console.log(`  ${r.word}:${r.count} vs ${r.leader}:${r.leaderCount}`);
}'
```

Expected: a handful each — during design, `write:3 vs right:72` and
`breathe:2 vs breath:54` for one book, `write:2 vs right:97` and
`reign:1 vs rain:23` for the other. If the total is in the hundreds, the
ratio is not being applied; do not lower it to compensate.

- [ ] **Step 6: Commit**

```bash
git add backend/src/confusableBalance.ts backend/test/confusableBalance.test.ts
git commit -m "feat(proofread): list the rare member of a live confusable set

Confusable words are 1 in every 20 words of a real novel, so reporting every
occurrence would be five thousand findings a book. But where a book uses one
member 20x more than another, the rare one is worth a look — measured, 5
occurrences in one manuscript and 3 in the other. At 1:10 it is 177 and 250,
which is why the ratio is not a knob.

A listing, not corrections: both words are real, and which belongs is a
question only the author can answer. It deliberately does not serve
their/there or to/too — nothing frequency-based can."
```

---

## Notes for the implementer

- **Do not raise a threshold to make a test pass.** If a pattern fires on the
  corpus, read the passage. Three candidates were dropped or narrowed that
  way during design and the reasoning is in the module header — the corpus is
  the only thing standing between this feature and a table of plausible
  nonsense.
- **`confusables.ts` is a different thing.** It answers "which sets does this
  text use" for the LLM prompt hint. This module answers "this phrasing is
  wrong". Both stay.
- **Danish is the weakest evidence in the plan** and the most valuable
  feature, because LanguageTool gives Danish authors nothing here. If a
  modern Danish manuscript becomes available, re-score before adding more.
- **The `form-det` lookbehind** is the one piece of regex subtlety. JS
  supports lookbehind on Node 18+; the repo is on Node 24. Do not rewrite it
  as a capture group without re-running the corpus test — the exclusion is
  load-bearing and was found by measurement.
