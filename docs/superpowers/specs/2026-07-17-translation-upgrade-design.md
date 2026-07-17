# Translation Upgrade Pipeline — Design

**Date:** 2026-07-17
**Status:** Approved

## Problem

Translated output is accurate but reads like a translation — stiff phrasing,
source-language sentence rhythm, calqued idioms ("translationese"). The current
pipeline (translate → optional bilingual accuracy review with one re-translate
attempt per flagged paragraph) has no pass that asks "does this read as if it
were originally written in the target language?"

## Decisions

| Question | Decision |
|---|---|
| Primary quality gap | Translationese / stiff prose |
| Upgrade output UX | Automatic — polished text is the final result, no accept/dismiss UI |
| Review shape | Two reviews: bilingual accuracy after translation (existing), monolingual fluency after upgrade (new) |
| Gating | Always-on: the full pipeline **is** translate mode. Existing `reviewMode` gates both review loops; `reviewerCount`/`reviewerThreshold` apply to both |
| Architecture | Inline per chunk, inside the existing `mode === "translate"` branch |

## Pipeline (per ~2500-word chunk)

```
1. TRANSLATE       buildTranslationPrompt (unchanged)
2. ACCURACY LOOP   reviewMode only — today's code, unchanged:
                   bilingual reviewer × reviewerCount → min score per paragraph
                   → paragraphs below threshold re-translated once
   ── "draft" = accuracy-validated translation ──
3. UPGRADE         new monolingual target-language line-edit pass over the
                   whole draft chunk (whole chunk = context for rhythm/flow)
4. FLUENCY LOOP    reviewMode only — new reviewer scores each
                   (draft paragraph ↔ polished paragraph) pair 1–5 on:
                   • naturalness in the target language
                   • no meaning added/dropped/altered vs the draft
                   • binding glossary still honored
                   Flagged paragraphs: re-polished once FROM THE DRAFT
                   paragraph with the reviewer's reason injected; if the
                   re-polish fails or is empty, the draft paragraph is kept.
5. OUTPUT          restoreTypography → stripOverlapFromResponse → pieces
```

**Safety invariant:** the accuracy-validated draft is always the fallback.
Any failure in stages 3–4 degrades to exactly today's output, never worse.

## Prompts (`backend/src/prompts.ts`)

Two new builders; `buildTranslationPrompt` and the accuracy reviewer are unchanged.

### `buildTranslationUpgradePrompt(targetLang, styleGuide?)`

Role: native target-language line editor. "This text was translated into
${targetLang}; make it read as if originally written in ${targetLang}."

Constraints:
- Preserve meaning, content, and facts exactly — no additions, no omissions
- Preserve paragraph count and all Markdown structure
- Fix translationese: calqued idioms, source-language word order, stilted
  register, unnatural collocations
- Never alter glossary-bound terms/names
- Output only the edited Markdown, no commentary

Style sheet appended via the existing `buildStyleSheetBlock(styleGuide,
"translate")` so the binding glossary keeps binding.

### `buildFluencyReviewerPrompt(targetLang, styleGuide?)`

Mirrors the existing translation-reviewer prompt structure and emits the same
JSON lines (`{"index": n, "confidence": 1–5, "reason": "…"}`) so
`parseReviewScores` is reused unchanged. Receives (draft, polished) pairs —
both target-language, so any model capable of the upgrade pass can review it.
Scores on naturalness, meaning preservation vs the draft, and glossary
compliance.

## Module: `backend/src/translationUpgrade.ts`

`queue.ts` is ~1800 lines; the new stage lives in its own module. It exports:

- **Pure helpers** (unit-testable):
  - paragraph splitting/pairing for draft vs polished text
  - paragraph-count guard: polished paragraph count ≠ draft count → reject polish
  - length guard: polished text < ~60% of draft length → reject polish
- **Orchestrator** running stages 3–4, taking the chunk draft, prompts, and
  injected stream/reviewer functions (same dependency-injection style as the
  existing correction pipeline) plus `AbortSignal`. Returns the final chunk
  text and log-worthy events.

The translate branch in `queue.ts` calls the orchestrator after the existing
accuracy loop, then proceeds to `stripOverlapFromResponse` as today.

## Guardrails & error handling

- Paragraph-count mismatch or length-guard failure → discard polish, keep
  draft, log a warning (alignment is required for fluency pairing anyway).
- Exception in upgrade or fluency review → log warning, ship the draft; the
  existing chunk-level try/catch remains the outer net.
- `restoreTypography(draft, polished)` applied to upgrade output, matching the
  translate pass.
- Cancellation: `ac.signal` threaded through all new stream calls.
- Fluency reviewer output unparsable → polish accepted as-is (reviewer is
  advisory; the structural guards already passed).

## UI

No new wizard controls (flow is always-on and automatic). Changes:

- Two new task `phase` strings: `upgrading chunk X`, `reviewing fluency for
  chunk X` — flow through existing `updateTask` → Socket.IO → QueuePanel /
  BettyWorking plumbing.
- Log-bus messages mirror the current reviewer messages (flag counts,
  re-polish results, fallbacks).
- No `ReviewExport` changes; translation output remains final text.
- Note: translate tasks will take roughly 2× longer (4 passes vs 2 when
  reviewMode is on).

## Testing (backend `node:test`, existing style)

- Unit tests for the pure helpers: count guard (mismatch → draft), length
  guard, pairing.
- Orchestrator tests with stubbed stream/reviewer functions:
  - fluency flags → only flagged paragraphs replaced by re-polish
  - re-polish failure/empty → draft paragraph retained
  - reviewer returns garbage → polish accepted as-is
  - upgrade pass throws → draft shipped
- `parseReviewScores` reuse — already covered by existing tests.

## Out of scope

- Cross-chunk seam smoothing (paragraph overlap already covers continuity)
- A standalone "polish existing text" mode
- Quality-level (Fast/Standard/Thorough) wizard setting
- Frontend automated tests
