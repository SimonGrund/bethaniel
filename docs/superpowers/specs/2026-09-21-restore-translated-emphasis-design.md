# Restoring emphasis to a translated paragraph

**Date:** 2026-09-21
**Status:** approved, not yet implemented

## Why

A translation replaces a whole paragraph, so the export gives up any emphasis
*inside* it: an italic phrase, a highlighted word. On the manuscript this was
found on, that is 109 paragraphs. The author is told, and a sidecar lists what
was lost (`formattingNotes.ts`), but the emphasis itself is gone and must be
restored by hand.

The request was for a second pass that reads those notes and re-italicises the
corresponding French. **That pass is unnecessary: the translation already
carries the answer.**

### The information is already there, and the export discards it

The text sent to the model is Markdown, emphasis markers included, and the
model preserves them. Measured across a 13-chapter French translation:

| | |
|---|---|
| chapters where source and output asterisk counts match | **13 of 13** |
| paragraphs with emphasis in the English | 265 |
| …where the French has the **same number of spans** | **264** |
| …where it differs | **1** (two spans merged into one) |
| total spans | 304 English → 303 French |

And the markers wrap the French, correctly:

```
**Chapitre 1 : Pourquoi questionner la monogamie ?**
**La mononormativité transforme l'amour en honte et en culpabilité**
_— un·e enquêté·e_
```

So the model has already decided which French words carry the emphasis. The
export throws that away: `stripMarkdown` removes the markers before the text
reaches Word, because `docxSurgery` can only replace text *inside* an existing
run and has no way to make one italic.

A second LLM pass would re-derive, at cost and less accurately, something we
are already being handed for free.

## The insight that makes this cheap

A flattened paragraph **already contains the runs we need**. It is flattened
*precisely because* it has more than one formatting — a plain run and an
italic one. Today the whole translation is dumped into the first run and the
rest are blanked. Instead it can be **distributed**: the plain French into the
plain runs, the emphasised French into the emphasised run.

No new XML. No new nodes. The same splice machinery, allocating differently.
Nothing that can malform the document.

Real structure, from the manuscript:

```
para 63: 3 runs -> 3 segments
   "I will be honest with you: this book both contains expl…"
   "love multiplies"                                            <- differs
   "."
```

And the matching French markdown is three pieces in the same shape.

Because the emphasised text goes into **the author's own italic run**, it keeps
their font, size and highlight — not a generic `<w:i/>`. The "copy the source's
own emphasis" requirement is satisfied by construction rather than by copying
`rPr` around.

## Decisions

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Where to apply | Only paragraphs already flattened | Every translated paragraph — rebuilds runs in paragraphs working fine today. Only-where-source-had-emphasis — that is the same set, since flattening *is* the source having emphasis. |
| Which formatting | The source paragraph's own run | Plain `<w:i/>`/`<w:b/>` — loses a highlight or a coloured emphasis. Ask per document — a question about run properties no author can answer. |
| Rollout | Silent when it works; report only what it could not do | "N restored" — the author did not lose anything, so there is nothing to tell them. A toggle — the default would stay the lossy one. |
| Second LLM pass | **Not built** | Costs money and accuracy to re-derive what the translation already states. |

## Architecture

### 1. Segments, on both sides

**Docx side.** Collapse consecutive runs sharing an `rPrXml` into segments.
`p.nodes` is in document order, so this is a single fold. A paragraph reads
outer / emphasised / outer = 3 segments.

**Markdown side.** Parse the translated paragraph's Markdown into the same
shape: a list of `{ text, emphasised }` pieces, splitting on `**…**`, `*…*`,
`__…__`, `_…_`. The markers are available at the point this is decided —
`remapChaptersToParagraphEdits` holds the raw `newMd` and only then calls
`stripMarkdown` on it.

### 2. The shape check

Distribute **only** when the two agree:

- the same number of segments;
- in the same order of emphasised-ness (segment 2 emphasised ⇔ piece 2 emphasised);
- every piece non-empty.

Anything less certain falls back. **This strictness is the whole safety
argument**: the failure mode of a loose match is putting French text into the
wrong run — italicising the wrong phrase — which is worse than losing the
emphasis. Losing it is what already happens, so a fallback costs nothing.

### 3. The edit

A whole-paragraph replacement gains an optional richer form: instead of one
`replacement` string, a list of `{ segmentIndex, text }`. `planParagraphSplices`
already maps node → pending text, so each segment's runs receive their own
text rather than the first taking everything.

When the shape check fails, the edit is exactly what it is today.

### 4. What the author is told

Nothing when it works.

When it does not, one line on the export, with the count of **phrases** (not
paragraphs — a paragraph may hold two):

> "3 emphasised phrases could not be placed in the translation without
> ambiguity. The formatting notes say where they were."

The formatting-notes sidecar then lists **only** those paragraphs, rather than
all 109 — it becomes a short list of real problems instead of a long list of
things that are now fine.

## Expected outcome

On the reporting manuscript: ~108 of 109 flattened paragraphs get their
emphasis back silently, and roughly one is reported. The sidecar shrinks from
109 entries to about one.

## Testing

| Covered by tests | Verified by hand |
|---|---|
| Segment folding: consecutive same-format runs collapse; virtual nodes ignored | The exported .docx opens in Word |
| Markdown split into pieces: `**`, `*`, `__`, `_`, nested and adjacent | The italics land on the right French words |
| Shape check: accepts a true match; rejects differing counts, differing order, an empty piece | |
| Distribution: each segment's text reaches its own runs | |
| Fallback is byte-identical to today's behaviour when the check fails | |
| The report counts phrases, not paragraphs | |

The end-to-end number — how many of the 109 are restored — is measurable
against the real manuscript already on this machine, and should be checked
before merging.

## Risks

- **Wrong-run placement.** Mitigated by the strict shape check, and pinned by a
  test that a mismatch falls back rather than guesses.
- **A paragraph whose runs Word split for its own reasons** (spell-check,
  language tags) can show more segments than the Markdown has pieces. The fold
  by `rPrXml` handles the common case — those splits usually share formatting —
  and the shape check catches the rest.
- **Nested emphasis** (`***bold italic***`) yields one piece, not two. It maps
  to one segment, which is correct; but a source that split it across two runs
  will fail the shape check and fall back. Acceptable.

## Out of scope

- A second LLM pass to align emphasis. Explicitly rejected above.
- Emphasis in paragraphs that are **not** flattened — those already export
  correctly.
- Restoring anything other than character formatting: comments, footnotes and
  tracked changes are untouched, as now.
