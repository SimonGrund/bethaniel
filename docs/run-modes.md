# Run modes: Speed / Max

Bethaniel bundles the advanced pipeline knobs (editor count, reviewer count,
style agent, thorough second pass) into two named **run modes**. A run mode
changes nothing in the pipeline itself — it only sets values `runCorrectionPass`
already reads. The deterministic checks (spell-check, retext, LanguageTool,
dialect) stay **on** in every mode because they are cheap, local, and catch most
mechanical errors.

The canonical tables live in `frontend/src/store.ts` (`RUN_MODE_PRESETS`) and
`backend/src/runModePresets.ts` — keep the two in sync.

## The presets

| Knob | Speed | Max |
|---|---|---|
| Base editors (`dualEditor`/`dualCount`) | **1** | **3** |
| Style-compliance agent | ✓ | ✓ |
| Reviewers (`reviewerCount`) | 1 | **2** |
| Thorough 2nd pass (`extraPass`) | — | **✓** |
| Deterministic checks | all on | all on |
| ~LLM calls / chunk | ~2 (3 w/ style guide) | ~4–8 |

The style-compliance agent only does work when a style guide is attached; it is a
no-op otherwise, in both modes.

A third **Balanced** preset (2 editors, no 2nd pass) was built and benchmarked,
then removed: it was dominated in every regime tested — on a weak local model it
applied no more than Speed, and on a strong API model it captured only a quarter
of Max's gain (the **2nd pass**, not the extra editors, drives Max's recall). See
the evidence below. The advanced sliders still reconstruct any in-between as
**Custom**.

## Defaults by model source

- **Local models** (`gguf` / `custom_gguf` / `ollama`) → **Speed**
- **External Betty** (`api`) → **Max**

Auto-selection happens on a genuine model *switch* in `useModelRuntime`; it never
clobbers a persisted "Custom" choice on app reopen or wizard navigation.
Hand-tuning any advanced knob flips the mode label to **Custom**. The advanced
sliders remain the source of truth and the escape hatch.

## Where the control appears

The run-mode slider (`RunModeSlider`, in the sidebar above the Run button) shows
**only for editing tasks** (`EDIT_MODES` — copy/line/proofread/translate/
combined). Analysis and report modes don't run the editor/reviewer/2nd-pass
pipeline the presets control, so the control is hidden for them.

Selecting **Max** on a **local** model with **weak hardware** (the machine can't
comfortably run big models, per `hardware.allowedTiers`) raises a confirmation
dialog first — Max is ~5× the work of Speed and a full book can take hours on a
constrained machine. External Betty is never gated (its throughput comes from the
provider, not local hardware).

## Why these defaults — benchmark evidence

Validated with the A/B harnesses in `backend/scripts/`
(`npm run bench:modes`, `npm run bench:chapters`). Each compares **auto-applied**
corrections between modes (flagged suggestions are surfaced for manual review in
*both* modes, so they measure candidate volume, not applied quality; degenerate
`original === corrected` no-ops are filtered out).

### Local model — Basic Betty (Qwen3.5-9B), one 8.5k-word chapter

| | Speed | Max |
|---|---|---|
| Wall-clock | **12.6 min** | 59.8 min |
| Applied corrections | 35 | 40 |
| Flagged | 82 | 202 |

Speed is **4.8× faster** and applies **essentially the same** corrections. The
per-fix differences are the *same* edits at different span granularity
(`grimmaced → grimaced`, `damnit → dammit`) — chunk-window and sampling variance,
not a quality gap. Max's extra compute went into 2.5× more *flagged* candidates,
much of it over-reach the reviewer correctly withheld (invented dialogue, risky
proper-noun edits like `Kindra's → Kinda's`).

A **Balanced** spot-check on the 9B (one ~2.6k-word chunk, run at `parallel 1`
for memory safety, vs Speed on the *same* chunk) points the same way — the second
editor buys nothing on a weak model:

| 1-chunk, 9B | Speed | Balanced |
|---|---|---|
| Applied | **9** | 6 |
| Flagged | 9 | 20 |
| Processing time | **155 s** | 328 s |

Balanced applied *fewer* (6 vs 9) while flagging 2× more and costing ~2× the
time — the extra editor produced divergent candidates the reviewer couldn't
confidently reconcile. (Small single-chunk counts, so read the direction, not the
exact numbers.)

**→ On a weak/local model the heavy pipeline buys noise, not applied quality.
Speed is the right default.**

### External Betty (DeepSeek) — full novel, 32 chapters, 84.7k words

| | Speed | Balanced | Max |
|---|---|---|---|
| Wall-clock (whole book) | 2.2 min | 2.5 min | **4.7 min** |
| Applied corrections | 375 | 418 | **555** |
| Flagged | 1,701 | 1,693 | 1,988 |

Per-chapter applied diff, Speed vs Max (32 samples): both **300**, Max-only
**255**, Speed-only **75**. **Speed reproduced only 54% of Max's applied
corrections.**

Balanced (2 editors, no 2nd pass) lands between, but tellingly: it adds only
**+43** applied over Speed, while Max adds **+137** over Balanced. So the second
editor contributes little — **most of Max's extra recall comes from the thorough
2nd pass** (`extraPass`), not from more editors or reviewers. On External Betty,
where wall-clock is cheap, that second pass is what earns the default.

Sampling the biggest-gap chapters, Max's extra applied corrections are
**genuine**, not over-editing:

- Real-word errors that spell-check *and* a single editor miss:
  `ping of pain → pang`, `working a mob → mop`, `dessert mountains → desert`,
  `lead them → led`, `the flow let → led`
- Comma correctness at scale: `afraid, that → afraid that`, `consider, if → consider if`
- Word choice: `recuperated → recovered`, `short laughter → short laugh`,
  `restricted himself → restrained himself`
- Dialogue-tag casing: `"…barracks," One fighter → one fighter`

**→ The value of the heavy pipeline scales with model strength.** A strong model
turns the extra editors and second pass into real recall (+48% applied
corrections), and the API's parallelism makes it nearly free — an entire novel in
4.7 minutes. Running External Betty in Speed would discard ~46% of catchable
corrections. Max is the right default.

## Takeaways

- **Speed's "minimal quality loss" holds on weaker/local models**, where the extra
  passes yield flagged noise rather than applied corrections — Balanced applied no
  more than Speed on the 9B, at ~2× the time.
- **On a strong model the heavier pipeline earns its keep**, and External Betty's
  throughput makes Max cheap in wall-clock.
- **The 2nd pass, not the extra editors, drives Max's recall.** On External Betty
  the second editor (Speed→Balanced) added only +43 applied; the thorough 2nd pass
  (Balanced→Max) added +137. Balanced is a modest middle, not half-way to Max.
- Neither mode is a strict superset of the other (Speed-only applied 75 the API
  Max didn't), but the 255-vs-75 asymmetry on External Betty is decisive.
- **Balanced was removed** on the strength of this evidence: dominated on both a
  weak local model (≤ Speed) and a strong API model (¼ of Max's gain). Only the
  two endpoints — Speed and Max — are worth surfacing; the sliders cover the rest
  as Custom.

## Reproducing

```bash
# single chapter/manuscript, Speed vs Max
npm run bench:modes -- --doc <path> --model <fileName>

# per-chapter across a whole book (many samples), .docx or .md
npm run bench:chapters -- --doc "<path/Original.docx>" --model custom:deepseek-chat --parallel 8
```

Both scripts are HTTP clients that drive a running backend exactly as the app
does — start the app (or the backend) with the target model available first.
`--limit N` caps chapters (a safety valve for paid APIs).
