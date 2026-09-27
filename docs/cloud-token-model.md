# Cloud tokens per pass — measured

What a Betty in the Cloud job actually costs in tokens, pass by pass, as the
provider bills it. This is what `MEASURED_CLOUD_TOKENS` in
`backend/src/cloudEstimate.ts` is fitted to. Measured 27 September 2026 on
deepseek-v4-flash (Scaleway), Speed preset, 2,500-word chunks.

## Why

The estimator sizes each paid credential's spending ceiling (estimate x 2.5,
`TOKEN_BUDGET_HEADROOM` in `worker/wrangler.toml`, plus a 20% overdraft in
the ledger). Built from the prompts and a few guesses,
it was **1.74x short** of what a full benchmark run was billed — so a large
paid job could have exhausted its credential mid-run.

## How it was measured

`llm.ts` books every streamed response's `usage` block (prompt and completion
tokens as the provider counts them, hidden reasoning included) to the pass
that made the call, via AsyncLocalStorage, and each task result carries the
tally as `tokenUsage`. A reviewer runs while the next chunk's editor streams,
which is why the pass cannot be a shared variable
(`backend/test/usageTally.test.ts`).

28 jobs: the five stress fixtures (error-dense, ~100 planted errors per 2,300
words) in every sold mode; `stress300en` (eleven short chapters, which pins the
per-chunk cost); and ~4,000-word public-domain slices in all five languages
(Austen, Jensen, Kafka, Galdós, Voltaire) as the realistic, error-sparse case.

## Tokens per manuscript word, by pass (input + output)

| Mode, text | Total | Missing-word | Editor | Reviewer | Precision |
|---|---|---|---|---|---|
| Copy edit, fixtures | 30.3 | 3.2 + 0.5 | 5.3 + 0.8 | 7.4 + 2.6 | 7.4 + 3.0 |
| Copy edit, real prose | 20.3 | 3.5 + 0.2 | 3.2 + 1.2 | 4.2 + 1.8 | 4.2 + 2.1 |
| Combined edit, fixtures | 29.0 | 3.3 + 0.5 | 2.9 + 1.6 | 7.6 + 2.7 | 7.6 + 2.8 |
| Combined edit, real prose (en) | 13.1 | 3.0 + 0.2 | 2.6 + 1.9 | 2.1 + 0.6 | 2.1 + 0.6 |
| Readthrough, fixtures | 18.5 | 3.3 + 0.4 | 2.8 + 0.6 | 3.4 + 2.1 | 3.4 + 2.5 |
| Readthrough, real prose (en) | 10.0 | 3.0 + 0.1 | 2.4 + 0.0 | 1.9 + 0.3 | 1.9 + 0.3 |
| Line edit, fixtures | 9.5 | — | 2.7 + 0.9 | 3.5 + 2.4 | — |

Real prose per language, copy edit: English 11.6, German 15.2, Spanish 19.9,
Danish 23.0, French 32.3 tokens per word. The older prose draws more
corrections (period spellings), and French tokenises about 1.25x the rest.

**What the old estimator missed:** the precision pass entirely; the reviewer's
input (the chunk plus the whole corrections list — ~10,000 tokens on a dense
chunk, against 300 assumed); and both reviewing passes' output (~4,000 tokens
of verdicts, against ~430). On a dense chunk the reviewer and precision pass
are ~70% of the job.

## The precision pass, and its removal

The measurements above include a second reviewing call, the precision pass,
which asked whether the original needed fixing at all. It was 30.3% of all
measured tokens. Scored against planted ground truth on both engines
(`scripts/precision-pass-value.ts`), most of what it doubted the main reviewer
had already doubted — and the readthrough's blocker list already leaves those
out — while what it doubted on its own was right 63% of the time locally and
36% in the cloud, and the certainty it raised was on suggestions right 13-32%
of the time. It deleted nothing. It was removed on 27 September 2026; the
model below is fitted with its tokens taken out, and a local run of the same
job was measured at 21% less GPU energy (docs/energy.md).

## The model

Per mode: tokens per chunk (the prompts every call re-sends) plus tokens per
word, times a language factor (French 1.25). Per-chunk cost pinned from the
eleven-chapter run; per-word rate fitted on all runs.

| Mode | In / chunk | In / word | Out / chunk | Out / word |
|---|---|---|---|---|
| Copy edit | 4,275 | 9.11 | 700 | 2.79 |
| Combined edit | 4,275 | 9.16 | 700 | 3.52 |
| Readthrough (proofread) | 4,275 | 6.43 | 700 | 1.71 |
| Line edit | 4,206 | 4.03 | 554 | 2.94 |

The publication scan is deterministic and now costs nothing (it had been
priced as a second copy edit beside the readthrough).

**Fit.** Across the 28 jobs (precision tokens excluded), billed ÷ estimate
ranges 0.62-1.26: it over-estimates ordinary prose by up to 1.6x and
under-estimates the densest fixtures by at most 26%, inside the credential's
headroom (2.5x plus the 20% overdraft, so 3x before a job is refused). The earlier, independent benchmark run billed 1.81M tokens
with the precision pass; without its 30% share that is about 1.26M against an
estimate of 1.51M (0.83). The old estimator was 1.74x short of the same run.

**What it changes.** Prices do not move (flat word bands). For a 100,000-word
English copy edit the estimate goes from 588,000 tokens (the released
estimator, which also predates the missing-word check) to 1.39 million, so
credentials are sized about 2.4x larger. A single quote is capped at 8M tokens
(`MAX_QUOTE_TOKENS`), which allows a copy edit of roughly 575,000 words in one
run (475,000 in French), down from about 1.36 million.

To re-measure: run cloud jobs against a backend with this code and read
`result.tokenUsage` per task.
