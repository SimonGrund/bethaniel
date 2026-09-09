# LanguageTool is load-bearing, and nothing said so

Written 9 September 2026, after a day of benchmark numbers that were quietly
wrong.

## What happened

Every backend started during that session carried `LANGUAGETOOL_DISABLED=1` —
set once to avoid a Java dependency, then inherited by every run after it. The
results looked entirely normal. They were between 8 and 20 points low.

| fixture | grammar off | grammar on |
|---|---|---|
| stress100 | 48% | **68%** |
| stress100de | 52% | **71%** |
| stress100es | 46% | **63%** |
| stress100da | 43% | **54%** |

Commas are 37% of the planted errors in the stress fixtures, and commas are
mostly what LanguageTool contributes. Comma recall without it was 19%.

The damage was not the lost points. It was the **conclusion**: two Scaleway
models measured at ~46% were declared 15 points below baseline and unusable,
and the cloud offer stayed withdrawn partly on that basis. The local model,
measured the same way on the same day, also scored ~46%. Both were handicapped
identically and the comparison was never made.

## Three fixes, in order of how much they would have helped

### 1. The results file must record the environment

This alone would have caught it in minutes. `benchmark_results.json` stores
model, file, language, variant, mode, repeatIndex, correctionsFound, runtimeMs,
corrections, errors, runDate — and nothing about the pipeline that produced
them. A run with grammar checks off is indistinguishable from a valid one.

Record at least: LanguageTool available/version, spellcheck on, retext on, the
run-mode knobs, and the resolved model behind an API entry (which is also
currently wrong — the report labels cloud runs with whatever string sits in the
local api-config, not the model the Worker actually called).

Then make the report PRINT it, so a degraded run announces itself.

### 2. The benchmark should refuse to run without it

This is where a hard block belongs. A benchmark is a measuring instrument; one
that silently changes its calibration is worse than one that will not start.
`test-models.ts` should exit non-zero if LanguageTool is unreachable, with
`--allow-no-grammar` for the deliberate case — and that flag should stamp the
results file so the numbers carry the caveat wherever they travel.

### 3. The product should refuse the JOB, not refuse to exist

Simon's instinct — that it is too integral to be optional — is right about the
quality and worth qualifying about the failure mode.

Today the design degrades silently and deliberately: `HOWTO.md` says "if the
distribution is missing, the backend silently skips grammar checks and nothing
else is affected". That was a reasonable choice when grammar checks were a
bonus. They are not a bonus; they are most of the comma recall.

But hard-failing at startup would turn "somewhat worse edits" into "no product"
for anyone whose antivirus quarantined the bundled JRE, and that is a worse
outcome for that user than the thing it prevents.

The right shape, given the app can already repair itself:

- Released installers bundle LanguageTool and a Temurin JRE (`scripts/build.mjs`),
  so a normal install has it.
- If it is missing at job time, **refuse to start the job** with an actionable
  message rather than running a degraded one.
- Offer the existing in-app download (`downloadLanguageTool` in routes.ts) as
  the fix. Blocking is only fair because the user can unblock themselves.
- Keep `LANGUAGETOOL_DISABLED` for CI and benchmarking, but treat it as a
  declaration that the results are degraded, and say so in the UI when it is on.

## Warm-up: yes for the harness, marginal for the product

Measured on Scaleway: five identical trials at concurrency 8 ran 422, 432, 517,
559, 607 tok/s — monotonically climbing, ~2.4x from cold to warm. Serverless
endpoints load and scale replicas under sustained load.

**For the benchmark: warm up and discard the first trial.** Every provider
comparison taken cold is meaningless, and two of them in this session were.

**For the product: probably not worth it.** A 43-chapter job runs 40 chapters
concurrently and warms the endpoint within seconds; the cost amortises to a few
percent of a 14-minute run. Spending tokens on a warm-up ping to save 30s of a
14-minute job is a bad trade.

The exception worth building: a **single-chapter** job, where warm-up is the
whole experience and the user forms their impression of the product's speed
from it. A few-token ping issued as the job is queued — before the first real
chunk — costs almost nothing and is the case where it is most visible.
