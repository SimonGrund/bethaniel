# Translation Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Once an author has paid for a cloud translation, Betty reads the book, asks a few questions in the author's interface language, and the answers bind every stage of the translation.

**Architecture:** A new backend module, `translationBrief.ts`, collects candidate terms from the whole manuscript in code, with no LLM. It asks the paid model for at most 5 multiple-choice questions and validates them. A new route serves those questions. On the frontend, a modal shows the fixed tone question plus the model's questions. It turns the answers into a plain-text brief and submits the job with it. `/queue/add` puts the brief ahead of the author's style sheet in the translate task's `styleGuide`. The draft, polish and fluency-review stages all read that field already, and so does `retrySpec`.

**Tech Stack:** TypeScript, Express (backend), React + Zustand (frontend), node:test via tsx (tests live in `backend/test/`, including tests of pure frontend modules).

**Spec:** `docs/superpowers/specs/2026-10-08-translation-brief-design.md`

## Global Constraints

- Questions are asked **after payment, before submission**. Translation is cloud-only (`LOCAL_BLOCKED_MODES` in `cloudEstimate.ts`).
- The model asks **at most 5** questions. The fixed tone question (match / softer / stricter) is always shown and comes from `i18n.ts`, not the model.
- Every question, option label and `why` is in the interface language (`store.lang`: `en`, `da`, `de`, `es`). Any other value falls back to English.
- A question's `term` must appear **verbatim** in the manuscript, or the question is dropped.
- The brief **adds to** the author's style sheet and wins any clash. It is capped at **4,000 characters** server-side.
- The author is never stuck. If the questions call fails, only the tone question is shown and the job can still start.
- The brief never enters `cloudFailureReport.ts` (closed enums only; this repo is public).
- No Worker change: the questions call is an ordinary `/v1/chat/completions` on the translate credential.
- UI follows the light warm parchment theme (reuse the `cloud-buy` modal styles).
- Commit messages use conventional prefixes (`feat(translate): …`) and end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Work on branch `feat/translation-brief`; never push to `main` (every push to `main` is a release).

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/translationBrief.ts` (create) | Candidate collection, excerpt sampling, question parsing, the questions runner (LLM injected), `combineTranslationNotes` |
| `backend/src/prompts.ts` (modify) | `buildBriefQuestionsPrompt` |
| `backend/src/routes.ts` (modify) | `POST /translate/brief/questions`; `/queue/add` accepts `translationBrief` |
| `backend/src/cloudEstimate.ts` (modify) | Price the questions call into a translate quote |
| `frontend/src/translationBrief.ts` (create) | Shared types, `defaultAnswers`, `renderTranslationBrief` (pure) |
| `frontend/src/api.ts` (modify) | `getTranslationQuestions`; `addToQueue` takes `translationBrief` |
| `frontend/src/store.ts` (modify) | Persisted `pendingTranslationBrief` |
| `frontend/src/components/TranslationQuestions.tsx` (create) | The modal |
| `frontend/src/components/EditTrigger.tsx` (modify) | Claim → questions → submit |
| `frontend/src/i18n.ts`, `frontend/src/styles/global.css` (modify) | Strings (4 languages) and styles |
| `backend/test/translationBrief.test.ts`, `backend/test/translationBriefRender.test.ts` (create), `backend/test/cloudEstimate.test.ts` (modify) | Tests |
| `CLAUDE.md` (modify) | Document the module and flow |

Run all backend commands from `backend/`. A single test file runs with `node --import tsx --test test/<file>.test.ts`.

---

### Task 1: Candidate collection and excerpts

**Files:**
- Create: `backend/src/translationBrief.ts`
- Test: `backend/test/translationBrief.test.ts`

**Interfaces:**
- Consumes: `isSentenceInitial(text: string, index: number): boolean` and `capitalisesNouns(lang?: string): boolean` from `backend/src/spellcheck.ts`.
- Produces:
  - `type CandidateKind = "name" | "invented" | "honorific" | "unit" | "title"`
  - `interface BriefCandidate { term: string; kind: CandidateKind; count: number; example: string }`
  - `collectBriefCandidates(text: string, lang: string, isKnownWord?: (word: string) => boolean): BriefCandidate[]`
  - `sampleExcerpts(text: string, count?: number, words?: number): string[]`

- [ ] **Step 1: Write the failing tests**

Create `backend/test/translationBrief.test.ts`:

```ts
// ── The translation brief: what Betty asks before she translates ──
//
// Candidate collection is deterministic and runs over the whole book, so the
// model only ever sees a short list. These pin what counts as a candidate.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  collectBriefCandidates,
  sampleExcerpts,
} from "../src/translationBrief.ts";

const find = (cs: { term: string; kind: string }[], term: string, kind: string) =>
  cs.find((c) => c.term === term && c.kind === kind);

test("a name counts only where it is capitalised mid-sentence, three times or more", () => {
  const text =
    "Anna walked in. She saw Kragehøj from the hill. They loved Kragehøj. " +
    "Later, Kragehøj burned. Kragehøj stood. We met Bo and Bo again.";
  const cs = collectBriefCandidates(text, "en");
  assert.equal(find(cs, "Kragehøj", "name")?.count, 3);
  assert.equal(find(cs, "Anna", "name"), undefined, "sentence-initial only");
  assert.equal(find(cs, "Bo", "name"), undefined, "twice is not enough");
});

test("an invented word is one the dictionary rejects, three times or more", () => {
  const text = "The glimmerwick shone. A glimmerwick fell. Two glimmerwick lights.";
  const known = (w: string) => w.toLowerCase() !== "glimmerwick";
  assert.equal(find(collectBriefCandidates(text, "en", known), "glimmerwick", "invented")?.count, 3);
  assert.equal(
    find(collectBriefCandidates(text, "en"), "glimmerwick", "invented"),
    undefined,
    "no dictionary, no invented words",
  );
});

test("in German a capitalised noun is not a name; without a dictionary there are no names", () => {
  const text =
    "Er sah die Zeit. Die Zeit verging. Mit der Zeit kam Almut. Dann rief Almut. Wo war Almut?";
  const known = (w: string) => w !== "Almut";
  const cs = collectBriefCandidates(text, "de", known);
  assert.equal(find(cs, "Almut", "name")?.count, 3);
  assert.equal(find(cs, "Zeit", "name"), undefined);
  assert.equal(collectBriefCandidates(text, "de").filter((c) => c.kind === "name").length, 0);
});

test("honorifics, units and titles count from their first occurrence", () => {
  const text = "He met Mr Hale. It was three miles off, then two more miles. She read *The Hollow Crown* twice.";
  const cs = collectBriefCandidates(text, "en");
  assert.equal(find(cs, "Mr", "honorific")?.count, 1);
  assert.equal(find(cs, "miles", "unit")?.count, 2);
  assert.equal(find(cs, "The Hollow Crown", "title")?.count, 1);
  assert.equal(find(cs, "Mr", "name"), undefined, "an honorific is not also a name");
});

test("each candidate carries the sentence it first appeared in", () => {
  const text = "Rain fell. Then Kragehøj woke up. We saw Kragehøj. Near Kragehøj, nothing.";
  const c = find(collectBriefCandidates(text, "en"), "Kragehøj", "name");
  assert.equal(c?.example, "Then Kragehøj woke up.");
});

test("the list is ranked by count and capped at 40", () => {
  const names = Array.from({ length: 50 }, (_, i) =>
    "Qa" + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)),
  );
  const text = "start " + names.map((n, i) => `and ${n} `.repeat(3 + (i % 5))).join("");
  const cs = collectBriefCandidates(text, "en");
  assert.equal(cs.length, 40);
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i - 1].count >= cs[i].count);
});

test("excerpts are spread over the book and bounded in length", () => {
  const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + "word ".repeat(100));
  const ex = sampleExcerpts(paras.join("\n\n"), 4, 300);
  assert.equal(ex.length, 4);
  assert.ok(ex[0].startsWith("Paragraph 0 "));
  assert.ok(ex[3].startsWith("Paragraph 30 "));
  for (const e of ex) assert.ok(e.split(/\s+/).length <= 600);
  assert.deepEqual(sampleExcerpts("", 4, 300), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/translationBrief.test.ts`
Expected: FAIL, because the module `../src/translationBrief.ts` cannot be found.

- [ ] **Step 3: Implement**

Create `backend/src/translationBrief.ts`:

```ts
// ── Translation brief: what Betty asks before she translates ──
//
// After an author pays for a translation, Betty reads the book and asks a
// handful of questions a translator would otherwise guess at — keep a name or
// translate it, what to do with "Mr", miles or a book title — and the answers
// bind every stage of the run (see combineTranslationNotes and /queue/add).
//
// The model never reads the whole book for this. The candidates are counted
// here, deterministically, over every word of it, so a name that lives only
// in chapter 30 is still found and the call costs the same for any length.

import { capitalisesNouns, isSentenceInitial } from "./spellcheck.js";

export type CandidateKind = "name" | "invented" | "honorific" | "unit" | "title";

export interface BriefCandidate {
  term: string;
  kind: CandidateKind;
  count: number;
  /** The sentence it first appeared in, trimmed. */
  example: string;
}

/** A name or invented word seen fewer times is not worth a question. */
const MIN_REPEATS = 3;
const MAX_CANDIDATES = 40;
const EXAMPLE_CHARS = 200;
/** How far an example looks for its sentence's ends — a run-on paragraph
 *  with no full stop must not turn into a scan of the whole book. */
const EXAMPLE_REACH = 600;

const WORD_RE = /\p{L}[\p{L}'’-]*\p{L}/gu;
/** *Title* or _Title_: up to six words, starting with a capital. */
const TITLE_RE = /(?<![*_\p{L}])[*_]([^*_\n]{2,60})[*_](?![*_\p{L}])/gu;

const HONORIFICS: Record<string, string[]> = {
  en: ["Mr", "Mrs", "Ms", "Miss", "Dr", "Sir", "Lady", "Lord", "Madam"],
  da: ["Hr", "Fru", "Frøken", "Dr"],
  de: ["Herr", "Frau", "Fräulein", "Dr"],
  es: ["Señor", "Señora", "Señorita", "Don", "Doña", "Sr", "Sra", "Dr"],
  fr: ["Monsieur", "Madame", "Mademoiselle", "Mme", "Mlle", "Dr"],
};

/** Imperial units: the ones a translation into a metric language has to
 *  decide about. Lowercased. "foot" and "stone" are left out — far more
 *  often "on foot" and a stone than a measurement. */
const UNITS = new Set([
  "mile", "miles", "feet", "inch", "inches", "yard", "yards", "pound",
  "pounds", "ounce", "ounces", "gallon", "gallons", "acre", "acres", "pint",
  "pints",
]);

export function baseLang(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0];
}

function exampleAt(text: string, index: number): string {
  const stop = /[.!?\n]/;
  let start = index;
  while (start > 0 && index - start < EXAMPLE_REACH && !stop.test(text[start - 1])) start--;
  let end = index;
  while (end < text.length && end - index < EXAMPLE_REACH && !stop.test(text[end])) end++;
  if (end < text.length && text[end] !== "\n") end++;
  const s = text.slice(start, end).replace(/\s+/g, " ").trim();
  return s.length > EXAMPLE_CHARS ? s.slice(0, EXAMPLE_CHARS - 1) + "…" : s;
}

/**
 * The terms in this manuscript a translator would have to decide about.
 *
 * `isKnownWord` is the manuscript language's dictionary
 * (spellcheck.getWordValidator). Without it there are no invented words —
 * and no German names, because in German every noun is capitalised and
 * capitalisation alone would offer "Zeit" as a name.
 */
export function collectBriefCandidates(
  text: string,
  lang: string,
  isKnownWord?: (word: string) => boolean,
): BriefCandidate[] {
  const base = baseLang(lang);
  const honorifics = new Set(HONORIFICS[base] ?? []);
  const nounsCapitalised = capitalisesNouns(base);
  const tally = new Map<string, BriefCandidate>();
  const bump = (kind: CandidateKind, term: string, index: number) => {
    const key = `${kind}|${term}`;
    const seen = tally.get(key);
    if (seen) seen.count++;
    else tally.set(key, { term, kind, count: 1, example: exampleAt(text, index) });
  };

  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0];
    const i = m.index ?? 0;
    if (honorifics.has(w)) {
      bump("honorific", w, i);
      continue;
    }
    if (UNITS.has(w.toLowerCase())) {
      bump("unit", w.toLowerCase(), i);
      continue;
    }
    const capital = w[0] !== w[0].toLowerCase();
    if (capital) {
      if (isSentenceInitial(text, i)) continue;
      if (nounsCapitalised && (!isKnownWord || isKnownWord(w))) continue;
      bump("name", w, i);
    } else if (isKnownWord && w.length >= 4 && !isKnownWord(w)) {
      bump("invented", w, i);
    }
  }

  for (const m of text.matchAll(TITLE_RE)) {
    const inner = m[1].trim();
    if (!/^\p{Lu}/u.test(inner) || inner.split(/\s+/).length > 6) continue;
    bump("title", inner, m.index ?? 0);
  }

  const kept = [...tally.values()].filter(
    (c) => (c.kind !== "name" && c.kind !== "invented") || c.count >= MIN_REPEATS,
  );
  kept.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
  return kept.slice(0, MAX_CANDIDATES);
}

/**
 * `count` passages of about `words` words, spread evenly over the book, for
 * the model to hear its tone. Whole paragraphs; one that runs past twice the
 * budget is cut.
 */
export function sampleExcerpts(text: string, count = 4, words = 300): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: string[] = [];
  const used = new Set<number>();
  for (let k = 0; k < count && paras.length > 0; k++) {
    let p = Math.floor((k * paras.length) / count);
    const taken: string[] = [];
    let n = 0;
    while (p < paras.length && n < words && !used.has(p)) {
      used.add(p);
      taken.push(paras[p]);
      n += paras[p].split(/\s+/).length;
      p++;
    }
    if (taken.length === 0) continue;
    const joined = taken.join("\n\n");
    const ws = joined.split(/\s+/);
    out.push(ws.length > words * 2 ? ws.slice(0, words * 2).join(" ") + " …" : joined);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/translationBrief.test.ts`
Expected: PASS, 7 tests. If the example test fails because `isSentenceInitial` treats a character differently, read `PRE_WORD_SKIP` / `SENTENCE_TERMINATORS` in `spellcheck.ts`. Then adjust the test text, not the helper.

- [ ] **Step 5: Commit**

```bash
git add backend/src/translationBrief.ts backend/test/translationBrief.test.ts
git commit -m "feat(translate): find the terms a translation has to decide about

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Questions prompt, parser, runner and combined notes

**Files:**
- Modify: `backend/src/translationBrief.ts`
- Modify: `backend/src/prompts.ts` (add after `buildTranslationPrompt`, around line 856)
- Test: `backend/test/translationBrief.test.ts` (append)

**Interfaces:**
- Consumes: `collectBriefCandidates`, `sampleExcerpts`, `baseLang` (Task 1); `parseJsonResponse(raw: string): unknown` from `llm.ts`; `type LlmCall = (systemPrompt: string, userPayload: string, opts?: { maxTokens?: number }) => Promise<string>` from `storyAnalysis.ts`.
- Produces:
  - `interface BriefOption { id: string; label: string }`
  - `interface BriefQuestion { id: string; term?: string; question: string; options: BriefOption[]; suggested: string; why: string }`
  - `const MAX_BRIEF_QUESTIONS = 5`, `const BRIEF_OUTPUT_TOKENS = 1200`
  - `parseBriefQuestions(raw: string, sourceText: string): BriefQuestion[] | null` (null = the answer could not be used at all, so retry)
  - `interface BriefRequest { text: string; manuscriptLang: string; targetLang: string; uiLang: string }`
  - `interface BriefDeps { llm: LlmCall; isKnownWord?: (word: string) => boolean }`
  - `runBriefQuestions(req: BriefRequest, deps: BriefDeps): Promise<BriefQuestion[]>`, which throws if `deps.llm` throws
  - `combineTranslationNotes(brief: string, styleGuide: string): string`
  - in `prompts.ts`: `buildBriefQuestionsPrompt(o: { sourceLanguage: string; targetLanguage: string; uiLanguage: string }): string`

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/translationBrief.test.ts`, and add the new names to its import:

```ts
import {
  collectBriefCandidates,
  sampleExcerpts,
  parseBriefQuestions,
  runBriefQuestions,
  combineTranslationNotes,
} from "../src/translationBrief.ts";
```

```ts
const SOURCE = "They loved Kragehøj. We saw Kragehøj. Near Kragehøj, nothing.";

const q = (over: Record<string, unknown> = {}) => ({
  id: "q1",
  term: "Kragehøj",
  question: "Behold navnet?",
  options: [{ id: "a", label: "Behold" }, { id: "b", label: "Oversæt" }],
  suggested: "a",
  why: "Det er et stednavn.",
  ...over,
});

test("a valid answer parses, code fences or not", () => {
  const raw = JSON.stringify({ questions: [q()] });
  assert.equal(parseBriefQuestions(raw, SOURCE)?.length, 1);
  assert.equal(parseBriefQuestions("```json\n" + raw + "\n```", SOURCE)?.[0].term, "Kragehøj");
});

test("prose, or no questions array, is unusable", () => {
  assert.equal(parseBriefQuestions("I cannot help with that.", SOURCE), null);
  assert.equal(parseBriefQuestions('{"answer": 1}', SOURCE), null);
  assert.deepEqual(parseBriefQuestions('{"questions": []}', SOURCE), []);
});

test("a bad question is dropped on its own, the rest kept", () => {
  const raw = JSON.stringify({
    questions: [
      q({ id: "bad1", suggested: "z" }),
      q({ id: "bad2", options: [{ id: "a", label: "Only" }] }),
      q({ id: "bad3", term: "Ravnsborg" }), // not in the book
      q({ id: "bad4", options: [{ id: "a", label: "X" }, { id: "a", label: "Y" }] }),
      q({ id: "good" }),
      q({ id: "good" }), // duplicate id
      q({ id: "noterm", term: undefined }),
    ],
  });
  const out = parseBriefQuestions(raw, SOURCE)!;
  assert.deepEqual(out.map((x) => x.id), ["good", "noterm"]);
  assert.equal(out[1].term, undefined);
});

test("no more than five questions are kept", () => {
  const raw = JSON.stringify({ questions: Array.from({ length: 7 }, (_, i) => q({ id: `q${i}` })) });
  assert.equal(parseBriefQuestions(raw, SOURCE)?.length, 5);
});

test("the runner asks once when the first answer is good, in the interface language", async () => {
  const calls: { system: string; user: string }[] = [];
  const out = await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "French", uiLang: "da" },
    {
      llm: async (system, user) => {
        calls.push({ system, user });
        return JSON.stringify({ questions: [q()] });
      },
    },
  );
  assert.equal(out.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /in Danish/);
  assert.match(calls[0].system, /into French/);
  assert.match(calls[0].user, /Kragehøj/);
});

test("the runner retries once on a bad answer, then gives up with no questions", async () => {
  let n = 0;
  const retried = await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "French", uiLang: "en" },
    { llm: async (_s, user) => (++n === 1 ? "nope" : (assert.match(user, /PREVIOUS RESPONSE/), JSON.stringify({ questions: [q()] }))) },
  );
  assert.equal(retried.length, 1);
  assert.equal(n, 2);

  let m = 0;
  const none = await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "French", uiLang: "en" },
    { llm: async () => (m++, "still nope") },
  );
  assert.deepEqual(none, []);
  assert.equal(m, 2);
});

test("an interface language Betty does not speak falls back to English", async () => {
  let system = "";
  await runBriefQuestions(
    { text: SOURCE, manuscriptLang: "en", targetLang: "German", uiLang: "fr" },
    { llm: async (s) => ((system = s), '{"questions": []}') },
  );
  assert.match(system, /in English/);
});

test("the brief goes first and wins; either side may be empty", () => {
  const both = combineTranslationNotes("TRANSLATION BRIEF:\n- x", "Use Oxford commas.");
  assert.ok(both.indexOf("TRANSLATION BRIEF") < both.indexOf("Oxford"));
  assert.match(both, /brief above wins/);
  assert.equal(combineTranslationNotes("", " Use Oxford commas. "), "Use Oxford commas.");
  assert.equal(combineTranslationNotes(" B ", ""), "B");
  assert.equal(combineTranslationNotes("", ""), "");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test test/translationBrief.test.ts`
Expected: FAIL. `parseBriefQuestions` (and the other new names) are not exported.

- [ ] **Step 3: Add the prompt**

In `backend/src/prompts.ts`, directly after the closing `}` of `buildTranslationPrompt`, add:

```ts
/**
 * The questions Betty asks before a paid translation (translationBrief.ts).
 * The user message carries the candidates and excerpts as JSON. Tone is not
 * asked here — the app always asks it itself, in its own words.
 */
export function buildBriefQuestionsPrompt(o: {
  sourceLanguage: string;
  targetLanguage: string;
  uiLanguage: string;
}): string {
  return `You are a literary translator preparing to translate a book from ${o.sourceLanguage} into ${o.targetLanguage}. Before you start, you may ask the author a FEW questions about choices you would otherwise have to guess.

The user message is JSON with:
- "candidates": terms found by counting over the WHOLE book — names, invented words, honorifics, units of measure and titles — each with how often it occurs and one example sentence;
- "excerpts": a few passages from across the book, so you can hear its tone.

Ask at most 5 questions, and only about real decisions a careful translator into ${o.targetLanguage} would face:
- whether a name, place or invented word is kept as it is or translated (and if translated, offer renderings);
- how to handle honorifics, units of measure or titles;
- anything else specific to THIS book that changes the translation throughout.
Never ask about tone or register — that is asked separately. Never ask about grammar, spelling or punctuation. Skip names that obviously stay as they are. Fewer, better questions beat five weak ones; zero questions is a valid answer.

Write every "question", every option "label" and every "why" in ${o.uiLanguage} — the author reads them in ${o.uiLanguage}. A "term" is quoted EXACTLY as it is written in the book.

Respond with STRICT JSON only — no prose, no code fences:
{"questions":[{"id":"q1","term":"<exact term from the book; omit if the question is not about one term>","question":"…","options":[{"id":"a","label":"…"},{"id":"b","label":"…"}],"suggested":"a","why":"<one sentence>"}]}
Each question has 2 to 4 options. "suggested" is the id of the option you would choose yourself.`;
}
```

- [ ] **Step 4: Add the parser, runner and combiner**

In `backend/src/translationBrief.ts`, add these imports below the existing one:

```ts
import { parseJsonResponse } from "./llm.js";
import { buildBriefQuestionsPrompt } from "./prompts.js";
import type { LlmCall } from "./storyAnalysis.js";
```

Append to the end of the file:

```ts
// ── The questions ──

export interface BriefOption {
  id: string;
  label: string;
}

export interface BriefQuestion {
  id: string;
  /** The source term, verbatim from the book, when the question is about one. */
  term?: string;
  question: string;
  options: BriefOption[];
  /** The id of the option Betty would choose. */
  suggested: string;
  why: string;
}

export const MAX_BRIEF_QUESTIONS = 5;
export const BRIEF_OUTPUT_TOKENS = 1200;

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  da: "Danish",
  de: "German",
  es: "Spanish",
  fr: "French",
};
/** The languages the app's own interface is translated into (i18n.ts). */
const UI_LANGS = new Set(["en", "da", "de", "es"]);

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

function toQuestion(item: unknown, sourceText: string): BriefQuestion | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const id = str(o.id);
  const question = str(o.question);
  const suggested = str(o.suggested);
  if (!id || !question || !suggested) return null;
  if (!Array.isArray(o.options) || o.options.length < 2 || o.options.length > 4) return null;
  const options: BriefOption[] = [];
  const ids = new Set<string>();
  for (const opt of o.options) {
    if (!opt || typeof opt !== "object") return null;
    const oid = str((opt as Record<string, unknown>).id);
    const label = str((opt as Record<string, unknown>).label);
    if (!oid || !label || ids.has(oid)) return null;
    ids.add(oid);
    options.push({ id: oid, label });
  }
  if (!ids.has(suggested)) return null;
  let term: string | undefined;
  if (o.term !== undefined && o.term !== null) {
    const t = str(o.term);
    // A term the book does not contain is a name the model made up.
    if (!t || !sourceText.includes(t)) return null;
    term = t;
  }
  return { id, ...(term ? { term } : {}), question, options, suggested, why: str(o.why) ?? "" };
}

/**
 * The model's questions, each checked on its own: one malformed question is
 * dropped, the rest kept. `null` means the answer as a whole was unusable
 * (not JSON, no `questions` array) and is worth one retry.
 */
export function parseBriefQuestions(raw: string, sourceText: string): BriefQuestion[] | null {
  const parsed = parseJsonResponse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const list = (parsed as { questions?: unknown }).questions;
  if (!Array.isArray(list)) return null;
  const out: BriefQuestion[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const q = toQuestion(item, sourceText);
    if (!q || seen.has(q.id)) continue;
    seen.add(q.id);
    out.push(q);
    if (out.length === MAX_BRIEF_QUESTIONS) break;
  }
  return out;
}

export interface BriefRequest {
  text: string;
  manuscriptLang: string;
  /** A language name, as the wizard stores it ("French"). */
  targetLang: string;
  /** The interface language code (store.lang). */
  uiLang: string;
}

export interface BriefDeps {
  llm: LlmCall;
  isKnownWord?: (word: string) => boolean;
}

/**
 * Ask the paid model for its questions. Two tries at a usable answer, then
 * none — the author still gets the tone question and can start the run.
 * A failing call (network, out of credit) throws; the route turns that into
 * "no questions" too.
 */
export async function runBriefQuestions(
  req: BriefRequest,
  deps: BriefDeps,
): Promise<BriefQuestion[]> {
  const candidates = collectBriefCandidates(req.text, req.manuscriptLang, deps.isKnownWord);
  const ui = baseLang(req.uiLang);
  const system = buildBriefQuestionsPrompt({
    sourceLanguage: LANGUAGE_NAMES[baseLang(req.manuscriptLang)] ?? "the source language",
    targetLanguage: req.targetLang,
    uiLanguage: UI_LANGS.has(ui) ? LANGUAGE_NAMES[ui] : "English",
  });
  const user = JSON.stringify({ candidates, excerpts: sampleExcerpts(req.text) });
  for (let attempt = 0; attempt < 2; attempt++) {
    const payload =
      attempt === 0
        ? user
        : `${user}\n\nYOUR PREVIOUS RESPONSE WAS NOT VALID JSON IN THE REQUIRED SHAPE. Respond again with STRICT valid JSON only — no prose, no code fences.`;
    const raw = await deps.llm(system, payload, { maxTokens: BRIEF_OUTPUT_TOKENS });
    const questions = parseBriefQuestions(raw, req.text);
    if (questions !== null) return questions;
  }
  return [];
}

/**
 * What a translate task reads as its notes: the author's answers first, then
 * their style sheet. The brief is the newer, translation-specific choice, so
 * it wins where the two disagree.
 */
export function combineTranslationNotes(brief: string, styleGuide: string): string {
  const b = brief.trim();
  const s = styleGuide.trim();
  if (!b) return s;
  if (!s) return b;
  return `${b}\n\nSTYLE SHEET (the author's own notes — where they disagree with the brief above, the brief above wins):\n${s}`;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --import tsx --test test/translationBrief.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/translationBrief.ts backend/src/prompts.ts backend/test/translationBrief.test.ts
git commit -m "feat(translate): ask the paid model for its questions before translating

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The questions route, and the brief in `/queue/add`

**Files:**
- Modify: `backend/src/routes.ts` (imports around lines 63–70; `/queue/add` destructure at ~658–680; `authorStyleGuide` at ~808; translate prompt at ~1138–1146; task `styleGuide` at ~1208; new route next to `/cloud/estimate` at ~2794)

**Interfaces:**
- Consumes: `runBriefQuestions`, `combineTranslationNotes` (Task 2); `analyzeStream(model, text, systemPrompt, signal?)` from `llm.ts`; `getWordValidator(lang, opts?)` from `spellcheck.ts`.
- Produces:
  - `POST /api/translate/brief/questions`. Body: `{ units: string[]; targetLang: string; manuscriptLang: string; uiLang: string }`. Response: `200 { questions: BriefQuestion[], degraded?: true }`, or `400 { error }` when there is no text.
  - `POST /api/queue/add` accepts an optional `translationBrief: string`.

This route is a thin shell over tested functions, and `routes.ts` has no route-level tests. It is verified by the build here and by hand in Task 7.

- [ ] **Step 1: Imports**

In `backend/src/routes.ts`, add `analyzeStream` to the existing `import { … } from "./llm.js";` block. Then change `import { findNewSuspectWords } from "./spellcheck.js";` to:

```ts
import { findNewSuspectWords, getWordValidator } from "./spellcheck.js";
```

Add this with the other module imports:

```ts
import { combineTranslationNotes, runBriefQuestions } from "./translationBrief.js";
```

Check that the cloud model id isn't already a constant: `grep -n '"custom:bethaniel-cloud"' backend/src/routes.ts`. If no constant exists, add one near the imports:

```ts
/** The model id a Betty in the Cloud run is submitted under (EditTrigger). */
const CLOUD_MODEL_ID = "custom:bethaniel-cloud";
```

- [ ] **Step 2: Accept the brief in `/queue/add`**

Add `translationBrief,` to the destructured `req.body` list, after `targetLang,`.

Directly after the line `const hasAuthorSheet = authorStyleGuide.trim().length > 0;`, add:

```ts
    // A paid translation's brief (translationBrief.ts): the author's answers
    // to Betty's questions, ahead of their own sheet. Every translation stage
    // reads the task's styleGuide — draft, polish, fluency review, retries —
    // so this one string is all the wiring there is. Capped: it is a short
    // list of choices, never a manuscript.
    const translateNotes = combineTranslationNotes(
      typeof translationBrief === "string" ? translationBrief.slice(0, 4000) : "",
      authorStyleGuide,
    );
```

In the `case "translate":` branch, replace `authorStyleGuide,` in the `buildTranslationPrompt(...)` call with `translateNotes,`. Update the comment above it to:

```ts
          // The author's sheet and brief only: the translation role reads
          // them as a glossary, and a bare list of names does not say how to
          // render them.
```

In the `submitTask({...})` call, change

```ts
          styleGuide: currentMode === "translate" ? authorStyleGuide : promptStyleGuide,
```

to

```ts
          styleGuide: currentMode === "translate" ? translateNotes : promptStyleGuide,
```

- [ ] **Step 3: Add the questions route**

Directly above `router.post("/cloud/estimate", …`, add:

```ts
// ── Translation brief: Betty's questions before a paid translation ──
// Called right after the credential is claimed, on that credential: the
// Worker routes it to the translation model and meters it like any other
// call, and the quote already includes it (cloudEstimate.ts). Never fails
// the author — anything that goes wrong is "no questions", and the app
// still asks its own tone question.
router.post("/translate/brief/questions", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const units: string[] = Array.isArray(body.units)
    ? body.units.filter((u: unknown): u is string => typeof u === "string")
    : [];
  const text = units.join("\n\n");
  if (!text.trim()) {
    res.status(400).json({ error: "units are required" });
    return;
  }
  const manuscriptLang = typeof body.manuscriptLang === "string" ? body.manuscriptLang : "en";
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  try {
    const questions = await runBriefQuestions(
      {
        text,
        manuscriptLang,
        targetLang: typeof body.targetLang === "string" ? body.targetLang : "English",
        uiLang: typeof body.uiLang === "string" ? body.uiLang : "en",
      },
      {
        llm: async (system, user) => {
          let acc = "";
          for await (const tok of analyzeStream(CLOUD_MODEL_ID, user, system, ac.signal)) acc += tok;
          return acc;
        },
        isKnownWord: getWordValidator(manuscriptLang) ?? undefined,
      },
    );
    res.json({ questions });
  } catch (err) {
    // The message only — never the text that was sent.
    console.warn(
      `[Brief] questions unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    res.json({ questions: [], degraded: true });
  }
});
```

If Step 1 found an existing constant for the cloud model id, use it instead of `CLOUD_MODEL_ID`.

- [ ] **Step 4: Build and run the full backend suite**

Run: `npm run build && npm test 2>&1 | tail -8`
Expected: `tsc` exits cleanly, and the tests show `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes.ts
git commit -m "feat(translate): serve Betty's questions and bind the brief to every translation stage

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Price the questions call

**Files:**
- Modify: `backend/src/cloudEstimate.ts` (`estimateTranslateMode`, ~line 340)
- Test: `backend/test/cloudEstimate.test.ts` (append)

**Interfaces:**
- Consumes: `BRIEF_OUTPUT_TOKENS` (Task 2).
- Produces: a translate estimate that includes `2 × (3,500 in + 1,200 out)` tokens.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/cloudEstimate.test.ts`:

```ts
// ── Betty's questions before a translation are paid for ──
test("a translate quote includes the brief questions call and its retry", () => {
  const input = {
    units: [{ wordCount: 100 }],
    wordsPerChunk: 2000,
    runMode: "speed" as const,
    reviewMode: true,
    styleComplianceAgent: false,
    extraPass: false,
    numPredict: 4096,
  };
  const translate = estimateCloudJob({ ...input, modes: ["translate"] }).perMode.translate;
  assert.ok(translate.inputTokens >= 2 * 3500, `input ${translate.inputTokens}`);
  assert.ok(translate.outputTokens >= 2 * 1200, `output ${translate.outputTokens}`);
  const copy = estimateCloudJob({ ...input, modes: ["copy_edit"] }).perMode.copy_edit;
  assert.ok(copy.outputTokens < 2 * 1200, "an edit does not pay for translation questions");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test test/cloudEstimate.test.ts`
Expected: FAIL on `output …` (a 100-word translation is estimated far below 2,400 output tokens). If TypeScript rejects a field in `input`, compare it with `CloudEstimateInput` (`cloudEstimate.ts:207`) and fix the literal.

- [ ] **Step 3: Implement**

In `backend/src/cloudEstimate.ts`, add to the imports:

```ts
import { BRIEF_OUTPUT_TOKENS } from "./translationBrief.js";
```

Near the other module constants (next to `FLUENCY_VERDICT_TOKENS`), add:

```ts
/** Betty's questions before a translation (translationBrief.ts): a fixed
 *  prompt, at most 40 candidates and four ~300-word excerpts, whatever the
 *  book's length. */
const BRIEF_QUESTIONS_INPUT_TOKENS = 3500;
```

In `estimateTranslateMode`, directly before `return { inputTokens: Math.ceil(inputTokens), …`, add:

```ts
  // Betty's questions before the run — one call, priced twice for its one
  // retry. Paid by the author like the rest, so it belongs in the quote.
  inputTokens += 2 * BRIEF_QUESTIONS_INPUT_TOKENS;
  outputTokens += 2 * BRIEF_OUTPUT_TOKENS;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test test/cloudEstimate.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add backend/src/cloudEstimate.ts backend/test/cloudEstimate.test.ts
git commit -m "feat(translate): price Betty's questions into a translation quote

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Frontend brief module, API and store

**Files:**
- Create: `frontend/src/translationBrief.ts`
- Modify: `frontend/src/api.ts` (`addToQueue` at ~276; new function after `getCloudEstimate` at ~712)
- Modify: `frontend/src/store.ts` (interface next to `styleGuide` ~249; initial state next to `styleGuide: ""` ~766; `partialize` ~1405)
- Test: `backend/test/translationBriefRender.test.ts`

**Interfaces:**
- Consumes: the JSON shape of `BriefQuestion` from Task 2 (redeclared here; the frontend does not import backend code).
- Produces (from `frontend/src/translationBrief.ts`):
  - `type Tone = "match" | "softer" | "stricter"`
  - `interface BriefOption`, `interface BriefQuestion`, the same shapes as the backend
  - `interface BriefAnswer { optionId?: string; other?: string }`
  - `interface PendingTranslationBrief { questions: BriefQuestion[] | null; tone: Tone; answers: Record<string, BriefAnswer>; degraded?: boolean }`
  - `defaultAnswers(questions: BriefQuestion[]): Record<string, BriefAnswer>`
  - `renderTranslationBrief(tone: Tone, questions: BriefQuestion[], answers: Record<string, BriefAnswer>): string`
- Produces (api): `getTranslationQuestions(req: { units: string[]; targetLang: string; manuscriptLang: string; uiLang: string }): Promise<{ questions: BriefQuestion[]; degraded: boolean }>`, which never throws. `addToQueue` params gain `translationBrief?: string`.
- Produces (store): `pendingTranslationBrief: PendingTranslationBrief | null`, `setPendingTranslationBrief(p: PendingTranslationBrief | null): void`, both persisted.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/translationBriefRender.test.ts`:

```ts
// ── The brief the author's answers become ──
//
// Pure, and tested from here because the frontend has no test runner.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultAnswers,
  renderTranslationBrief,
  type BriefQuestion,
} from "../../frontend/src/translationBrief.ts";

const qs: BriefQuestion[] = [
  {
    id: "q1",
    term: "Kragehøj",
    question: "Behold stednavnet?",
    options: [{ id: "a", label: "Behold" }, { id: "b", label: "Oversæt" }],
    suggested: "a",
    why: "",
  },
  {
    id: "q2",
    question: "Miles?",
    options: [{ id: "a", label: "Keep miles" }, { id: "b", label: "Convert to km" }],
    suggested: "b",
    why: "",
  },
];

test("matching the tone with nothing to answer is no brief at all", () => {
  assert.equal(renderTranslationBrief("match", [], {}), "");
});

test("a softer or stricter tone is said plainly", () => {
  assert.match(renderTranslationBrief("softer", [], {}), /Tone: softer/);
  assert.match(renderTranslationBrief("stricter", [], {}), /Tone: stricter and shorter/);
});

test("each answer is a line, with the term quoted and the question kept", () => {
  const brief = renderTranslationBrief("match", qs, { q1: { optionId: "b" }, q2: { optionId: "a" } });
  assert.match(brief, /^TRANSLATION BRIEF/);
  assert.match(brief, /- "Kragehøj" — Behold stednavnet\? → Oversæt/);
  assert.match(brief, /- Miles\? → Keep miles/);
});

test("an author's own answer is kept verbatim; an empty one falls back to Betty's suggestion", () => {
  const own = renderTranslationBrief("match", qs, { q1: { other: " Krähenhügel " }, q2: { other: "" } });
  assert.match(own, /→ "Krähenhügel"/);
  assert.match(own, /- Miles\? → Convert to km/);
});

test("by default every question takes Betty's suggestion", () => {
  assert.deepEqual(defaultAnswers(qs), { q1: { optionId: "a" }, q2: { optionId: "b" } });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `backend/`): `node --import tsx --test test/translationBriefRender.test.ts`
Expected: FAIL, because `frontend/src/translationBrief.ts` cannot be found.

- [ ] **Step 3: Implement the module**

Create `frontend/src/translationBrief.ts`:

```ts
// ── The translation brief, on this side ──
//
// After a paid translation is claimed, Betty asks her questions
// (TranslationQuestions.tsx; the questions come from the backend's
// translationBrief.ts) and the answers become this plain-text brief, sent with
// the job. The backend puts it ahead of the author's style sheet, where every
// translation stage reads it.
//
// The brief is English instructions for the translator, but the answers are
// quoted as the author saw them — in the interface language — and a term
// exactly as the book spells it. The model reads both.
//
// Pure; tested from backend/test/translationBriefRender.test.ts.

export type Tone = "match" | "softer" | "stricter";

export interface BriefOption {
  id: string;
  label: string;
}

export interface BriefQuestion {
  id: string;
  term?: string;
  question: string;
  options: BriefOption[];
  suggested: string;
  why: string;
}

/** One answer: an option, or the author's own words ("Other…"). */
export interface BriefAnswer {
  optionId?: string;
  other?: string;
}

/** A paid translation waiting on its answers. `questions` is null while
 *  Betty is still reading the book. */
export interface PendingTranslationBrief {
  questions: BriefQuestion[] | null;
  tone: Tone;
  answers: Record<string, BriefAnswer>;
  /** The questions call failed; only the tone question is on offer. */
  degraded?: boolean;
}

const TONE_LINES: Record<Tone, string | null> = {
  match: null, // what a translation does anyway
  softer: "- Tone: softer and warmer than the original, without losing any meaning.",
  stricter:
    "- Tone: stricter and shorter than the original — tighten and cut padding, never content.",
};

export function defaultAnswers(questions: BriefQuestion[]): Record<string, BriefAnswer> {
  return Object.fromEntries(questions.map((q) => [q.id, { optionId: q.suggested }]));
}

function answerText(q: BriefQuestion, a: BriefAnswer | undefined): string {
  const own = a?.other?.trim();
  if (own) return `"${own}"`;
  const id = a?.optionId ?? q.suggested;
  const opt = q.options.find((o) => o.id === id) ?? q.options.find((o) => o.id === q.suggested);
  return opt?.label ?? "";
}

export function renderTranslationBrief(
  tone: Tone,
  questions: BriefQuestion[],
  answers: Record<string, BriefAnswer>,
): string {
  const lines: string[] = [];
  const toneLine = TONE_LINES[tone];
  if (toneLine) lines.push(toneLine);
  for (const q of questions) {
    const term = q.term ? `"${q.term}" — ` : "";
    lines.push(`- ${term}${q.question} → ${answerText(q, answers[q.id])}`);
  }
  if (lines.length === 0) return "";
  return [
    "TRANSLATION BRIEF (the author's answers to the translator's questions — these override the style sheet):",
    ...lines,
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `backend/`): `node --import tsx --test test/translationBriefRender.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: API wrappers**

In `frontend/src/api.ts`, add to the `addToQueue` params type after `targetLang?: string;`:

```ts
  /** A paid translation's brief (translationBrief.ts). */
  translationBrief?: string;
```

Import the type at the top of `api.ts`:

```ts
import type { BriefQuestion } from "./translationBrief";
```

After `getCloudEstimate`, add:

```ts
/**
 * Betty's questions before a paid translation. Never throws: anything that
 * goes wrong is "no questions", and the author still gets the tone question.
 */
export async function getTranslationQuestions(req: {
  units: string[];
  targetLang: string;
  manuscriptLang: string;
  uiLang: string;
}): Promise<{ questions: BriefQuestion[]; degraded: boolean }> {
  try {
    const res = await apiFetch("/translate/brief/questions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) return { questions: [], degraded: true };
    const data = await res.json();
    return {
      questions: Array.isArray(data.questions) ? data.questions : [],
      degraded: data.degraded === true,
    };
  } catch {
    return { questions: [], degraded: true };
  }
}
```

- [ ] **Step 6: Store**

In `frontend/src/store.ts`, import the type:

```ts
import type { PendingTranslationBrief } from "./translationBrief";
```

In the state interface, directly after the `styleGuide` setter declaration (around line 249), add:

```ts
  /** A paid translation waiting on the author's answers to Betty's
   *  questions (TranslationQuestions). Persisted: the credential is already
   *  bought, and closing the app must not lose the run. */
  pendingTranslationBrief: PendingTranslationBrief | null;
  setPendingTranslationBrief: (p: PendingTranslationBrief | null) => void;
```

In the initial state, after `setStyleGuide: (styleGuide) => set({ styleGuide }),` (around line 767), add:

```ts
      pendingTranslationBrief: null,
      setPendingTranslationBrief: (pendingTranslationBrief) => set({ pendingTranslationBrief }),
```

In `partialize`, after `targetLang: state.targetLang,`, add:

```ts
        pendingTranslationBrief: state.pendingTranslationBrief,
```

Don't add it to the reset block near line 1295. A reset of wizard settings must not throw away a paid run.

- [ ] **Step 7: Type-check the frontend**

Run (from the repo root): `npm run build:frontend 2>&1 | tail -5`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/translationBrief.ts frontend/src/api.ts frontend/src/store.ts backend/test/translationBriefRender.test.ts
git commit -m "feat(translate): turn the author's answers into a translation brief

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The questions modal and the paid-run flow

**Files:**
- Create: `frontend/src/components/TranslationQuestions.tsx`
- Modify: `frontend/src/components/EditTrigger.tsx` (`handleClickRef` ~192; `useCloudPurchase` callback ~209–226; `handleClick` ~319–360; JSX next to `<CloudCheckoutModal` ~826)
- Modify: `frontend/src/i18n.ts` (add keys before the closing `};` of `TRANSLATIONS`, ~6453)
- Modify: `frontend/src/styles/global.css` (after the `.cloud-buy__accept input` rule, ~5630)

**Interfaces:**
- Consumes: `getTranslationQuestions`, `addToQueue({ …, translationBrief })` (Task 5); store `pendingTranslationBrief` / `setPendingTranslationBrief` (Task 5); `defaultAnswers`, `renderTranslationBrief`, `Tone`, `BriefAnswer` (Task 5); `Modal` (`open`, no `onClose` = cannot be dismissed).
- Produces: `TranslationQuestions` props `{ lang: Lang; units: string[]; targetLang: string; manuscriptLang: string; onSubmit: (brief: string) => Promise<void> }`.

- [ ] **Step 1: i18n strings**

In `frontend/src/i18n.ts`, add these entries to `TRANSLATIONS`, before its closing `};`:

```ts
  tb_title: {
    en: "Before Betty translates",
    da: "Før Betty oversætter",
    de: "Bevor Betty übersetzt",
    es: "Antes de que Betty traduzca",
  },
  tb_reading: {
    en: "Betty is reading your book for anything she should ask you first…",
    da: "Betty læser din bog for at se, om der er noget, hun bør spørge dig om først…",
    de: "Betty liest dein Buch, um zu sehen, was sie dich vorher fragen sollte…",
    es: "Betty está leyendo tu libro por si hay algo que deba preguntarte antes…",
  },
  tb_intro: {
    en: "A few choices that run through the whole translation. Betty's suggestion is already selected — change only what you would like done differently.",
    da: "Et par valg, der gælder hele oversættelsen. Bettys forslag er allerede valgt — ret kun det, du gerne vil have gjort anderledes.",
    de: "Ein paar Entscheidungen, die für die ganze Übersetzung gelten. Bettys Vorschlag ist bereits ausgewählt — ändere nur, was du anders haben möchtest.",
    es: "Unas pocas decisiones que afectan a toda la traducción. La sugerencia de Betty ya está seleccionada: cambia solo lo que quieras de otra manera.",
  },
  tb_degraded: {
    en: "Betty could not prepare her questions this time. You can still set the tone and start the translation.",
    da: "Betty kunne ikke forberede sine spørgsmål denne gang. Du kan stadig vælge tonen og starte oversættelsen.",
    de: "Betty konnte ihre Fragen diesmal nicht vorbereiten. Du kannst trotzdem den Ton wählen und die Übersetzung starten.",
    es: "Betty no ha podido preparar sus preguntas esta vez. Aun así puedes elegir el tono y empezar la traducción.",
  },
  tb_tone_q: {
    en: "How should the translation sound?",
    da: "Hvordan skal oversættelsen lyde?",
    de: "Wie soll die Übersetzung klingen?",
    es: "¿Cómo debe sonar la traducción?",
  },
  tb_tone_match: {
    en: "Like the original",
    da: "Som originalen",
    de: "Wie das Original",
    es: "Como el original",
  },
  tb_tone_softer: {
    en: "Softer and warmer than the original",
    da: "Blødere og varmere end originalen",
    de: "Weicher und wärmer als das Original",
    es: "Más suave y cálida que el original",
  },
  tb_tone_stricter: {
    en: "Stricter and shorter than the original",
    da: "Strammere og kortere end originalen",
    de: "Straffer und kürzer als das Original",
    es: "Más concisa y estricta que el original",
  },
  tb_suggested: {
    en: "Betty suggests",
    da: "Bettys forslag",
    de: "Bettys Vorschlag",
    es: "Sugerencia de Betty",
  },
  tb_other: {
    en: "Other…",
    da: "Andet…",
    de: "Anderes…",
    es: "Otra…",
  },
  tb_other_placeholder: {
    en: "Your answer",
    da: "Dit svar",
    de: "Deine Antwort",
    es: "Tu respuesta",
  },
  tb_start: {
    en: "Start translation",
    da: "Start oversættelsen",
    de: "Übersetzung starten",
    es: "Empezar la traducción",
  },
  tb_skip: {
    en: "Skip — use Betty's judgement",
    da: "Spring over — brug Bettys skøn",
    de: "Überspringen — Bettys Urteil folgen",
    es: "Omitir: usar el criterio de Betty",
  },
```

- [ ] **Step 2: Styles**

In `frontend/src/styles/global.css`, after the `.cloud-buy__accept input { … }` rule, add:

```css
/* ── Translation brief: Betty's questions before a paid translation ── */
.translation-brief__q {
  border: 1px solid #d9c9a8;
  border-radius: 8px;
  padding: 0.6rem 0.8rem 0.7rem;
  margin: 0 0 0.8rem;
  background: #fbf8f0;
}

.translation-brief__q legend {
  padding: 0 0.3rem;
  font-size: 0.9rem;
  font-weight: 600;
  color: #4a3f2f;
}

.translation-brief__term {
  font-family: "Cormorant Garamond", Georgia, serif;
  font-style: italic;
  font-size: 1.05rem;
  margin-right: 0.4rem;
}

.translation-brief__opt {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.2rem 0;
  font-size: 0.86rem;
  cursor: pointer;
}

.translation-brief__opt input {
  margin-top: 0.2rem;
  accent-color: #8b7355;
  flex-shrink: 0;
}

.translation-brief__suggested {
  color: #8b7355;
  font-size: 0.8rem;
}

.translation-brief__other {
  box-sizing: border-box;
  width: 100%;
  margin: 0.3rem 0 0;
  padding: 0.35rem 0.5rem;
  border: 1px solid #d9c9a8;
  border-radius: 6px;
  font: inherit;
  font-size: 0.86rem;
  background: #fffdf8;
}

.translation-brief__why {
  margin: 0.4rem 0 0;
  font-size: 0.8rem;
  line-height: 1.45;
  color: #6b5438;
}
```

- [ ] **Step 3: The component**

Create `frontend/src/components/TranslationQuestions.tsx`:

```tsx
// ── Before Betty translates ──
//
// Shown once a paid translation's credential has been claimed and before the
// job is submitted. Betty reads the book (translationBrief.ts on the backend)
// and asks a few questions in the author's interface language; the app adds
// its own tone question. The answers become the translation brief.
//
// It cannot be dismissed: the run is paid for. Both buttons start it — Skip
// simply takes Betty's suggestions — and if her questions could not be
// prepared, the tone question alone is enough to go on.

import { useEffect, useState } from "react";
import Modal from "./Modal";
import { useTranslation } from "../i18n";
import { getTranslationQuestions } from "../api";
import { useStore } from "../store";
import type { Lang } from "../types";
import {
  defaultAnswers,
  renderTranslationBrief,
  type BriefAnswer,
  type Tone,
} from "../translationBrief";

const TONES: Tone[] = ["match", "softer", "stricter"];

/** One questions call per pending run, even when React mounts this twice
 *  (StrictMode) — each call is paid for. */
let asking = false;

export default function TranslationQuestions({
  lang,
  units,
  targetLang,
  manuscriptLang,
  onSubmit,
}: {
  lang: Lang;
  units: string[];
  targetLang: string;
  manuscriptLang: string;
  onSubmit: (brief: string) => Promise<void>;
}) {
  const t = useTranslation(lang);
  const pending = useStore((s) => s.pendingTranslationBrief);
  const setPending = useStore((s) => s.setPendingTranslationBrief);
  const [submitting, setSubmitting] = useState(false);

  const needsQuestions = pending !== null && pending.questions === null;
  useEffect(() => {
    if (!needsQuestions || asking) return;
    asking = true;
    void getTranslationQuestions({ units, targetLang, manuscriptLang, uiLang: lang })
      .then((r) => {
        const cur = useStore.getState().pendingTranslationBrief;
        if (!cur) return;
        setPending({
          ...cur,
          questions: r.questions,
          answers: defaultAnswers(r.questions),
          degraded: r.degraded,
        });
      })
      .finally(() => {
        asking = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsQuestions]);

  if (!pending) return null;
  const questions = pending.questions;

  const setTone = (tone: Tone) => setPending({ ...pending, tone });
  const setAnswer = (id: string, a: BriefAnswer) =>
    setPending({ ...pending, answers: { ...pending.answers, [id]: a } });

  const submit = async (useSuggestions: boolean) => {
    const qs = questions ?? [];
    const brief = useSuggestions
      ? renderTranslationBrief("match", qs, defaultAnswers(qs))
      : renderTranslationBrief(pending.tone, qs, pending.answers);
    setSubmitting(true);
    try {
      // EditTrigger clears the pending brief once the job is accepted; on a
      // failure it stays, answers and all, for another go.
      await onSubmit(brief);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open labelledBy="tbTitle" className="cloud-buy translation-brief">
      <h2 id="tbTitle" className="cloud-buy__title">
        {t("tb_title")}
      </h2>
      {questions === null ? (
        <p className="cloud-buy__note" role="status">
          {t("tb_reading")}
        </p>
      ) : (
        <>
          <p className="cloud-buy__note">{t("tb_intro")}</p>
          {pending.degraded && (
            <p className="cloud-buy__note cloud-buy__note--quiet">{t("tb_degraded")}</p>
          )}

          <fieldset className="translation-brief__q">
            <legend>{t("tb_tone_q")}</legend>
            {TONES.map((tone) => (
              <label key={tone} className="translation-brief__opt">
                <input
                  type="radio"
                  name="tb-tone"
                  checked={pending.tone === tone}
                  onChange={() => setTone(tone)}
                />
                <span>{t(`tb_tone_${tone}`)}</span>
              </label>
            ))}
          </fieldset>

          {questions.map((q) => {
            const a = pending.answers[q.id] ?? { optionId: q.suggested };
            const ownAnswer = a.other !== undefined;
            return (
              <fieldset key={q.id} className="translation-brief__q">
                <legend>
                  {q.term && <span className="translation-brief__term">{q.term}</span>}
                  {q.question}
                </legend>
                {q.options.map((o) => (
                  <label key={o.id} className="translation-brief__opt">
                    <input
                      type="radio"
                      name={`tb-${q.id}`}
                      checked={!ownAnswer && a.optionId === o.id}
                      onChange={() => setAnswer(q.id, { optionId: o.id })}
                    />
                    <span>
                      {o.label}
                      {o.id === q.suggested && (
                        <em className="translation-brief__suggested"> · {t("tb_suggested")}</em>
                      )}
                    </span>
                  </label>
                ))}
                <label className="translation-brief__opt">
                  <input
                    type="radio"
                    name={`tb-${q.id}`}
                    checked={ownAnswer}
                    onChange={() => setAnswer(q.id, { other: "" })}
                  />
                  <span>{t("tb_other")}</span>
                </label>
                {ownAnswer && (
                  <input
                    type="text"
                    className="translation-brief__other"
                    value={a.other}
                    maxLength={200}
                    placeholder={t("tb_other_placeholder")}
                    onChange={(e) => setAnswer(q.id, { other: e.target.value })}
                    autoFocus
                  />
                )}
                {q.why && <p className="translation-brief__why">{q.why}</p>}
              </fieldset>
            );
          })}

          <div className="cloud-buy__actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={submitting}
              onClick={() => void submit(true)}
            >
              {t("tb_skip")}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={submitting}
              onClick={() => void submit(false)}
            >
              {t("tb_start")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
```

- [ ] **Step 4: Wire it into EditTrigger**

In `frontend/src/components/EditTrigger.tsx`:

(a) Add the import next to `CloudCheckoutModal`:

```ts
import TranslationQuestions from "./TranslationQuestions";
```

(b) Near the other store reads at the top of the component, add:

```ts
  const pendingTranslationBrief = useStore((s) => s.pendingTranslationBrief);
```

(c) Change the `handleClickRef` declaration to:

```ts
  const handleClickRef = useRef<
    (modelOverride?: string, translationBrief?: string) => Promise<void>
  >(async () => {});
```

(d) Replace the whole `useCloudPurchase("run", async () => { … });` callback body, keeping the destructuring above it, with:

```ts
  } = useCloudPurchase("run", async () => {
    await refreshModelEnvironment();
    // A translation asks its questions first (TranslationQuestions); the job
    // is submitted from there, with the author's brief. Everything else runs
    // straight away — the author committed to this exact job by paying.
    if (useStore.getState().selectedModes.includes("translate")) {
      useStore.getState().setPendingTranslationBrief({
        questions: null,
        tone: "match",
        answers: {},
      });
      return;
    }
    await runPaid();
  });
```

Directly above the `const { … } = useCloudPurchase(` statement, add `runPaid`. Move the existing explanatory comment about the model selection into it:

```ts
  // Submit the paid job on Betty in the Cloud. She is bought one job at a
  // time, so she is the selected model for exactly one job. She used to stay
  // selected afterwards, and because the model selector is hidden outside
  // advanced mode, nothing said so: the next press of "Run Betty locally"
  // went to a cloud credential whose budget was already spent, and the run
  // died with "out of credit" on every chunk. Reported from a real install.
  // The selection goes back to whatever it was as soon as the job is
  // submitted.
  const runPaid = async (translationBrief?: string) => {
    const previousModel = useStore.getState().model;
    useStore.getState().setModel("custom:bethaniel-cloud");
    try {
      await handleClickRef.current("custom:bethaniel-cloud", translationBrief);
    } finally {
      if (previousModel && previousModel !== "custom:bethaniel-cloud") {
        useStore.getState().setModel(previousModel);
      }
    }
  };
```

(e) Change `const handleClick = async (modelOverride?: string) => {` to:

```ts
  const handleClick = async (modelOverride?: string, translationBrief?: string) => {
```

In its `addToQueue({ … })` call, add after `targetLang: …,`:

```ts
        translationBrief,
```

Directly after `useStore.getState().setPendingTaskIds(taskIds.taskIds);`, add:

```ts
      // The paid translation is on its way; its questions are answered.
      if (translationBrief !== undefined) {
        useStore.getState().setPendingTranslationBrief(null);
      }
```

(f) In the JSX, directly before `<CloudCheckoutModal`, add:

```tsx
      {pendingTranslationBrief && doc && (
        <TranslationQuestions
          lang={lang}
          units={units.map((u) => u.original)}
          targetLang={targetLang}
          manuscriptLang={manuscriptLang}
          onSubmit={runPaid}
        />
      )}
```

- [ ] **Step 5: Type-check**

Run (from the repo root): `npm run build:frontend 2>&1 | tail -5`
Expected: no TypeScript errors. If `useStore` or `targetLang` / `manuscriptLang` are read differently in `EditTrigger.tsx` (for example, destructured from one `useStore()` call), follow that pattern instead of adding a separate selector.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/TranslationQuestions.tsx frontend/src/components/EditTrigger.tsx frontend/src/i18n.ts frontend/src/styles/global.css
git commit -m "feat(translate): Betty asks her questions before a paid translation starts

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Document, build everything, and check it by hand

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Document**

In `CLAUDE.md`'s backend table, add a row after `translationUpgrade.ts`:

```markdown
| `translationBrief.ts` | Betty's questions before a paid translation. Candidates (names, invented words, honorifics, units, titles) are counted over the whole book with no LLM, capped at 40; the paid model gets those plus four excerpts and returns at most 5 multiple-choice questions in the author's interface language, each validated on its own (a `term` not in the book is dropped). `combineTranslationNotes` puts the resulting brief ahead of the style sheet in the translate task's `styleGuide`, which the draft, polish, fluency review and retries all read |
```

Under **Betty in the Cloud**, add a bullet after "The language card in the cloud":

```markdown
- **A translation asks first.** Claiming a translation's credential does not
  submit the job: `EditTrigger` sets the persisted `pendingTranslationBrief`
  and `TranslationQuestions` calls `POST /api/translate/brief/questions` on
  the paid credential (priced into the quote by `estimateTranslateMode`). The
  author answers the app's own tone question plus Betty's — all in the
  interface language — or skips, and `frontend/src/translationBrief.ts`
  renders the answers into the brief sent as `translationBrief`. Every
  failure is "no questions"; the run can always start.
```

- [ ] **Step 2: Full build and test**

Run (from the repo root): `npm run build:all 2>&1 | tail -5 && (cd backend && npm test 2>&1 | tail -8)`
Expected: all builds succeed, and the backend tests show `fail 0`.

- [ ] **Step 3: Check by hand**

1. Run `npm run dev`. Upload a short manuscript (e.g. one from `sample_texts/`), choose **Translate**, and set the interface language to Danish.
2. To see the questions without paying: with a saved `bethaniel-cloud` credential (or any `api` model configured), run `curl -s localhost:4000/api/translate/brief/questions -H 'Content-Type: application/json' -d '{"units":["<a few paragraphs with a recurring name>"],"targetLang":"French","manuscriptLang":"en","uiLang":"da"}'`. Confirm the questions come back in Danish, with `term`s exactly as written. With no credential, confirm the response is `{"questions":[],"degraded":true}`.
3. In the app, run the modal by setting `pendingTranslationBrief` from the dev console: `useStore.getState().setPendingTranslationBrief({questions:null,tone:"match",answers:{}})`. If the store isn't on `window`, temporarily trigger it from the claim path. Check that the reading state shows, then the questions. Check that "Other…" opens a field, the modal can't be dismissed, and its text is Danish. Reload, and confirm the panel comes back with the answers kept.
4. Report what was and wasn't checked. A full paid run is the one thing this step doesn't cover.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: the translation brief

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
