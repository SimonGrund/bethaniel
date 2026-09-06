# Task selection for v2.0: three cards, one intent, everything else in Beta

**Date:** 2026-09-06
**Status:** Approved, ready for implementation planning

## Context

The task step currently offers five category cards — editing (which expands
into developmental / line / copy), analysis, translation, feedback, and final
readthrough. Five categories and a nested three-way choice is a lot of surface
for a step whose real question is "what do you want done to your book?", and
the prominence order does not match the product: the three things Betty is
actually sold for are buried among experiments.

Betty in the Cloud can currently be paid for on exactly six modes
(`CLOUD_ALLOWED_MODES` in `backend/src/cloudEstimate.ts`): `copy_edit`,
`line_edit`, `combined_edit`, `proofread`, `publication_scan`, `translate`.
Those collapse to three user-facing choices — copy/line edit, final
readthrough, translate — because copy+line merge into `combined_edit` and
proofread+publication_scan are presented as one "Final readthrough".

So the front of the task step should be those three, and nothing else.

## Decisions taken

Made in dialogue on 2026-09-06; recorded because several were close calls.

1. **Three front cards, not two.** The original ask was two (edit, translate)
   with final readthrough demoted to Beta. Final readthrough is already
   payable and benchmarked, and selling a pass the UI files under "Beta" is
   incoherent. It stays out front. The alternative — dropping it from
   `CLOUD_ALLOWED_MODES` — was rejected as discarding a working revenue mode.

2. **The Edit card runs copy edit, with line edit as a visible opt-out.** The
   card means "copy edit at minimum"; a toggle beside it adds or removes the
   line pass. This matters because line edit is the weakest pass Betty has
   (11–34% recall, 20–50% precision across every model benchmarked), and a
   user who wants spelling fixed should not have to buy and wait for it.
   Copy edit cannot be switched off — that would leave the card meaning
   nothing.

3. **Beta is a disclosure, not a tab strip.** A two-tab strip makes the
   experimental drawer look like a co-equal half of the step and adds
   permanent chrome above the main path.

4. **Beta is grouped internally**, not a flat list. It holds four modes today
   and will grow.

5. **Cards have no inside.** Controls belonging to a card render below the
   card row, never within it. Translation already does this with its
   target-language picker; Edit's option checkboxes move to the same place.

## The screen

```
I want to…

┌─────────────────────┐ ┌─────────────────────┐ ┌─────────────────────┐
│ Edit my manuscript  │ │ Final readthrough   │ │ Translate my        │
│                     │ │                     │ │ manuscript          │
│ Copy and line edit  │ │ A last surface pass │ │ Into another        │
│                     │ │ before publishing   │ │ language            │
└─────────────────────┘ └─────────────────────┘ └─────────────────────┘

   [ controls for the selected card render here ]

▸ Experimental — less tested
```

### Cards

| Card | Selects | Notes |
|---|---|---|
| Edit my manuscript | `copy_edit`, plus `line_edit` unless toggled off | Backend merges both into `combined_edit` |
| Final readthrough | `proofread` + `publication_scan` | Always both; no partial selection |
| Translate my manuscript | `translate` | Target language picked below the row |

**Invariant:** the three front cards' modes are exactly `CLOUD_ALLOWED_MODES`
minus `combined_edit` (which the backend synthesises and no user selects).
The front of this screen is the paid product; if the two ever disagree, either
we are advertising something we will not sell or hiding something we would.

### Controls below the row

Rendered only for the selected card.

- **Edit** — a toggle, *"Also run a line edit"*, on by default. Off sets the
  selection to `["copy_edit"]`. Below it, the existing per-pass option
  checkboxes: copy-edit options always, line-edit options only while the
  toggle is on.
- **Final readthrough** — none.
- **Translate** — the existing target-language picker, unchanged.

### Beta disclosure

Collapsed by default. Labelled **"Experimental — less tested"** with one
sentence of explanation, not a bare "Beta": final readthrough is sold while
sitting conceptually beside these, and an unexplained "Beta" leaks doubt onto
passes that work.

Three groups:

- **Developmental edit** — `developmental_edit`. Exclusive; a whole-manuscript
  pass that cannot be combined with anything.
- **Analysis** — `character_catalog`, `location_catalog`, `timeline`.
  Combinable; the backend merges a multi-selection into `combined_analysis`.
- **Feedback** — `text_evaluator`.

`blurb` and `analysis_summary` are deliberately absent: they are not
user-selectable today either, only produced and displayed in results.

## Behaviour

**Selection is mutually exclusive** across cards and Beta groups, as it is
today. "I want to…" is one intent. Selecting anything in Beta clears the front
selection and vice versa.

**Default selection** changes from `["copy_edit"]` to
`["copy_edit", "line_edit"]`, so the first card is pre-selected and means what
its label says.

**Persisted state migration.** The store persists `selectedModes`, so existing
installs will hold selections made under the old UI. No migration code: the
Edit card lights up when *any* of copy/line is selected, and the line toggle
reflects whether `line_edit` is present. A user who had `["copy_edit"]` alone
sees the Edit card selected with the line toggle off — which is exactly right,
and needs no normalisation. Selections that no longer have a front card
(`developmental_edit`, analysis modes, `text_evaluator`) light up their Beta
group; the disclosure starts expanded when the current selection lives inside
it, so nobody's saved choice becomes invisible.

## Components and files

| File | Change |
|---|---|
| `frontend/src/components/ModeSelector.tsx` | Reduced from 590 lines to ~250: three cards, below-row controls, and the Beta disclosure's open/closed state |
| `frontend/src/components/BetaFeatures.tsx` | New. Owns the three Beta groups and their selection logic |
| `frontend/src/types.ts` | Mode groupings for front cards and Beta groups |
| `frontend/src/store.ts` | Default `selectedModes` |
| `frontend/src/i18n.ts` | New keys in all four languages (en/da/de/es) |
| `frontend/src/styles/global.css` | Card row, below-row control panel, disclosure |
| `backend/test/cloudModes.test.ts` | New. Pins `CLOUD_ALLOWED_MODES`; see Testing for what it can and cannot guard |

The split exists so the front card set cannot drift as Beta grows: one file
holds what we sell, another holds what we are still testing.

## i18n

Every new string needs en/da/de/es. New keys: three card titles and
descriptions, the line-edit toggle label, the Beta disclosure label and its
explanatory sentence, and the three Beta group names. Existing `mode_*` keys
are reused where the label is unchanged.

## Testing

The invariant worth pinning is that the three front cards are exactly the paid
product. It cannot be tested directly: the frontend has no test suite, and the
backend deliberately does not import frontend types — `cloudEstimate.test.ts`
already inlines `FINAL_READTHROUGH_MODES` with a comment for exactly this
reason. A backend test comparing `CLOUD_ALLOWED_MODES` against a hardcoded
copy of the card list would pass while the real UI drifted, which is worse
than no test because it reads like a guard.

So:

- **Backend test** (`backend/test/cloudModes.test.ts`): assert
  `CLOUD_ALLOWED_MODES` equals the expected six, with a comment naming the
  frontend constants it must stay in step with. This catches an unreviewed
  change to what is sellable — the half that costs money if it is wrong.
- **Frontend side**: a single exported constant in `types.ts` from which both
  the card list and the Beta list are derived, so the front cards cannot be
  edited without editing the thing the comment points at. A structural guard,
  not a test.

If the frontend gains a test runner later, the real assertion — card modes
equal `CLOUD_ALLOWED_MODES` minus `combined_edit` — belongs there. Noted
rather than faked.

## Out of scope

- Any repaint. Palette, type and spacing stay as they are; this is a structure
  change. Whether the rest of the app needs a visual pass is a separate
  decision to be taken after looking at this one running.
- Relocating the per-pass option checkboxes into Advanced settings. They move
  below the card row instead, which reuses an existing pattern and keeps them
  discoverable.

## Accepted trade-offs

- **Line edit is opt-out, not opt-in**, so most runs will include the weakest
  pass. Making it opt-in would improve average output quality and cut cloud
  cost, but hides a headline feature. The toggle is the compromise: on by
  default, one click to remove, visible rather than buried in Advanced.
- **Running line edit alone is no longer reachable from the UI.** The Edit
  card always includes copy edit. Still available via the API and CLI.
