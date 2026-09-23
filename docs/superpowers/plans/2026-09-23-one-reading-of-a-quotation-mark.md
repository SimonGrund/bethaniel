# One Reading of a Quotation Mark — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the publication scan see every quotation-mark defect in one run — including the straight-among-curly marks it is currently blind to — and let the copy edit normalise a manuscript to the quote style its author declared.

**Architecture:** One new module, `backend/src/quoteMarks.ts`, becomes the single reading of what a quotation mark is; `publicationScan.ts` and `quoteRepair.ts` both consume it instead of each carrying their own half-answer. Quote style becomes a declared setting detected at upload (`detectSettings.ts`) and threaded through `editOptions`, exactly as English dialect already is. The scan then runs two checks — a style-agnostic balance check with committed-reading tolerances, and a new `quote_style` check — and the copy edit emits the normalisation as one grouped decision.

**Tech Stack:** TypeScript, Node.js, `node:test` via the `tsx` loader (backend), React + Zustand (frontend). No new dependencies.

## Global Constraints

- **Tests:** `cd backend && npm test` runs everything. A single file: `cd backend && npx tsx --test test/<name>.test.ts`. No new test dependencies — `node:test` + `node:assert/strict` only.
- **Scope of marks:** double quotes only. Single quotes and apostrophes are never read, counted, reported or rewritten. `’` appears 2,002 times in one test manuscript as an apostrophe.
- **Never invent a missing closing mark.** The scan reports; only style normalisation rewrites. Where a missing mark belongs is a judgement `quoteRepair` already refuses to make.
- **Determinism:** every function added here is pure — no LLM, no randomness, no clock. `buildPublicationScan` must stay byte-identical across repeated runs on the same input.
- **Declared before majority:** wherever a quote style is needed, the author's declared setting wins; the manuscript's own majority is the fallback when no setting exists. Same precedence the English dialect check uses.
- **Fallback thresholds** (from today's `quoteRepair.dominantStyle`): 75% majority, minimum 4 marks, otherwise no style.
- **Corpus:** the measured manuscripts are `Rage of the Rule` and `Path of the Taker`, in the installed app's DB at `~/Library/Application Support/Bethaniel/data/bethaniel.db`. Task 8 measures against them. Tasks 1–7 use fixtures checked into the test files.

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/quoteMarks.ts` | **New.** The single reading: resolve a manuscript's convention, and read one paragraph's marks into roles. Pure, no I/O. |
| `backend/src/detectSettings.ts` | Gains `detectQuoteStyle`; `DetectedSettings` gains `quoteStyle`. |
| `backend/src/types.ts` | `CopyEditOptions.quoteStyle`; `STRUCTURAL_CHECKS` gains `"quote_style"`. |
| `backend/src/publicationScan.ts` | Balance check becomes style-agnostic with committed readings; new style check. Loses its private `QUOTE_FAMILIES` / `quoteBalance` / `detectQuoteFamily` to `quoteMarks.ts`. |
| `backend/src/quoteRepair.ts` | Loses its private `marksOpen` / `dominantStyle` to `quoteMarks.ts`; gains straight→curly normalisation. |
| `backend/src/correctionHygiene.ts` | Carve-out so `dropNoOpCorrections` stops eating quote-style corrections. |
| `frontend/src/store.ts` | `applyDetectedSettings` moves the `quoteStyle` control. |
| `frontend/src/components/ManuscriptSettings.tsx` | The control, on the `edit` and `readthrough` cards. |
| `frontend/src/i18n.ts` | `scan_check_quote_style`, `opt_quoteStyle`, `opt_quoteCurly`, `opt_quoteStraight`. |

Tasks 1–3 are backend-only and independent of the UI. Task 4 depends on 1. Tasks 5–6 depend on 1–2. Task 7 is the frontend. Task 8 is calibration and must run last.

---

### Task 1: `quoteMarks.ts` — the single reading

**Files:**
- Create: `backend/src/quoteMarks.ts`
- Test: `backend/test/quoteMarks.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type QuoteStyle = "curly" | "straight"`
  - `interface QuoteFamily { open: string; close: string }`
  - `interface QuoteConvention { family: QuoteFamily; style: QuoteStyle | null }`
  - `const QUOTE_FAMILIES: readonly QuoteFamily[]`
  - `function detectQuoteFamily(text: string): QuoteFamily`
  - `function detectDominantStyle(text: string): QuoteStyle | null`
  - `function resolveConvention(text: string, declared?: QuoteStyle | null): QuoteConvention`
  - `interface QuoteMark { index: number; char: string; role: "open" | "close" }`
  - `function readMarks(paragraph: string, convention: QuoteConvention): QuoteMark[]`

- [ ] **Step 1: Write the failing test**

Create `backend/test/quoteMarks.test.ts`:

```ts
// One reading of a quotation mark, shared by the publication scan and the
// quote repair. The two used to disagree — quoteRepair counted straight
// marks, publicationScan did not — and every defect the scan missed on a
// real book lived in exactly that gap.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectQuoteFamily,
  detectDominantStyle,
  resolveConvention,
  readMarks,
} from "../src/quoteMarks.ts";

test("English curly is the default family", () => {
  const f = detectQuoteFamily("“Hello,” she said. “Goodbye.”");
  assert.equal(f.open, "“");
  assert.equal(f.close, "”");
});

test("German „ “ wins over English, whose opener is its closer", () => {
  const f = detectQuoteFamily("„Guten Tag,“ sagte sie. „Auf Wiedersehen.“");
  assert.equal(f.open, "„");
  assert.equal(f.close, "“");
});

test("French guillemets are read as their own family", () => {
  const f = detectQuoteFamily("« Bonjour », dit-elle. « Au revoir. »");
  assert.equal(f.open, "«");
  assert.equal(f.close, "»");
});

test("a book of curly marks with a few strays is curly", () => {
  const text = `${"“Yes,” she said. ".repeat(10)}"No," he said.`;
  assert.equal(detectDominantStyle(text), "curly");
});

test("a book of straight marks is straight, and is not an error", () => {
  const text = '"Yes," she said. "No," he said. "Maybe," they said.';
  assert.equal(detectDominantStyle(text), "straight");
});

test("too few marks is no style at all", () => {
  assert.equal(detectDominantStyle('He said "yes".'), null);
});

test("genuinely mixed is no style at all", () => {
  const text = `${'"Yes," she said. '.repeat(5)}${"“No,” he said. ".repeat(5)}`;
  assert.equal(detectDominantStyle(text), null);
});

test("a declared style beats the manuscript's own majority", () => {
  const mostlyCurly = "“Yes,” she said. ".repeat(10);
  assert.equal(resolveConvention(mostlyCurly, "straight").style, "straight");
  assert.equal(resolveConvention(mostlyCurly).style, "curly");
});

test("a declared style still leaves the family read off the text", () => {
  const french = "« Bonjour », dit-elle. « Au revoir. » « Oui. »";
  assert.equal(resolveConvention(french, "curly").family.open, "«");
});

test("straight marks take their role from alternation", () => {
  const conv = resolveConvention("“a” “b” “c” “d”");
  const marks = readMarks('“But—"', conv);
  assert.deepEqual(
    marks.map((m) => m.role),
    ["open", "close"],
  );
  assert.deepEqual(
    marks.map((m) => m.char),
    ["“", '"'],
  );
});

test("family marks take their role from their character, not alternation", () => {
  const conv = resolveConvention("“a” “b” “c” “d”");
  // Two closers in a row: a real defect, and alternation would call the
  // second one an opener. The character is the truth.
  const marks = readMarks("”Good.”", conv);
  assert.deepEqual(
    marks.map((m) => m.role),
    ["close", "close"],
  );
});

test("indexes point at the marks themselves", () => {
  const conv = resolveConvention("“a” “b” “c” “d”");
  const marks = readMarks("“Hi.”", conv);
  assert.deepEqual(
    marks.map((m) => m.index),
    [0, 4],
  );
});

test("apostrophes and single quotes are not marks", () => {
  const conv = resolveConvention("“a” “b” “c” “d”");
  assert.equal(readMarks("It’s Bria’s ‘thing’, he said.", conv).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/quoteMarks.test.ts`
Expected: FAIL — `Cannot find module '../src/quoteMarks.ts'`

- [ ] **Step 3: Write the implementation**

Create `backend/src/quoteMarks.ts`:

```ts
// ── One reading of a quotation mark ──
//
// Two files used to answer this question separately and differently.
// `quoteRepair.marksOpen` counted a straight " as a quotation mark;
// `publicationScan.quoteBalance` did not. Measured on two real manuscripts,
// the publication scan reported 5 of 15 unbalanced paragraphs in one book and
// 0 of 8 in the other — and every single miss was a curly opener closed by a
// straight mark, which is to say every miss lived in the gap between the two
// readings. So there is one reading now, and both files consume it.
//
// Double quotes only. A manuscript carries thousands of ’ as apostrophes
// (2,002 in one of the test books), and telling those from a nested closing
// quote is a different and much riskier job.

/** Curly or straight. Which one a book uses is the author's choice. */
export type QuoteStyle = "curly" | "straight";

export interface QuoteFamily {
  open: string;
  close: string;
}

export interface QuoteConvention {
  family: QuoteFamily;
  /** Null when the manuscript has no convention to conform to. */
  style: QuoteStyle | null;
}

/**
 * The pair of marks a manuscript opens and closes speech with.
 *
 * English curly quotes were once hard-coded, which on a French novel meant the
 * check found no quotation marks at all and passed every chapter in silence —
 * the dialogue was in guillemets. The convention is the manuscript's, not the
 * language's (a French author may well use “ ”, a German one » «), so it is
 * counted off the text rather than looked up from a language code.
 */
export const QUOTE_FAMILIES: readonly QuoteFamily[] = [
  { open: "“", close: "”" }, // “ ”  English, and French houses that follow it
  { open: "«", close: "»" }, // « »  French, and the continental default
  { open: "„", close: "“" }, // „ “  German
  { open: "»", close: "«" }, // » «  German reversed guillemets
] as const;

const STRAIGHT = '"';

/** Share of marks that must agree before a style counts as the manuscript's. */
const STYLE_MAJORITY = 0.75;

/** Below this many double-quote marks there is no style to infer. */
const MIN_MARKS_TO_JUDGE = 4;

function countOf(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/**
 * Which family this manuscript speaks in: whichever opener it uses most.
 *
 * „ “ is decided before “ ”, because a German manuscript contains both — its
 * closer IS the English opener — and counting openers alone would call it
 * English and then report every closed line as unbalanced.
 */
export function detectQuoteFamily(text: string): QuoteFamily {
  const german = countOf(text, "„");
  if (german > 0 && german >= countOf(text, "“") - german) {
    return QUOTE_FAMILIES[2];
  }
  let best: QuoteFamily = QUOTE_FAMILIES[0];
  let bestCount = -1;
  for (const f of QUOTE_FAMILIES) {
    // » « is only ever the right reading when « is not itself the opener.
    if (f.open === "»" && countOf(text, "«") >= countOf(text, "»")) {
      continue;
    }
    const n = countOf(text, f.open);
    if (n > bestCount) {
      best = f;
      bestCount = n;
    }
  }
  return best;
}

/**
 * The manuscript's prevailing double-quote style.
 *
 * Style is the author's choice; only inconsistency is an error. A book set in
 * straight quotes throughout is correct and must be left alone. Null means
 * there is nothing here to conform to — too few marks to call it, or a book
 * so evenly mixed that picking one would rewrite half its dialogue on a
 * guess. A declared setting is what resolves that case; see resolveConvention.
 */
export function detectDominantStyle(text: string): QuoteStyle | null {
  const curly = (text.match(/[“”„«»]/g) ?? []).length;
  const straight = countOf(text, STRAIGHT);
  const total = curly + straight;
  if (total < MIN_MARKS_TO_JUDGE) return null;
  if (curly / total >= STYLE_MAJORITY) return "curly";
  if (straight / total >= STYLE_MAJORITY) return "straight";
  return null;
}

/**
 * The convention to read a manuscript against.
 *
 * `declared` is the style the author chose in the settings panel, when there
 * is a job that has one. It wins over the manuscript's own majority for the
 * same reason the English dialect check was changed to consult the declared
 * dialect: deciding by majority inside the check told a manuscript set to
 * British to standardise on American, the exact opposite of what the copy
 * edit would do to the same text. A book that is 60% curly would likewise be
 * "normalised" to curly whether or not its author wants that.
 *
 * The FAMILY is never declared — it is read off the text either way. An
 * author declaring "curly" is choosing curly over straight, not choosing
 * English quotes over guillemets.
 */
export function resolveConvention(
  text: string,
  declared?: QuoteStyle | null,
): QuoteConvention {
  return {
    family: detectQuoteFamily(text),
    style: declared ?? detectDominantStyle(text),
  };
}

export interface QuoteMark {
  index: number;
  char: string;
  role: "open" | "close";
}

/**
 * Every double-quote mark in one paragraph, with the role it plays.
 *
 * A family mark takes its role from its character: “ opens and ” closes, and
 * a paragraph holding two closers in a row is a defect rather than an
 * instruction to alternate. A straight mark has no orientation to read, so it
 * takes the role alternation needs — which is what `quoteRepair.marksOpen`
 * has always done, and which is why `“But—"` is BALANCED and wrong only in
 * style. Alternation is decided by preceding marks, not by the character
 * before the mark: “But sir—” is speech cut off mid-sentence and correctly
 * ends with an em-dash and a CLOSING mark. A rule that read the dash as
 * opening context flipped 61 correct marks in one book.
 *
 * State resets at every paragraph, which is also what the continued-speech
 * convention needs: each paragraph of a long speech opens with a mark.
 */
export function readMarks(
  paragraph: string,
  convention: QuoteConvention,
): QuoteMark[] {
  const { family } = convention;
  const out: QuoteMark[] = [];
  let inside = false;
  let index = 0;
  for (const ch of paragraph) {
    if (ch === family.open) {
      out.push({ index, char: ch, role: "open" });
      inside = true;
    } else if (ch === family.close) {
      out.push({ index, char: ch, role: "close" });
      inside = false;
    } else if (ch === STRAIGHT) {
      out.push({ index, char: ch, role: inside ? "close" : "open" });
      inside = !inside;
    }
    index += ch.length;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx tsx --test test/quoteMarks.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/quoteMarks.ts backend/test/quoteMarks.test.ts
git commit -m "feat(scan): one reading of a quotation mark

quoteRepair counted a straight mark and publicationScan did not, and every
defect the scan missed on a real book lived in that gap. One module answers
the question now; both files consume it in the commits that follow."
```

---

### Task 2: `detectQuoteStyle` — quote style becomes a declared setting

**Files:**
- Modify: `backend/src/detectSettings.ts` (add `detectQuoteStyle`, extend `DetectedSettings` at `:583` and `detectSettings` at `:601`)
- Modify: `backend/src/types.ts:49-58` (add `CopyEditOptions.quoteStyle`)
- Test: `backend/test/detectQuoteStyle.test.ts`

**Interfaces:**
- Consumes: `detectDominantStyle`, `QuoteStyle` from Task 1.
- Produces:
  - `function detectQuoteStyle(md: string): Detection<QuoteStyle>`
  - `DetectedSettings.quoteStyle?: Detection<QuoteStyle>`
  - `CopyEditOptions.quoteStyle: QuoteStyle`

- [ ] **Step 1: Write the failing test**

Create `backend/test/detectQuoteStyle.test.ts`:

```ts
// Quote style is a convention the manuscript can answer for itself, like the
// dialect and the comma rules beside it. It is detected so the author can
// confirm it — never so the app can decide alone. A book that is 60% curly
// must not be "normalised" to curly behind its author's back.

import { test } from "node:test";
import assert from "node:assert/strict";

import { detectQuoteStyle, detectSettings } from "../src/detectSettings.ts";

const NARRATION =
  "He walked on through the rain, and the road went with him. ".repeat(40);

test("a curly manuscript is detected as curly", () => {
  const md = `${NARRATION}\n\n${"“Yes,” she said. ".repeat(20)}`;
  const d = detectQuoteStyle(md);
  assert.equal(d.status, "detected");
  assert.equal(d.status === "detected" && d.value, "curly");
});

test("a straight manuscript is detected as straight, not corrected", () => {
  const md = `${NARRATION}\n\n${'"Yes," she said. '.repeat(20)}`;
  const d = detectQuoteStyle(md);
  assert.equal(d.status, "detected");
  assert.equal(d.status === "detected" && d.value, "straight");
});

test("an evenly mixed manuscript is unsure, so the author is asked", () => {
  const md = `${NARRATION}\n\n${"“Yes,” she said. ".repeat(10)}${'"No," he said. '.repeat(10)}`;
  assert.equal(detectQuoteStyle(md).status, "unsure");
});

test("a manuscript with no dialogue at all is unsure", () => {
  assert.equal(detectQuoteStyle(NARRATION).status, "unsure");
});

test("the counts behind the answer are reported for the badge", () => {
  const md = `${NARRATION}\n\n${"“Yes,” she said. ".repeat(20)}${'"No," he said. '.repeat(2)}`;
  const d = detectQuoteStyle(md);
  assert.equal(d.support, 40);
  assert.equal(d.against, 4);
  assert.equal(d.sample, 44);
});

test("quote style joins the settings read at upload", () => {
  const md = `${NARRATION}\n\n${"“Yes,” she said. ".repeat(20)}`;
  const found = detectSettings(md);
  assert.equal(found.quoteStyle?.status, "detected");
});

test("quote style is read for a non-English manuscript too", () => {
  // Unlike the dialect and comma conventions, quote style is not gated on
  // English: a French novel in guillemets still has a curly-vs-straight
  // answer, and the scan needs it.
  const french =
    "Elle marchait sous la pluie et la route l’accompagnait. ".repeat(40) +
    "« Oui », dit-elle. ".repeat(20);
  const found = detectSettings(french);
  assert.equal(found.quoteStyle?.status, "detected");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/detectQuoteStyle.test.ts`
Expected: FAIL — `detectQuoteStyle is not a function`

- [ ] **Step 3: Add the detector**

In `backend/src/detectSettings.ts`, add the import at the top alongside the other imports:

```ts
import type { QuoteStyle } from "./quoteMarks.js";
```

Add this function immediately before `export interface DetectedSettings`:

```ts
/**
 * Curly or straight quotation marks.
 *
 * Counted rather than inferred from anything else: a word processor decides
 * this as often as an author does, and both answers are correct. What is NOT
 * correct is a book that is mostly one and occasionally the other, which is
 * what the publication scan reports and the copy edit offers to normalise —
 * but only ever to the style the author confirms here.
 *
 * Not gated on English, unlike the dialect and comma detectors: a French
 * novel in guillemets still has a curly-vs-straight answer, and the scan
 * needs it in every language.
 */
export function detectQuoteStyle(md: string): Detection<QuoteStyle> {
  const text = sampleText(md);
  const curly = (text.match(/[“”„«»]/g) ?? []).length;
  const straight = (text.match(/"/g) ?? []).length;
  const sample = curly + straight;
  // Matches quoteMarks.detectDominantStyle: four marks to judge by, three
  // quarters to agree. Kept in step deliberately — a setting detected here
  // and a majority computed there that disagreed would be worse than either.
  if (sample < 4) return unsure(0, 0, sample);
  if (curly / sample >= 0.75) return detected("curly", curly, straight, sample);
  if (straight / sample >= 0.75) {
    return detected("straight", straight, curly, sample);
  }
  return unsure(Math.max(curly, straight), Math.min(curly, straight), sample);
}
```

Extend `DetectedSettings` (currently `backend/src/detectSettings.ts:583`):

```ts
export interface DetectedSettings {
  manuscriptLang?: Detection<ManuscriptLangCode>;
  englishDialect?: Detection<"american" | "british">;
  oxfordComma?: Detection<boolean>;
  introductoryComma?: Detection<boolean>;
  danishComma?: Detection<"grammatisk" | "nyt">;
  quoteStyle?: Detection<QuoteStyle>;
}
```

In `detectSettings`, add the call **before** the early return that gates on
language, so it runs for every manuscript:

```ts
export function detectSettings(md: string): DetectedSettings {
  const manuscriptLang = detectManuscriptLanguage(md);
  const found: DetectedSettings = { manuscriptLang };
  // Read for every manuscript, not only English ones: a book in guillemets
  // still has a curly-vs-straight answer.
  found.quoteStyle = detectQuoteStyle(md);
  if (manuscriptLang.status !== "detected") return found;
  // ...rest unchanged
```

- [ ] **Step 4: Add the option**

In `backend/src/types.ts`, add to `CopyEditOptions` after `englishDialect` (`:54`):

```ts
  /**
   * The quotation-mark style the manuscript is held to — curly “ ” or
   * straight " ". Both are correct; only inconsistency is an error. Declared
   * here rather than decided by majority inside each check, for the same
   * reason englishDialect is: a 60/40 book would otherwise be normalised
   * against its author's wishes.
   */
  quoteStyle: QuoteStyle;
```

Add the import at the top of `backend/src/types.ts`:

```ts
import type { QuoteStyle } from "./quoteMarks.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && npx tsx --test test/detectQuoteStyle.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS. If a test constructs a `CopyEditOptions` literal and now fails
to typecheck, add `quoteStyle: "curly"` to that literal — do not widen the type.

- [ ] **Step 7: Commit**

```bash
git add backend/src/detectSettings.ts backend/src/types.ts backend/test/detectQuoteStyle.test.ts
git commit -m "feat(settings): read the manuscript's quote style at upload

Curly or straight is the author's choice, so it is detected and confirmed
like the dialect and comma conventions beside it — never decided by majority
inside a check, which is the bug that made the dialect check advise the
opposite of the author's own setting."
```

---

### Task 3: The balance check, style-agnostic with committed readings

**Files:**
- Modify: `backend/src/publicationScan.ts` — delete `QUOTE_FAMILIES` (`:241`), `detectQuoteFamily` (`:263`), `countOf` (`:250`), `quoteBalance` (`:280`), `QuoteBalance` (`:226`); rewrite `unbalancedParagraphs` (`:379`)
- Test: `backend/test/publicationScanQuotes.test.ts` (extend)

**Interfaces:**
- Consumes: `readMarks`, `resolveConvention`, `QuoteConvention` from Task 1.
- Produces: `unbalancedParagraphs(body: string, convention: QuoteConvention): string[]` — unchanged shape, new behaviour.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/publicationScanQuotes.test.ts`:

```ts
// ── Committed readings ──
//
// The tolerances that let a quotation run across paragraphs used to be
// re-decided at EVERY paragraph, so a run could switch readings mid-way and
// be forgiven by whichever one happened to fit. On a real book that absorbed
// almost everything: an unclosed line followed by a narration paragraph was
// read as a block quotation's middle, then cleared by the next line of
// dialogue read as continued speech, and nothing was ever reported.

const FILLER = Array.from(
  { length: 14 },
  (_, i) => `Filler paragraph ${i}, ordinary narration carrying the chapter.`,
).join("\n\n");

function quoteFindings(paragraphs: string[]) {
  const body = [FILLER, ...paragraphs, FILLER].join("\n\n");
  return scan(body).findings.filter(
    (f) => f.check === "truncation" && /Unbalanced/.test(f.message),
  );
}

test("an unclosed line followed by narration is reported", () => {
  const found = quoteFindings([
    "“That will never work.",
    "She turned to the window and said nothing for a long moment.",
    "“Fine,” he said.",
  ]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /That will never work/);
});

test("a block quotation that actually closes stays silent", () => {
  const found = quoteFindings([
    "“The letter began on a morning much like this one.",
    "It went on for some length about the weather and the harvest.",
    "And it ended, as such letters do, with a request for money.”",
    "She folded it away.",
  ]);
  assert.equal(found.length, 0);
});

test("continued speech that re-opens every paragraph stays silent", () => {
  const found = quoteFindings([
    "“My story unfolds seven hundred years ago, in the early days.",
    "“Prince Tua ruled his people and their fleet from the far isles.",
    "“Prince Tua had a wife, a dangerous but beautiful woman.",
    "“This was when Prince Tua realized his mistake, and surrendered.”",
  ]);
  assert.equal(found.length, 0);
});

test("continued speech that never closes is reported at its opener", () => {
  const found = quoteFindings([
    "“My story unfolds seven hundred years ago, in the early days.",
    "“Prince Tua ruled his people and their fleet from the far isles.",
    "She stopped there, and would say no more about it that night.",
  ]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /My story unfolds/);
});

test("a block quotation whose closer also opens is reported", () => {
  // The closer carries an opening mark, so it is a new line of dialogue and
  // not the end of the block. The block never closed.
  const found = quoteFindings([
    "“The letter began on a morning much like this one.",
    "It went on for some length about the weather and the harvest.",
    "“Fine,” he said.",
  ]);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /The letter began/);
});

test("one defect does not hide the next", () => {
  const found = quoteFindings([
    "“That will never work.",
    "She turned to the window and said nothing for a long moment.",
    "“Fine,” he said.",
    "He left the room.”",
  ]);
  assert.equal(found.length, 2);
});

test("a quote left open at the end of the chapter is reported", () => {
  const found = quoteFindings(["“And that was when everything changed."]);
  assert.equal(found.length, 1);
});

test("a straight closing mark balances the paragraph", () => {
  // “But—" is BALANCED: two marks. It is wrong in style, not in balance, and
  // the style check reports it. A balance check that counted only the curly
  // family read it as one open and no close, and the tolerances then ate it —
  // which is how five defects survived every run on two real books.
  const found = quoteFindings(['“But—"', "“I know the dangers,” he said."]);
  assert.equal(found.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx tsx --test test/publicationScanQuotes.test.ts`
Expected: FAIL on "an unclosed line followed by narration is reported"
(0 findings, expected 1) among others.

- [ ] **Step 3: Rewrite the check**

In `backend/src/publicationScan.ts`, delete `QuoteBalance` (`:225-230`), `QUOTE_FAMILIES` (`:241-247`), `type QuoteFamily` (`:248`), `countOf` (`:250-254`), `detectQuoteFamily` (`:263-278`) and `quoteBalance` (`:280-287`). Replace `unbalancedParagraphs` (`:379-416`) with:

```ts
/**
 * How a paragraph reads on its own, for the run-tracking below.
 */
interface ParagraphShape {
  opens: number;
  closes: number;
  balance: number;
  marks: number;
  startsWithOpen: boolean;
}

function shapeOf(paragraph: string, convention: QuoteConvention): ParagraphShape {
  const text = paragraph.trim();
  const marks = readMarks(text, convention);
  const opens = marks.filter((m) => m.role === "open").length;
  const closes = marks.filter((m) => m.role === "close").length;
  // Emphasis markers can sit between the paragraph's start and its mark:
  // _"Share your knowledge…"_ opens with an underscore.
  const first = marks[0];
  const startsWithOpen =
    first !== undefined &&
    first.role === "open" &&
    /^[_*]*$/.test(text.slice(0, first.index));
  return { opens, closes, balance: opens - closes, marks: marks.length, startsWithOpen };
}

/**
 * Paragraphs whose quotes do not balance.
 *
 * A quotation that runs across paragraphs is legitimate in two conventions:
 *
 *   - continued speech: every paragraph re-opens with the opening mark and
 *     only the last one closes;
 *   - a block quotation: one opening mark where it starts, one closing mark
 *     where it ends, and nothing on the paragraphs between.
 *
 * Judging each paragraph on its own reported the second kind twice — the
 * opener as unclosed, the closer as a stray — on a manuscript that was right.
 *
 * But the first version of that tolerance re-decided WHICH convention it was
 * looking at on every paragraph, so a run could be opened as continued
 * speech, carried by a block-quotation rule, and cleared by a continued-speech
 * rule. Almost nothing survived it: an unclosed line followed by any
 * quote-free paragraph and then any ordinary line of dialogue was forgiven
 * entirely. Measured on two real books, 5 of 15 unbalanced paragraphs were
 * reported in one and 0 of 8 in the other.
 *
 * So the reading is COMMITTED at the first paragraph after the opener, and
 * the rest of the run must conform to it. When a run breaks, the paragraph
 * that OPENED it is reported — that is where the fix goes — and the scan
 * resumes at the paragraph that broke it, so one defect never hides the next.
 */
function unbalancedParagraphs(
  body: string,
  convention: QuoteConvention,
): string[] {
  const paragraphs = body.split(/\n\n+/);
  const out: string[] = [];
  let i = 0;
  while (i < paragraphs.length) {
    const shape = shapeOf(paragraphs[i], convention);
    // Balanced and self-contained: nothing to carry.
    if (shape.balance === 0) {
      i++;
      continue;
    }
    // More than one unmatched mark, or an unmatched CLOSING mark: a defect
    // that no multi-paragraph convention explains. Report and move on.
    if (shape.balance !== 1) {
      out.push(excerptOf(paragraphs[i]));
      i++;
      continue;
    }
    // One unmatched opening mark: a run starts here. Which convention it is
    // is decided by the very next paragraph, and never revisited.
    const opener = i;
    const next = paragraphs[i + 1];
    if (next === undefined) {
      out.push(excerptOf(paragraphs[opener]));
      break;
    }
    const nextShape = shapeOf(next, convention);
    const resumeAt = runEnd(paragraphs, opener, convention, nextShape);
    if (resumeAt === null) {
      out.push(excerptOf(paragraphs[opener]));
      // Resume at the paragraph after the opener: the run is disowned, and
      // everything after it is read fresh.
      i = opener + 1;
      continue;
    }
    i = resumeAt;
  }
  return out;
}

/**
 * Where a legitimate multi-paragraph quotation ends, or null if it is not one.
 *
 * Returns the index of the paragraph AFTER the closer, so the caller resumes
 * there.
 */
function runEnd(
  paragraphs: string[],
  opener: number,
  convention: QuoteConvention,
  nextShape: ParagraphShape,
): number | null {
  if (nextShape.startsWithOpen) {
    // Continued speech. Every paragraph re-opens; the one that balances is
    // the last. A paragraph that neither re-opens nor closes breaks the run.
    for (let j = opener + 1; j < paragraphs.length; j++) {
      const s = shapeOf(paragraphs[j], convention);
      if (!s.startsWithOpen) return null;
      if (s.balance === 0) return j + 1;
      if (s.balance !== 1) return null;
    }
    return null; // ran off the end of the chapter, never closed
  }
  if (nextShape.marks === 0) {
    // Block quotation. The middles carry no marks at all; the closer carries
    // exactly one closing mark and no opening one.
    for (let j = opener + 1; j < paragraphs.length; j++) {
      const s = shapeOf(paragraphs[j], convention);
      if (s.marks === 0) continue;
      if (s.opens === 0 && s.closes === 1) return j + 1;
      return null;
    }
    return null; // ran off the end of the chapter, never closed
  }
  // The next paragraph carries marks but does not open with one — nothing
  // this opener could legitimately be the start of.
  return null;
}
```

Update `findTruncation`'s signature and call (`:418-421` and its call site at `:552`) to take a `QuoteConvention` instead of a `QuoteFamily`:

```ts
function findTruncation(
  units: ScanUnit[],
  explained: Set<string> = new Set(),
  convention: QuoteConvention = { family: QUOTE_FAMILIES[0], style: null },
): DraftFinding[] {
```

`QUOTE_FAMILIES` comes from the same import as `readMarks` — add it to the
import list in `publicationScan.ts`:

```ts
import {
  QUOTE_FAMILIES,
  readMarks,
  resolveConvention,
  type QuoteConvention,
  type QuoteStyle,
} from "./quoteMarks.js";
```

Inside `findTruncation`, `unbalancedParagraphs(body, family)` becomes
`unbalancedParagraphs(body, convention)`.

In `buildPublicationScan` (`:543`), replace the family line:

```ts
  // Read once, off the whole book: a chapter of pure narration has no quotes
  // to judge by, and would otherwise be read against a different convention
  // from the chapter before it. The author's declared style wins over the
  // manuscript's own majority — see resolveConvention.
  const convention = resolveConvention(
    units.map((u) => u.original).join("\n\n"),
    options?.quoteStyle,
  );
```

and pass `convention` to `findTruncation`.

Add `quoteStyle` to `PublicationScanOptions` (`:522`):

```ts
  /** The quotation-mark style the author declared, when the scan belongs to a
   *  job that has one. Falls back to the manuscript's own majority. */
  quoteStyle?: QuoteStyle;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/publicationScanQuotes.test.ts`
Expected: PASS, including the eight new tests.

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS. `publicationScan.test.ts` and `publicationReadiness.test.ts`
exercise the same check — if either now reports a paragraph it did not
before, read the paragraph before changing the rule: the new reading is
stricter on purpose, and a previously-silent genuine defect appearing is the
point of this task.

- [ ] **Step 6: Commit**

```bash
git add backend/src/publicationScan.ts backend/test/publicationScanQuotes.test.ts
git commit -m "fix(scan): commit to one reading of a multi-paragraph quotation

The tolerances were re-decided at every paragraph, so a run could be opened
as continued speech, carried by the block-quotation rule and cleared by the
continued-speech rule. An unclosed line followed by any quote-free paragraph
and any ordinary line of dialogue was forgiven entirely.

The reading is now committed at the first paragraph after the opener and the
rest of the run must conform. A broken run reports the paragraph that opened
it and the scan resumes at the paragraph that broke it, so one defect no
longer hides the next."
```

---

### Task 4: The `quote_style` check

**Files:**
- Modify: `backend/src/types.ts:389-396` (add `"quote_style"` to `STRUCTURAL_CHECKS`)
- Modify: `backend/src/publicationScan.ts` (new `findQuoteStyle`, wired into `buildPublicationScan`)
- Modify: `frontend/src/i18n.ts` (add `scan_check_quote_style` after `scan_check_dialect` at `:3322`)
- Test: `backend/test/publicationScanQuoteStyle.test.ts`

**Interfaces:**
- Consumes: `readMarks`, `resolveConvention` (Task 1); `PublicationScanOptions.quoteStyle` (Task 3).
- Produces: findings with `check: "quote_style"`, `severity: "info"`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/publicationScanQuoteStyle.test.ts`:

```ts
// A straight mark among curly ones is a house-style inconsistency, not
// evidence the text is cut off — so it is its own check, not another
// truncation finding.
//
// All five defects the scan missed on two real manuscripts were this: a curly
// opener closed by a straight mark. They are BALANCED, so no balance check
// can ever find them.

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPublicationScan } from "../src/publicationScan.ts";

const NARRATION = Array.from(
  { length: 20 },
  (_, i) => `Paragraph ${i} of ordinary narration carrying the chapter along.`,
).join("\n\n");

function styleFindings(body: string, quoteStyle?: "curly" | "straight") {
  const report = buildPublicationScan(
    [{ name: "Chapter one", original: body }] as never,
    quoteStyle ? ({ quoteStyle } as never) : undefined,
  );
  return report.findings.filter((f) => f.check === "quote_style");
}

const CURLY_DIALOGUE = "“Yes,” she said. “No,” he answered. “Maybe,” they said.";

test("a straight closing mark in a curly book is reported", () => {
  const found = styleFindings(
    [NARRATION, CURLY_DIALOGUE, '“But—"', NARRATION].join("\n\n"),
  );
  assert.equal(found.length, 1);
  assert.match(found[0].message, /But—/);
});

test("the finding names the chapter and carries the passage", () => {
  const found = styleFindings(
    [NARRATION, CURLY_DIALOGUE, '“I hope it won’t get boring for you."'].join(
      "\n\n",
    ),
  );
  assert.equal(found[0].location, "Chapter one");
  assert.match(found[0].message, /I hope it won’t get boring/);
});

test("a consistently straight book is left alone", () => {
  const body = [NARRATION, '"Yes," she said. "No," he answered. "Maybe."'].join(
    "\n\n",
  );
  assert.equal(styleFindings(body).length, 0);
});

test("a consistently curly book is left alone", () => {
  assert.equal(styleFindings([NARRATION, CURLY_DIALOGUE].join("\n\n")).length, 0);
});

test("the declared style decides, not the majority", () => {
  // Mostly curly, but the author says the book is straight. Then it is the
  // curly marks that are off-style.
  const body = [NARRATION, CURLY_DIALOGUE, '"Fine," he said.'].join("\n\n");
  const found = styleFindings(body, "straight");
  assert.ok(found.length >= 1);
  assert.match(found[0].message, /Yes/);
});

test("an evenly mixed book with no declared style reports nothing", () => {
  // Nothing to conform to. Reporting half the book's dialogue as off-style
  // would be a guess, and the settings panel asks the author instead.
  const body = [
    NARRATION,
    "“Yes,” she said. “No,” he answered.",
    '"Yes," she said. "No," he answered.',
  ].join("\n\n");
  assert.equal(styleFindings(body).length, 0);
});

test("apostrophes are never reported", () => {
  const body = [NARRATION, CURLY_DIALOGUE, "It’s Bria’s, he said."].join("\n\n");
  assert.equal(styleFindings(body).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/publicationScanQuoteStyle.test.ts`
Expected: FAIL — 0 findings where 1 expected.

- [ ] **Step 3: Add the check value and its label**

In `backend/src/types.ts`, extend `STRUCTURAL_CHECKS`:

```ts
export const STRUCTURAL_CHECKS = [
  "duplicate",
  "repetition",
  "empty_chapter",
  "numbering",
  "truncation",
  "dialect",
  "quote_style",
] as const;
```

In `frontend/src/i18n.ts`, add immediately after the `scan_check_dialect`
block (ends at `:3327`):

```ts
  scan_check_quote_style: {
    en: "Quotation-mark style",
    da: "Anførselstegnsstil",
    de: "Anführungszeichen-Stil",
    es: "Estilo de comillas",
  },
```

- [ ] **Step 4: Add the check**

In `backend/src/publicationScan.ts`, add after `findTruncation`:

```ts
/**
 * Marks that are not in the manuscript's own quotation-mark style.
 *
 * Curly or straight is the author's choice and both are correct; only
 * inconsistency is an error. So this reports nothing at all unless there is a
 * style to conform to — declared in the settings panel, or a clear majority
 * in the text. An evenly mixed manuscript with no declared style is exactly
 * the book this would do most damage to, and is left alone: the panel asks
 * its author instead.
 *
 * One finding per paragraph, not per mark. A line like `"We can try,"` has two
 * off-style marks and is one thing to fix.
 */
function findQuoteStyle(
  units: ScanUnit[],
  convention: QuoteConvention,
): DraftFinding[] {
  if (!convention.style) return [];
  const wanted = convention.style;
  const findings: DraftFinding[] = [];
  for (const u of units) {
    for (const paragraph of u.original.split(/\n\n+/)) {
      const text = paragraph.trim();
      if (!text) continue;
      const offStyle = readMarks(text, convention).filter((m) =>
        wanted === "curly" ? m.char === '"' : m.char !== '"',
      );
      if (offStyle.length === 0) continue;
      findings.push({
        check: "quote_style",
        severity: "info",
        location: u.name,
        message:
          wanted === "curly"
            ? `Straight quotation mark in a book that uses curly ones: "${excerptOf(paragraph)}"`
            : `Curly quotation mark in a book that uses straight ones: "${excerptOf(paragraph)}"`,
      });
    }
  }
  return findings;
}
```

Wire it into `buildPublicationScan`'s findings array, after `findTruncation`:

```ts
    ...findTruncation(units, reported, convention),
    ...findQuoteStyle(units, convention),
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/publicationScanQuoteStyle.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 6: Verify the label guard**

Run: `cd backend && npx tsx --test test/publicationScanLabels.test.ts`
Expected: PASS. This test joins `STRUCTURAL_CHECKS` to `i18n.ts` — it fails if
step 3's label was skipped, which is exactly what it exists for.

- [ ] **Step 7: Commit**

```bash
git add backend/src/types.ts backend/src/publicationScan.ts frontend/src/i18n.ts backend/test/publicationScanQuoteStyle.test.ts
git commit -m "feat(scan): report quotation marks that are off the book's style

All five defects the scan missed on two real manuscripts were a curly opener
closed by a straight mark. They are balanced, so no balance check can find
them — only a style check can. Its own check rather than another truncation
finding: a straight mark among curly ones is not evidence of a cut-off text."
```

---

### Task 5: Straight→curly normalisation, as one decision

**Files:**
- Modify: `backend/src/quoteRepair.ts` — delete private `marksOpen` (`:34`) and `dominantStyle` (`:62`), consume `quoteMarks.ts`; add the normalisation
- Test: `backend/test/quoteRepair.test.ts` (extend)

**Interfaces:**
- Consumes: `readMarks`, `resolveConvention`, `QuoteStyle` (Task 1).
- Produces: `getQuoteCorrections(text: string, declared?: QuoteStyle | null): Correction[]` — second parameter is new and optional, so existing callers keep working. Normalisation corrections carry `reason: "quote-style"` and `preApproved: true`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/quoteRepair.test.ts`:

```ts
// ── Normalising to the book's own style ──
//
// This was removed in a342be5 ("straight or curly is the author's choice, not
// an error") because dozens of separate quote corrections read as noise. It
// comes back because the style is now DECLARED rather than guessed, and
// because it arrives as one grouped decision — reason "quote-style" — rather
// than as dozens of independent ones.

test("a straight mark in a curly book is normalised", () => {
  const text = `${"“Yes,” she said. ".repeat(10)}\n\n“But—"`;
  const cs = getQuoteCorrections(text);
  const style = cs.filter((c) => c.reason === "quote-style");
  assert.equal(style.length, 1);
  assert.equal(style[0].corrected, "“But—”");
});

test("normalisation changes only quotation marks", () => {
  const text = `${"“Yes,” she said. ".repeat(10)}\n\n"We can try," she said.`;
  const cs = getQuoteCorrections(text).filter((c) => c.reason === "quote-style");
  assert.equal(cs.length, 1);
  assert.equal(cs[0].corrected, "“We can try,” she said.");
  // Same text once the marks are set aside.
  const strip = (s: string) => s.replace(/["“”]/g, "");
  assert.equal(strip(cs[0].original), strip(cs[0].corrected));
});

test("one correction per paragraph, not per mark", () => {
  const text = `${"“Yes,” she said. ".repeat(10)}\n\n"We can try," she said. "Or not."`;
  const cs = getQuoteCorrections(text).filter((c) => c.reason === "quote-style");
  assert.equal(cs.length, 1);
});

test("a consistently straight book is left alone", () => {
  const text = '"Yes," she said. "No," he answered. "Maybe," they said.';
  assert.equal(
    getQuoteCorrections(text).filter((c) => c.reason === "quote-style").length,
    0,
  );
});

test("an evenly mixed book with no declared style is left alone", () => {
  const text = `${"“Yes,” she said. ".repeat(5)}${'"No," he said. '.repeat(5)}`;
  assert.equal(
    getQuoteCorrections(text).filter((c) => c.reason === "quote-style").length,
    0,
  );
});

test("a declared style normalises the same book the other way", () => {
  const text = `${"“Yes,” she said. ".repeat(10)}`;
  const cs = getQuoteCorrections(text, "straight").filter(
    (c) => c.reason === "quote-style",
  );
  assert.ok(cs.length >= 1);
  assert.match(cs[0].corrected, /"Yes," she said\./);
});

test("normalisation is pre-approved — there is no judgement to review", () => {
  const text = `${"“Yes,” she said. ".repeat(10)}\n\n“But—"`;
  const cs = getQuoteCorrections(text).filter((c) => c.reason === "quote-style");
  assert.equal(cs[0].preApproved, true);
});

test("apostrophes are never touched", () => {
  const text = `${"“Yes,” she said. ".repeat(10)}\n\nIt’s Bria’s ‘thing’.`;
  const cs = getQuoteCorrections(text).filter((c) => c.reason === "quote-style");
  assert.equal(cs.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd backend && npx tsx --test test/quoteRepair.test.ts`
Expected: FAIL — 0 corrections with `reason === "quote-style"`.

- [ ] **Step 3: Consume the shared reading and add normalisation**

In `backend/src/quoteRepair.ts`, delete `marksOpen` (`:34-43`), `dominantStyle`
(`:62-74`), `STYLE_MAJORITY` (`:49`), `MIN_MARKS_TO_JUDGE` (`:52`) and
`type Style` (`:54`). Import instead:

```ts
import {
  readMarks,
  resolveConvention,
  type QuoteStyle,
} from "./quoteMarks.js";
```

Everywhere `dominantStyle(text) !== "curly"` appeared, use the resolved
convention. Change the signature and add the normalisation pass:

```ts
export function getQuoteCorrections(
  text: string,
  declared?: QuoteStyle | null,
): Correction[] {
  const convention = resolveConvention(text, declared);
  const out: Correction[] = [];
  const paragraphs = text.split(/\n\n+/);

  // ── Normalising to the book's own style ──
  //
  // Removed once (a342be5) on the grounds that straight or curly is the
  // author's choice. It is — which is why the style is now DECLARED in the
  // settings panel, or taken from a clear majority, and why a manuscript with
  // neither is left alone entirely. What was actually wrong the first time is
  // that dozens of separate corrections read as noise; these all carry
  // reason "quote-style", and the review screen answers them as one.
  //
  // preApproved: the manuscript's own convention decides this, so there is no
  // judgement for a reviewer to add and no tokens to spend asking for one.
  if (convention.style) {
    for (const paragraph of paragraphs) {
      const marks = readMarks(paragraph, convention);
      const offStyle = marks.filter((m) =>
        convention.style === "curly" ? m.char === '"' : m.char !== '"',
      );
      if (offStyle.length === 0) continue;
      const chars = [...paragraph];
      for (const m of marks) {
        if (convention.style === "curly") {
          if (m.char !== '"') continue;
          chars[indexOfCodePoint(paragraph, m.index)] =
            m.role === "open" ? convention.family.open : convention.family.close;
        } else {
          if (m.char === '"') continue;
          chars[indexOfCodePoint(paragraph, m.index)] = '"';
        }
      }
      const corrected = chars.join("");
      if (corrected === paragraph) continue;
      out.push({
        original: paragraph,
        corrected,
        kind: "copy",
        confidence: 1,
        preApproved: true,
        reason: "quote-style",
        note: "A quotation mark that is not the style this book uses.",
      } as Correction);
    }
  }

  // ── Orientation ──
  // Only a thing curly marks have. A manuscript in straight quotes — or one
  // with no clear style — has nothing here to repair.
  if (convention.style !== "curly") return out;

  // A paragraph the normalisation pass already rewrote is skipped here. Both
  // corrections quote the WHOLE paragraph as `original`, so emitting both
  // would produce two spans over the same text: apply the first and the
  // second no longer matches what it was cut from.
  const normalised = new Set(out.map((c) => c.original));

  for (const paragraph of paragraphs) {
    if (normalised.has(paragraph)) continue;
    // ...the existing body of the orientation loop, verbatim and unchanged,
    // from `const opens = marksOpen(paragraph);` through its `out.push({...})`.
    // The ONE edit inside it: `marksOpen(paragraph)` no longer exists, so
    // derive the same boolean array from the shared reading —
    //   const opens = readMarks(paragraph, convention).map((m) => m.role === "open");
    // which is the identical alternation for straight marks and, for curly
    // ones, reads the character instead of assuming alternation.
  }
  return out;
}
```

**Note on that one edit.** The old `marksOpen` decided EVERY mark by
alternation. `readMarks` decides a curly mark by its character. That is a
deliberate behaviour change and the orientation loop wants it: a paragraph
holding `”Good.”` — two closers — is the defect the orientation pass exists
to find, and alternation used to call the first one an opener and "fix" the
second. Run the existing `quoteRepair.test.ts` after this edit; if a test
that pinned the old alternation behaviour fails, read the paragraph before
changing the test.

```ts
// (end of getQuoteCorrections)
```

Add the helper next to `contextAround`:

```ts
/** `readMarks` reports UTF-16 indexes; `[...paragraph]` is code points. This
 *  converts one to the other so a surrogate pair earlier in the paragraph
 *  cannot shift which character gets rewritten. */
function indexOfCodePoint(paragraph: string, utf16Index: number): number {
  let cp = 0;
  let i = 0;
  for (const ch of paragraph) {
    if (i >= utf16Index) break;
    i += ch.length;
    cp++;
  }
  return cp;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/quoteRepair.test.ts`
Expected: PASS, including the eight new tests and every existing one —
the orientation repair's behaviour is unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/src/quoteRepair.ts backend/test/quoteRepair.test.ts
git commit -m "feat(edit): normalise quotation marks to the book's declared style

a342be5 removed this because straight or curly is the author's choice. It
is — so the style is now declared in the settings panel, a manuscript with
no clear convention is left alone, and every correction carries reason
'quote-style' so the review screen answers them as one rather than as
dozens."
```

---

### Task 6: Thread the setting through, and stop the filter eating it

**Files:**
- Modify: `backend/src/correctionHygiene.ts:575` (`dropNoOpCorrections` carve-out)
- Modify: `backend/src/queue.ts:2065` (pass the declared style), `:1282-1293` (pass it to the scan)
- Test: `backend/test/correctionHygiene.test.ts` (extend)

**Interfaces:**
- Consumes: `getQuoteCorrections(text, declared)` (Task 5); `CopyEditOptions.quoteStyle` (Task 2); `PublicationScanOptions.quoteStyle` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/correctionHygiene.test.ts`:

```ts
// Quote-style normalisation survives the no-op filter.
//
// a342be5 added that filter deliberately: a correction whose only difference
// is the style of a quotation mark was noise. It still is, from an LLM — but
// the deterministic normalisation pass is now the one thing in the run whose
// ENTIRE job is that difference, and the filter would delete all of it.

test("a quote-style correction is not dropped as a no-op", () => {
  const kept = dropNoOpCorrections([
    {
      original: '"We can try," she said.',
      corrected: "“We can try,” she said.",
      reason: "quote-style",
    } as never,
  ]);
  assert.equal(kept.length, 1);
});

test("an LLM's quote-style change is still dropped", () => {
  const kept = dropNoOpCorrections([
    {
      original: '"We can try," she said.',
      corrected: "“We can try,” she said.",
    } as never,
  ]);
  assert.equal(kept.length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/correctionHygiene.test.ts`
Expected: FAIL on "a quote-style correction is not dropped as a no-op"
(0 kept, expected 1).

- [ ] **Step 3: Carve out the filter**

In `backend/src/correctionHygiene.ts`, replace `dropNoOpCorrections` (`:575`):

```ts
/**
 * Corrections that change nothing — or nothing but the style of a quotation
 * mark or apostrophe, which is the author's to choose.
 *
 * The one exception is the deterministic normalisation pass (reason
 * "quote-style"), whose entire job is that difference. It runs only against a
 * style the author declared or the manuscript's own clear majority, which is
 * what makes it a fix rather than the preference this filter exists to drop.
 */
export function dropNoOpCorrections(corrections: Correction[]): Correction[] {
  return corrections.filter((c) => {
    if (c.reason === "quote-style") return c.original !== c.corrected;
    return (
      normalizeForComparison(c.original) !== normalizeForComparison(c.corrected)
    );
  });
}
```

- [ ] **Step 4: Pass the declared style at both call sites**

In `backend/src/queue.ts:2065`, pass the option through:

```ts
                const { getQuoteCorrections } = await import("./quoteRepair.js");
                const declaredQuoteStyle = (
                  job.editOptions as Record<string, unknown>
                )?.quoteStyle;
                const quoteCs = getQuoteCorrections(
                  chunk.body,
                  declaredQuoteStyle === "curly" || declaredQuoteStyle === "straight"
                    ? declaredQuoteStyle
                    : undefined,
                );
```

In `backend/src/queue.ts:1282`, extend the `buildPublicationScan` options
alongside the existing `englishDialect`:

```ts
    const declaredQuoteStyle = (job.editOptions as Record<string, unknown>)
      ?.quoteStyle;
    const report = buildPublicationScan(
      units.map((u) => ({ name: u.name, original: u.original })),
      {
        englishDialect:
          declaredDialect === "american" || declaredDialect === "british"
            ? declaredDialect
            : undefined,
        manuscriptLang: job.manuscriptLang,
        // The style the author declared. Without it the scan falls back to
        // the manuscript's own majority, which on a 60/40 book is a guess.
        quoteStyle:
          declaredQuoteStyle === "curly" || declaredQuoteStyle === "straight"
            ? declaredQuoteStyle
            : undefined,
      },
    );
```

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS.

- [ ] **Step 6: Build the backend to catch type errors the tests miss**

Run: `cd backend && npm run build`
Expected: no output, exit 0.

- [ ] **Step 7: Commit**

```bash
git add backend/src/correctionHygiene.ts backend/src/queue.ts backend/test/correctionHygiene.test.ts
git commit -m "feat(edit): thread the declared quote style to the scan and the repair

The no-op filter drops any correction whose only difference is quote style,
which is right for an LLM's output and would have deleted the whole of the
deterministic normalisation pass. Carved out by reason, not by shape."
```

---

### Task 7: The control in the settings panel

**Files:**
- Modify: `frontend/src/store.ts:600-632` (`applyDetectedSettings`), and the `copyEditOptions` default
- Modify: `frontend/src/components/ManuscriptSettings.tsx:58-69` (`CARD_SETTINGS`), `:149-151` (summary), and the control block after `oxfordComma`'s (`:275`)
- Modify: `frontend/src/i18n.ts` (`opt_quoteStyle`, `opt_quoteCurly`, `opt_quoteStraight`)

**Interfaces:**
- Consumes: `DetectedSettings.quoteStyle` (Task 2), `CopyEditOptions.quoteStyle` (Task 2).
- Produces: nothing other tasks consume.

- [ ] **Step 1: Add the strings**

In `frontend/src/i18n.ts`, after the `opt_oxfordComma` block (ends `:3514`):

```ts
  opt_quoteStyle: {
    en: "Quotation marks",
    da: "Anførselstegn",
    de: "Anführungszeichen",
    es: "Comillas",
  },
  opt_quoteCurly: {
    en: "Curly “ ”",
    da: "Krøllede “ ”",
    de: "Typografisch “ ”",
    es: "Tipográficas “ ”",
  },
  opt_quoteStraight: {
    en: 'Straight " "',
    da: 'Lige " "',
    de: 'Gerade " "',
    es: 'Rectas " "',
  },
```

- [ ] **Step 2: Default the option and apply the detection**

In `frontend/src/store.ts`, add `quoteStyle: "curly"` to the `copyEditOptions`
default object, and inside `applyDetectedSettings` after the `danishComma`
block (`:620-622`):

```ts
          if (detected.quoteStyle?.status === "detected") {
            copyEditOptions.quoteStyle = detected.quoteStyle.value;
          }
```

- [ ] **Step 3: Put it on the cards**

In `frontend/src/components/ManuscriptSettings.tsx`, add `"quoteStyle"` to
both the `edit` and `readthrough` entries of `CARD_SETTINGS` — the scan runs
on the readthrough card and consults it:

```ts
export const CARD_SETTINGS: Record<FrontCard, SettingKey[]> = {
  edit: [
    "manuscriptLang",
    "englishDialect",
    "quoteStyle",
    "oxfordComma",
    "introductoryComma",
    "danishComma",
  ],
  readthrough: ["manuscriptLang", "englishDialect", "quoteStyle"],
  translate: ["manuscriptLang"],
  language: ["manuscriptLang"],
};
```

Add to the summary at `:149`:

```ts
      if (key === "quoteStyle")
        return copyEditOptions.quoteStyle === "curly"
          ? t("opt_quoteCurly")
          : t("opt_quoteStraight");
```

Add the control block immediately before the `oxfordComma` one (`:275`),
following its exact shape:

```tsx
      {keys.includes("quoteStyle") && (
        <div className="fold-row">
          <span className="fold-label">{t("opt_quoteStyle")}</span>
          <span className="fold-control">
            <span className="option-toggle-group">
              <button
                type="button"
                className={`toggle-btn${copyEditOptions.quoteStyle === "curly" ? " active" : ""}`}
                onClick={() => {
                  setCopyEditOption("quoteStyle", "curly");
                  answer("quoteStyle");
                }}
              >
                {t("opt_quoteCurly")}
              </button>
              <button
                type="button"
                className={`toggle-btn${copyEditOptions.quoteStyle === "straight" ? " active" : ""}`}
                onClick={() => {
                  setCopyEditOption("quoteStyle", "straight");
                  answer("quoteStyle");
                }}
              >
                {t("opt_quoteStraight")}
              </button>
            </span>
            {badgeFor("quoteStyle", copyEditOptions.quoteStyle)}
          </span>
        </div>
      )}
```

- [ ] **Step 4: Build the frontend**

Run: `cd frontend && npm run build`
Expected: exit 0. A type error on `setCopyEditOption("quoteStyle", …)` means
Task 2's `CopyEditOptions.quoteStyle` was not added — fix there, not here.

- [ ] **Step 5: Run the backend suite for the label guard**

Run: `cd backend && npm test`
Expected: PASS, `publicationScanLabels.test.ts` included.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store.ts frontend/src/components/ManuscriptSettings.tsx frontend/src/i18n.ts
git commit -m "feat(settings): let the author confirm the book's quotation marks

On the edit and readthrough cards, beside the dialect and comma controls,
pre-filled from what the manuscript itself says and marked unsure when the
book is genuinely mixed — which is the book this setting matters most for."
```

---

### Task 8: Calibrate against the two real manuscripts

**Files:**
- Create: `backend/test/quoteScanCorpus.test.ts`
- Modify: `backend/src/publicationScan.ts` (header comment recording the measurement)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: nothing.

This is the task that decides the one rule counting cannot settle: an unclosed
line followed by a *new* line of dialogue is structurally identical to
two-paragraph continued speech. Tasks 1–7 leave it forgiven. Here it is
measured, and the measurement — not taste — decides whether to tighten it.

- [ ] **Step 1: Extract the corpus**

The manuscripts are in the installed app's database. Extract them to a
scratch directory (they are not checked in — they are the user's books):

```bash
D="$HOME/Library/Application Support/Bethaniel/data/bethaniel.db"
OUT=/tmp/quote-corpus && mkdir -p "$OUT"
sqlite3 "$D" "select md from documents where name='Rage of the Rule-r56RjHTNWw.epub' order by uploaded_at desc limit 1;" > "$OUT/rage.md"
sqlite3 "$D" "select md from documents where name='Path of the Taker 3.5ed-BxcOUV0vhx.epub' order by uploaded_at desc limit 1;" > "$OUT/taker.md"
wc -c "$OUT"/*.md
```

Expected: roughly 479,000 and 682,000 bytes.

- [ ] **Step 2: Write the measurement harness**

Create `backend/test/quoteScanCorpus.test.ts`. It **skips** when the corpus is
absent, so CI and other machines are unaffected:

```ts
// Calibration against two real manuscripts.
//
// Skipped unless the corpus is present — these are the user's own books and
// are not checked in. Extract them with the sqlite3 commands in
// docs/superpowers/plans/2026-09-23-one-reading-of-a-quotation-mark.md.
//
// What this pins: the five defects the old check missed are caught, the
// legitimate seven-paragraph legend stays silent, and the total finding count
// does not quietly grow when someone loosens a rule later.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { findChapters } from "../src/chapters.ts";
import { buildPublicationScan } from "../src/publicationScan.ts";

const DIR = "/tmp/quote-corpus";
const have = existsSync(`${DIR}/rage.md`) && existsSync(`${DIR}/taker.md`);

function scanBook(file: string) {
  const md = readFileSync(`${DIR}/${file}`, "utf8");
  const units = findChapters(md).map((c) => ({
    name: c.title,
    original: md.slice(c.start, c.end),
  }));
  return buildPublicationScan(units as never, { manuscriptLang: "en" } as never);
}

test("the five straight-among-curly defects are caught", { skip: !have }, () => {
  const all = [
    ...scanBook("rage.md").findings,
    ...scanBook("taker.md").findings,
  ].filter((f) => f.check === "quote_style");
  const messages = all.map((f) => f.message).join("\n");
  for (const passage of [
    "But—",
    "to be any threat to them",
    "remembering so",
    "get too boring for you",
    "Share your knowledge",
  ]) {
    assert.ok(messages.includes(passage), `missed: ${passage}`);
  }
});

test("the seven-paragraph legend stays silent", { skip: !have }, () => {
  const ch4 = scanBook("taker.md").findings.filter(
    (f) => f.location === "Chapter Four",
  );
  assert.deepEqual(ch4, []);
});

test("the scan is byte-identical across runs", { skip: !have }, () => {
  assert.equal(
    JSON.stringify(scanBook("rage.md")),
    JSON.stringify(scanBook("rage.md")),
  );
});
```

- [ ] **Step 3: Run it and read the numbers**

Run: `cd backend && npx tsx --test test/quoteScanCorpus.test.ts`

Then print the full breakdown to decide the open rule:

```bash
cd backend && npx tsx -e '
const { findChapters } = require("./src/chapters.ts");
const { buildPublicationScan } = require("./src/publicationScan.ts");
const { readFileSync } = require("fs");
for (const f of ["rage", "taker"]) {
  const md = readFileSync(`/tmp/quote-corpus/${f}.md`, "utf8");
  const units = findChapters(md).map((c) => ({ name: c.title, original: md.slice(c.start, c.end) }));
  const r = buildPublicationScan(units, { manuscriptLang: "en" });
  const q = r.findings.filter((x) => x.check === "truncation" && /Unbalanced/.test(x.message));
  const s = r.findings.filter((x) => x.check === "quote_style");
  console.log(`${f}: balance=${q.length} style=${s.length}`);
  for (const x of [...q, ...s]) console.log(`  [${x.check}] ${x.location}: ${x.message.slice(0, 120)}`);
}'
```

**Baselines to compare against** (the old check, measured 2026-09-23):
Rage reported 5 of 15 genuinely unbalanced paragraphs; Taker reported 0 of 8.
The 15 and the 8 are the upper bound of what is *there*, and 6 of Taker's 8
are the legitimate Chapter Four legend.

- [ ] **Step 4: Read every new finding by hand**

For each finding the new check reports that the old one did not, open the
passage and decide: genuine defect, or false positive? A rule that catches
everything by also reporting the Chapter Four legend is a failure, not a win.

**If false positives appear**, the likely culprit is the block-quotation
branch of `runEnd`: an author who does not re-open every paragraph of a long
speech is common, and `Rage of the Rule`'s Frontmatter does exactly that
(paragraph opens with `“`, the next closes with `”` without re-opening).
Decide deliberately whether that shape is legitimate here; if it is, add it as
a third committed reading in `runEnd` with a test in
`publicationScanQuotes.test.ts` naming the manuscript it came from.

**If two-paragraph false negatives remain** (an unclosed line forgiven because
the next paragraph is a new line of dialogue), tighten only with evidence:
count how many of the surviving misses have a second paragraph that is short
and carries a dialogue tag, and how many legitimate runs would be caught by
the same rule. Implement it only if the first number beats the second.

- [ ] **Step 5: Record the measurement in the module header**

Add to the top of `backend/src/publicationScan.ts`, above the existing header,
with the real numbers from step 3 — not the placeholders:

```ts
// The quotation checks were scored against two real manuscripts (Rage of the
// Rule, Path of the Taker, 2026-09-23). Before: 5 of 15 genuinely unbalanced
// paragraphs reported in one book, 0 of 8 in the other, every miss a curly
// opener closed by a straight mark. After: <fill in from the measurement>.
// The seven-paragraph told-aloud legend in Taker's Chapter Four is the case
// that keeps the tolerances honest — it must stay silent. Read the header of
// quoteMarks.ts before changing a rule here.
```

- [ ] **Step 6: Run the whole suite one last time**

Run: `cd backend && npm test && npm run build`
Expected: PASS, exit 0.

- [ ] **Step 7: Commit**

```bash
git add backend/test/quoteScanCorpus.test.ts backend/src/publicationScan.ts
git commit -m "test(scan): score the quotation checks against two real books

Skipped unless the corpus is present — they are the author's own manuscripts
and are not checked in. What it pins: the five straight-among-curly defects
that survived every previous run are caught, and the seven-paragraph legend
that keeps the tolerances honest stays silent."
```

---

## Notes for the implementer

- **Do not delete the tolerances.** `Path of the Taker`'s Chapter Four is a
  real seven-paragraph quotation and a scan that reports it is worse than the
  one being replaced. Every task has a test pinning it.
- **Never invent a missing closing mark.** Where it belongs is a judgement.
  The scan reports; only style normalisation rewrites, and it rewrites nothing
  but the marks themselves.
- **Straight vs curly is not an error.** A consistently straight book is
  correct and must come out of this untouched. Every check here reports
  inconsistency with a *known* convention, never a preference.
- **Task 8 is not optional.** Tasks 1–7 are testable in isolation, but the one
  rule that counting cannot settle is settled there, with numbers.
