# House-style questions before an edit

## Goal

Before a copy edit, line edit or Final readthrough, Betty asks a few
questions where the manuscript disagrees with itself (*grey* 14× / *gray*
3×, *e-mail* / *email*, *ten* / *10*, two dash styles), and about settings
detection could not decide. The answers become house style: settings that
have a control are set, the rest are written into the style guide, so the
edit stops "correcting" deliberate choices and later runs ask less.

## Decisions

- **When.** After the author presses Run (local) or Run in Cloud, before
  anything starts. For a cloud run that is BEFORE the checkout: nothing here
  needs a model, so the author settles house style before paying.
- **No model.** Every question is counted from the manuscript, instantly
  and for free.
- **Where answers go.** Dialect, Oxford comma, Danish comma and quote style
  set their existing controls (`copyEditOptions`). Everything else becomes a
  line in the style guide under a "House style" heading. A last card shows
  the lines, editable, before the run starts. The style guide is saved.
- **Asked once.** A question whose answer the style guide already holds, or
  a setting detection is sure of (or the author changed by hand), is not
  asked. Nothing left to ask → no card at all; Run behaves as today.
- **Modes.** copy_edit, line_edit, combined_edit, proofread. Not translate
  (it has its own questions) and not the analysis modes.
- **At most 5 questions**, settings first, then by how often the conflict
  occurs.
- **Language.** All text is the app's own (i18n), in the interface
  language; the style-guide lines too.

## Questions

Computed by `backend/src/houseStyle.ts` (pure, tested) from the scope's
text, the manuscript language and the style guide:

| kind | detects | asked when |
|---|---|---|
| `spelling` | British/American pairs (`VARIANT_PAIRS` from consistency.ts), English only | both forms used, 3+ in all |
| `compound` | a hyphenated word and its closed or open form (*e-mail* / *email* / *e mail*) | 2+ forms used, 3+ in all |
| `numbers` | numbers under 100 as digits vs words (en, da, de, es, fr word lists); years, times, decimals, percentages and "chapter 3" excluded | 3+ of each |
| `dashes` | spaced en dash ( – ), unspaced em dash (—), spaced em dash ( — ) | 2+ styles with 2+ each |

Each returns `{ id, kind, forms: [{ form, count }] }`, most frequent form
first. Skipped when the style guide (case-insensitive) mentions one of the
forms (spelling, compound) or the topic (numbers: number/tal/zahl/número/
nombre; dashes: dash/tankestreg/strich/raya/tiret).

Setting questions are built in the frontend from `doc.detected`: a setting
whose detection is `unsure` and whose option still has its default value.

## Flow (frontend)

`EditQuestions.tsx`, the dark one-card-at-a-time screen of the translation
questions (same `tq` styles and keys: 1–n, Enter, ←, Esc closes and starts
nothing). Each card offers the forms with their counts, plus "Leave it
mixed". The last card lists the style-guide lines (editable) and starts the
run; "skip" starts it unchanged.

`EditTrigger`: `onRunButtonClick` and `handleRunInCloud` first ask
`POST /api/edits/house-style`; with questions, the screen opens and its
finish continues to `handleClick` (local) or the checkout confirmation
(cloud).

## Tests

- houseStyle.ts: each kind detected and skipped correctly; the style guide
  suppresses a settled question; years/times/chapter numbers are not
  numbers; the cap and order.
- frontend `houseStyleAnswers.ts` (pure): answers → option changes and
  style-guide lines, merged into an existing guide under one heading.
