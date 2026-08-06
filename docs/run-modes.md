# Run modes: Speed / Balanced / Max

Bethaniel bundles the advanced pipeline knobs (editor count, reviewer count,
style agent, thorough second pass) into three named **run modes**. A run mode
changes nothing in the pipeline itself — it only sets values `runCorrectionPass`
already reads. The deterministic checks (spell-check, retext, LanguageTool,
dialect) stay **on** in every mode because they are cheap, local, and catch most
mechanical errors.

The canonical tables live in `frontend/src/store.ts` (`RUN_MODE_PRESETS`) and
`backend/src/runModePresets.ts` — keep the two in sync.

## The presets

| Knob | Speed | Balanced | Max |
|---|---|---|---|
| Base editors (`dualEditor`/`dualCount`) | **1** | 2 | **3** |
| Style-compliance agent | ✓ | ✓ | ✓ |
| Reviewers (`reviewerCount`) | 1 | 1 | **2** |
| Thorough 2nd pass (`extraPass`) | — | — | **✓** |
| Deterministic checks | all on | all on | all on |
| ~LLM calls / chunk | ~2 (3 w/ style guide) | ~3–4 | ~4–8 |

The style-compliance agent only does work when a style guide is attached; it is a
no-op otherwise, in every mode.

## Defaults by model source

- **Local models** (`gguf` / `custom_gguf` / `ollama`) → **Speed**
- **External Betty** (`api`) → **Max**

Auto-selection happens on a genuine model *switch* in `ModelSelector`; it never
clobbers a persisted "Custom" choice on app reopen or wizard navigation.
Hand-tuning any advanced knob flips the mode label to **Custom**. The advanced
sliders remain the source of truth and the escape hatch.

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

**→ On a weak/local model the heavy pipeline buys noise, not applied quality.
Speed is the right default.**

### External Betty (DeepSeek) — full novel, 32 chapters, 84.7k words

| | Speed | Max |
|---|---|---|
| Wall-clock (whole book) | 2.2 min | **4.7 min** |
| Applied corrections | 375 | **555** |
| Flagged | 1,701 | 1,988 |
| Compute time | 13.1 min | 28.9 min |

Per-chapter applied diff (32 samples): both **300**, Max-only **255**, Speed-only
**75**. **Speed reproduced only 54% of Max's applied corrections.**

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
  passes yield flagged noise rather than applied corrections.
- **On a strong model the heavier pipeline earns its keep**, and External Betty's
  throughput makes Max cheap in wall-clock.
- Neither mode is a strict superset of the other (Speed-only applied 75 the API
  Max didn't), but the 255-vs-75 asymmetry on External Betty is decisive.
- **Balanced** (2 editors, 1 reviewer, no 2nd pass) is the untested middle for
  users who want more local recall without the full Max cost.

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
