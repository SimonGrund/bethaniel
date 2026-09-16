# Fewer choices on the setup screen

**Date:** 2026-09-16
**Status:** approved, implementing

## The problem

The setup screen asks the author more than it needs to. The Edit card opens a
dialog of fifteen checkboxes nobody has a reason to change; the Translate card
hides its one real question — where to — behind that same dialog; and the
manuscript column lays Scope and the detected settings out full-height, so the
two things that matter (what was found, what needs confirming) compete with a
wall of radio buttons.

## What we are building

**The task column**

- The Edit card's settings disappear. Every Edit run is copy + line edit with
  all options at their defaults.
- "Translate my manuscript" becomes **"Translate Manuscript"**, and its target
  language becomes a dropdown inside the card itself.
- `TaskSettings` — the Settings button under the cards — is deleted. With the
  Edit card's settings hidden and Translate's moved into the card, nothing is
  left: readthrough and language already rendered nothing, and the style sheet
  is already offered on the manuscript column.

**The manuscript column** — three uniform rows, one flag vocabulary:

```
●  Scope                 Whole book · 80,717 words · 32 chapters
▲  Manuscript format     1 thing to confirm
●  Style guide           12 terms protected
```

## Decisions

### The Edit card gives no choice

`selectCard("edit")` selects `["copy_edit", "line_edit"]` unconditionally.
`lineEditEnabled` stays in the store, unread, so the preference survives if the
toggle is ever restored.

**This changes behaviour:** an author who had turned the line pass off will
start getting line edits again. That is what "no choice" means here, and it is
deliberate.

### The target language is a dropdown with an escape

Ten publishing languages — Danish, Dutch, English, French, German, Italian,
Norwegian, Portuguese, Spanish, Swedish — then a separator, then "Other…",
which reveals the existing free-text input.

`targetLang` remains a free-text string in the store and nothing downstream
changes; the dropdown only writes to it. This matters because the backend
interpolates it straight into the prompt (`Translate the following text into
${targetLang}` — prompts.ts), so any language works today and a fixed list
would quietly remove that.

The card's own click handler must not swallow the select's clicks:
`onClick={(e) => e.stopPropagation()}` on the select.

The orange flag for "translation with no target", which lived on
`TaskSettings`, moves onto the Translate card, where the control now is.

### FoldingPanel is the component, not a new one

Three container patterns already exist: `FoldingPanel` (inline collapse, takes
`status` and `demandsAttention`), `task-settings-cta` + Modal, and
`styleguide-cta` + Modal — the last two with different mark vocabularies
(`●`/`▲` against `✓`/`★`).

`FoldingPanel` already has exactly the green/orange concept, so:

- **Scope** is wrapped in `FoldingPanel`. Title `sec_scope`; summary from the
  `units`/`totalWords` it already computes. Status always `clean` — scope has
  a valid default and cannot be waiting on anyone. Collapsed by default.
- **Manuscript format** is `ManuscriptSettings` retitled
  (`ms_settings_title` → "Manuscript format", four languages). Its flag logic
  is untouched: `attention` when a detected setting is `unsure` and unsettled.
- **Style guide** keeps its modal — the sheet editor plus `LexiconPanel` is far
  too tall to fold inline — but adopts the same marks: `▲` when
  `lexiconPending` (terms found, `reviewedAt` unset), `●` otherwise.

An empty style sheet with nothing pending is **green**, not orange: an optional
thing is not waiting on anyone. The "Recommended" hint still says so in words.

## Tests

The frontend has no test runner, so what gets tested is what is pure:

- `scopeSummary()` extracted from `ScopeSelection` and tested from
  `backend/test/`, as `codeBalanceNote` already is — whole book, selected
  chapters, first-N-words, and the no-chapters case.
- `TRANSLATION_LANGUAGES` pinned: the list is non-empty, sorted, free of
  duplicates, and carries the "other" sentinel.
- The existing i18n guard covers the renamed keys.

Flag logic (`SettingsStatus`, `attentionCount`, `lexiconPending`) is existing
behaviour and is not being changed, so it gets no new tests.

## Not doing

Touching `SettingsStatus`/`attentionCount` logic, restyling the cards beyond
the flags, moving the style guide off the manuscript column, or extracting a
new shared CTA component.
