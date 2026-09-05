# Run mode: Speed (the only mode)

Bethaniel used to offer a **Speed / Max** choice bundling the advanced pipeline
knobs (editor count, reviewer count, style agent, thorough second pass) into
two named run modes. As of this doc, **Max has been removed** — every model,
local or API, always runs the Speed knobs. This page keeps the benchmark
evidence for both decisions (why Speed was already the local default, and why
Max was cut everywhere including External Betty) since the reasoning isn't
obvious from the code alone.

The canonical preset table lives in `frontend/src/store.ts`
(`RUN_MODE_PRESETS`) and `backend/src/runModePresets.ts` — keep the two in
sync. `RunMode` is now `"speed" | "custom"`: "custom" still exists because a
user can hand-tune an individual knob (dual editor, reviewer count, extra
pass, …) in the model's advanced settings panel — that escape hatch was not
removed, only the named Max preset and the Speed/Max picker in the sidebar.

## The one preset

| Knob | Speed |
|---|---|
| Base editors (`dualEditor`/`dualCount`) | 1 |
| Style-compliance agent | ✓ (no-op without a style guide) |
| Reviewers (`reviewerCount`) | 1 |
| Thorough 2nd pass (`extraPass`) | — |
| Deterministic checks (spell/retext/LanguageTool/dialect) | all on |
| ~LLM calls / chunk | ~2 (3 w/ style guide) |

Applies uniformly — local models and External Betty alike. Deterministic
checks stay on regardless: they're cheap, local, and catch most mechanical
errors.

## Why Max existed, and why it was removed anyway

A **Balanced** middle preset (2 editors, no 2nd pass) and a **Max** preset (3
editors + 2 reviewers + a thorough 2nd pass) were both built, benchmarked, and
eventually removed.

**Balanced** was cut first: dominated in every regime tested — on a weak local
model it applied no more than Speed, and on a strong API model it captured
only a quarter of Max's gain. See the tables below.

**Max** was cut later, for a different reason. It held up decisively on a
strong API model (External Betty) — but bought nothing on either bundled local
model. Rather than keep a heavy preset that only pays off for one model
source, and a picker whose "right" answer silently depended on which model you
picked, it was removed everywhere for one predictable pipeline. **This is a
deliberate quality tradeoff on External Betty**, not an oversight: the
evidence below shows Max catching real corrections Speed misses on a strong
model, and running External Betty on Speed now gives that up. See "Takeaways"
for the reasoning.

### Local models — Baby Betty (4B) & Big Bad Betty (9B), copy_edit + line_edit

Ground-truth benchmark (`scripts/bench-run-modes.ts`), scored against planted
errors rather than an applied-corrections diff — a recall/precision read, plus
a clean-text false-positive check per mode:

| Model | Task | Speed recall | Max recall | Wall-clock |
|---|---|---|---|---|
| Baby Betty (4B) | copy_edit (stress100, 100 planted errors) | 60% | 61% | 3.1× slower |
| Baby Betty (4B) | line_edit | 20% | 20% | 2.0× slower |
| Big Bad Betty (9B) | copy_edit (stress100, 100 planted errors) | 59% | 59% | 3.2× slower |
| Big Bad Betty (9B) | line_edit | 11% | 11% | 2.6× slower |

Every recall/precision/F1 number is identical or within noise (+1pt at most).
Hallucinated false positives on already-clean text are unchanged (0 for
copy_edit in both modes on both models). For Big Bad Betty's line_edit, Max
produced the *exact same* correction set as Speed — the extra editors,
reviewer, and 2nd pass bought literally nothing, just 2.6× the wall-clock.
Full detail: `sample_texts/run_mode_bench_results.txt`.

An earlier applied-corrections A/B (now superseded by the ground-truth run
above, but kept for context) found the same direction on the 9B, one 8.5k-word
chapter:

| | Speed | Max |
|---|---|---|
| Wall-clock | **12.6 min** | 59.8 min |
| Applied corrections | 35 | 40 |
| Flagged | 82 | 202 |

Speed was 4.8× faster and applied essentially the same corrections; Max's
extra compute went mostly into flagged candidates the reviewer correctly
withheld (invented dialogue, risky proper-noun edits like `Kindra's →
Kinda's`). A **Balanced** spot-check on the same model pointed the same way —
the second editor bought nothing, it just produced divergent candidates the
reviewer couldn't confidently reconcile (6 applied vs Speed's 9, at 2× the
time).

**→ On both local models, for both copy_edit and line_edit, Speed is the
right choice. There is no local regime where Max wins.**

### External Betty (DeepSeek) — full novel, 32 chapters, 84.7k words

| | Speed | Balanced | Max |
|---|---|---|---|
| Wall-clock (whole book) | 2.2 min | 2.5 min | **4.7 min** |
| Applied corrections | 375 | 418 | **555** |
| Flagged | 1,701 | 1,693 | 1,988 |

Per-chapter applied diff, Speed vs Max (32 samples): both **300**, Max-only
**255**, Speed-only **75**. Speed reproduced only 54% of Max's applied
corrections. The second editor (Speed→Balanced) added only +43 applied;
the thorough 2nd pass (Balanced→Max) added +137 — **the 2nd pass, not the
extra editors, drove nearly all of Max's recall gain.**

Sampling the biggest-gap chapters, Max's extra applied corrections were
genuine, not over-editing:

- Real-word errors that spell-check *and* a single editor miss:
  `ping of pain → pang`, `working a mob → mop`, `dessert mountains → desert`,
  `lead them → led`, `the flow let → led`
- Comma correctness at scale: `afraid, that → afraid that`, `consider, if → consider if`
- Word choice: `recuperated → recovered`, `short laughter → short laugh`,
  `restricted himself → restrained himself`
- Dialogue-tag casing: `"…barracks," One fighter → one fighter`

**→ On a strong model, the heavier pipeline earned real recall (+48% applied
corrections) at a wall-clock cost the API's parallelism made nearly free — an
entire novel in 4.7 minutes.**

## Takeaways

- **Speed is the right default on local models, full stop.** Neither copy_edit
  nor line_edit showed any recall/precision benefit from Max on Baby Betty or
  Big Bad Betty — the ground-truth benchmark found the two modes
  statistically indistinguishable, at 2-3× the wall-clock.
- **Max genuinely helped on a strong API model.** External Betty in Speed
  discards roughly 46% of the corrections Max would have caught, per the
  32-chapter novel benchmark above. That's real, not noise.
- **Max was removed anyway, including for External Betty.** One pipeline is
  simpler to reason about, test, and support than a per-model-source default
  that quietly changes what "quality" means depending on which model a user
  picked. The tradeoff is real and intentional: External Betty users get a
  faster, less thorough pipeline than before. If quality complaints surface
  specifically for External Betty, this doc is where to look first — the
  fix isn't "add Max back for local models," it's a targeted reconsideration
  for API models only.
- The advanced settings panel (per-model, in the model step) still exposes
  every knob Max used to bundle (`dualEditor`, `reviewerCount`, `extraPass`,
  …) individually — a user or a future preset can still reconstruct something
  Max-shaped by hand. What's gone is the named preset and the sidebar picker,
  not the underlying capability.

## Reproducing

```bash
# local models, copy_edit + line_edit, Speed vs Max — ground truth scoring
npx tsx scripts/bench-run-modes.ts

# narrow to one model or one task mode
npx tsx scripts/bench-run-modes.ts --model 4b --task line_edit
```

HTTP client — drives a running backend exactly as the app does. Start the app
(or `npm run dev` in `backend/`) with both `Qwen3.5-4B-Q4_K_M.gguf` and
`Qwen3.5-9B-Q4_K_M.gguf` installed first. Results land in
`sample_texts/run_mode_bench_results.{json,txt}`.

The older applied-corrections A/B harnesses (`backend/scripts/bench-modes.ts`,
`bench-chapters.ts`, `npm run bench:modes`/`bench:chapters`) that produced the
External Betty table above have been removed along with the Max preset they
existed to compare against — their raw results are preserved in this doc.
