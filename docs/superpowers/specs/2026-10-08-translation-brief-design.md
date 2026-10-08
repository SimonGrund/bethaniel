# Translation brief: Betty asks before she translates

## Goal

After an author pays for a cloud translation, the paid model reads the
manuscript and asks a few questions that decide how it should be translated
(keep or translate names and invented terms, tone: match / softer /
stricter-and-shorter). The answers become a **translation brief** that binds
every stage of the translation. The whole exchange is in the author's
interface language.

## Decisions already made

- **When:** after payment, before the job is submitted. Payment comes back
  → questions → the job starts.
- **Style guide:** the brief is *added to* the author's style guide, not a
  replacement for it. Where they disagree, the brief wins, because it is the
  newer, translation-specific choice.
- **Questions:** one fixed tone question, always asked, plus 2–5 questions the
  model finds in this manuscript. Every question is multiple choice with
  Betty's suggestion pre-selected, plus free text ("Other…").
- **Scan:** approach A. Candidates are collected from the full manuscript by
  code (no LLM). The model gets only the candidate list and a few excerpts.
- **Language:** questions, options, suggestions and explanations are in the
  interface language (`store.lang`: en, da, de, es). The fixed tone question
  comes from `i18n.ts`, not from the model.

## Flow

1. `useCloudPurchase("run", …)` claims the credential. When the selected modes
   include `translate`, `EditTrigger` no longer submits straight away. It sets
   `pendingTranslationBrief = { status: "asking" }` in the store and shows
   `TranslationQuestions`.
2. The panel calls `POST /api/translate/brief/questions` with
   `{ units: string[] (the selected units' text, exactly as the queue
   submission builds it), targetLang, manuscriptLang, uiLang }`. A spinner says Betty is reading the book.
3. The backend:
   - runs `collectBriefCandidates(text, manuscriptLang)` (deterministic);
   - sends one chat call on the `bethaniel-cloud` entry with
     `buildBriefQuestionsPrompt(...)`, using JSON mode where supported;
   - runs `parseBriefQuestions(raw)` to validate it. On a parse failure it
     retries once with a fresh seed, then returns no model questions;
   - returns `{ questions: BriefQuestion[] }`. The tone question is not in
     this list; the frontend adds it.
4. The author answers. **Start translation** and **Skip, use Betty's
   judgement** both submit. Skip uses the pre-selected suggestions.
5. `renderTranslationBrief(answers)` (pure, frontend-side so it is shared with
   the submission) builds the brief text. `/queue/add` receives it as
   `translationBrief`. The store's pending state is cleared once the job is
   accepted.

If the questions call fails outright (network, 402, engine), the panel says
so and shows only the tone question. The author is never stuck: the job can
always start.

## Candidate collection (`backend/src/translationBrief.ts`)

`collectBriefCandidates(text, lang)` returns `BriefCandidate[]`:

```ts
interface BriefCandidate {
  term: string;
  kind: "name" | "invented" | "honorific" | "unit" | "title";
  count: number;
  example: string; // one sentence containing it, trimmed to ~200 chars
}
```

- **name:** a capitalised single word seen at least 3 times not at the start
  of a sentence (`isSentenceInitial` from `spellcheck.ts`). In German, where
  every noun is capitalised, it must also be unknown to the dictionary, and
  without a dictionary German gets no name candidates.
- **invented:** a word Hunspell (`spellcheck.ts`) rejects, seen at least 3
  times, that is not a name.
- **honorific:** a per-language list (Mr/Mrs/Dr/Sir/Lady…, Hr./Fru…,
  Herr/Frau…, Señor/Doña…) seen at least once.
- **unit:** imperial or metric units (miles, feet, pounds, °F…), counted.
- **title:** text in italics or quotation marks that looks like a work title.

The list is ranked by count and capped at 40 candidates, so the prompt stays a
fixed size whatever the book's length. Pure and fully tested.

## The questions prompt

The prompt goes in `prompts.ts` (`buildBriefQuestionsPrompt`). The model gets:

- the source and target language, and the interface language it must write
  in (by name, e.g. "Danish");
- the candidate list as JSON;
- four excerpts of about 300 words each, spread over the book, for tone and
  register;
- the rules: ask at most 5 questions, only about real decisions a translator
  would otherwise guess at, never about grammar; each question has 2–4
  options and one `suggested` option; give a one-sentence `why`.

It answers with JSON:

```ts
interface BriefQuestion {
  id: string;          // stable within the response
  term?: string;       // the source term, verbatim, if the question is about one
  question: string;    // in uiLang
  options: { id: string; label: string }[]; // labels in uiLang; 2–4
  suggested: string;   // an option id
  why: string;         // in uiLang
}
```

`parseBriefQuestions` drops malformed questions one by one rather than all of
them: a missing `suggested`, under 2 options, more than 4, duplicate ids.
`term` must appear verbatim in the manuscript, or it is dropped (no
invented names). The list is cut to 5.

## The brief

`renderTranslationBrief` produces plain English instructions (the prompts are
English), quoting source terms and any free-text answers verbatim:

```
TRANSLATION BRIEF (the author's answers — these override the style sheet):
- Tone: stricter and shorter than the original — tighten, do not add.
- "Kragehøj": keep as is (place name).
- "the Hollow": translate (suggested: "Hulningen").
- Honorifics: keep "Mr"/"Mrs" untranslated.
```

The tone options and how each renders:
- **match:** keep the original's register (today's default; no extra line);
- **softer:** gentler and warmer, without losing meaning;
- **stricter:** tighter and shorter, cutting padding but never content.

## Where the brief is used

In `/queue/add`, a translate task's notes become
`combineTranslationNotes(brief, authorStyleGuide)`: the brief first, then the
style guide, rendered under the existing binding "GLOSSARY & TRANSLATION
NOTES" heading. That one string is the task's `styleGuide`, and every
translation stage already reads `job.styleGuide`: the draft
(`buildTranslationPrompt`), the polish (`buildTranslationUpgradePrompt`,
`queue.ts`) and the fluency reviewer (`buildFluencyReviewerPrompt`). The
task's `retrySpec` carries it too, so a retried chunk uses the same brief. No
prompt builder changes.

`/queue/add` accepts `translationBrief` only for translate tasks, and at most
4,000 characters.

## Cost

`estimateCloudJob` adds a fixed allowance for one questions call (prompt
about 3.5k tokens of system prompt, candidates and excerpts, about 1k output, ×2 for
the retry) when the product is `translate`. Tested in `cloudEstimate.test.ts`.
No Worker change: the call is an ordinary `/v1/chat/completions` on the
translate credential, routed and metered as now.

## Persistence and failure

- `pendingTranslationBrief` (questions, tone, answers) is persisted in the
  Zustand store. If the app closes mid-questions, the panel reopens on the run
  step once the manuscript is loaded again, with the answers kept and the
  paid credential still saved. (Document text is not persisted, so the panel
  cannot submit before then.)
- The brief never enters `cloudFailureReport.ts` (closed enums only).
- `uiLang` is not one of en/da/de/es → fall back to English.

## UI (`frontend/src/components/TranslationQuestions.tsx`)

The panel follows the existing parchment design language. Heading: "Before
Betty translates". The tone question comes first, then the model's questions,
each as a radio group with the suggestion marked "Betty suggests" and its
`why` beneath. "Other…" opens a one-line text field. Buttons: Start
translation (primary), Skip (secondary). All fixed strings are added to
`i18n.ts` in en, da, de and es.

## Tests (`backend/test/translationBrief.test.ts` and siblings)

- candidate collection: names at sentence start are not counted; invented
  words need Hunspell rejection; the cap and ranking; each kind;
- `parseBriefQuestions`: valid JSON; JSON inside code fences; per-question
  dropping; a `term` not in the manuscript is dropped; more than 5 is cut;
- `renderTranslationBrief`: each tone; verbatim free text; nothing answered
  gives an empty brief;
- `combineTranslationNotes`: ordering and override wording; empty inputs;
- the questions runner: valid first answer, retry on bad JSON, empty after
  two bad answers;
- estimate: translate includes the questions allowance; edit does not.

## Out of scope

- Asking questions before payment, or for local runs (translation is
  cloud-only).
- Editing the brief after the job starts.
- Saving briefs across books.
