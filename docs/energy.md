# Energy per book — Local Betty and Betty in the Cloud

What a 60,000-word copy edit costs in electricity, per engine. Measured where
it can be (the bundled model on our own GPU), estimated where it cannot (the
cloud provider's servers). 27 September 2026, with the missing-word check in
the pipeline and the precision pass removed.

Reference: boiling one litre of water from 15 °C takes 0.099 kWh at the
element, about **0.11 kWh** at a typical kettle's efficiency. A full 1.7 L
kettle is about 0.19 kWh.

## Local Betty (Qwen3.5-4B) — measured

One copy-edit job, the app's defaults (Speed preset, 3 parallel slots, grammar
checks on), over 18,714 words of real English prose (four chapters of one of
the author's novels and two of another). GPU board power sampled every 0.5 s
with `nvidia-smi`, after a 30 s idle baseline.

| | With the precision pass | **Without (current)** |
|---|---|---|
| GPU | RTX 5090 (600 W limit) | RTX 5090 |
| Wall time | 3.8 min | **3.2 min** (≈ 5,800 words/min) |
| GPU power, idle / mean / peak | 54 / 373 / 470 W | 53 / 347 / 455 W |
| GPU energy for the job | 23.7 Wh | **18.7 Wh** (15.8 above idle) |
| **GPU energy per 60,000 words** | 76 Wh | **60 Wh** (51 above idle) |

Not measured: CPU, memory, disk, the LanguageTool server and power-supply
losses. Allowing 1.3-1.5x for the rest of a desktop puts the whole machine at
roughly **80-90 Wh per 60,000 words — a little under one litre-kettle.** A
laptop is slower and draws far less; it was not measured.

## Betty in the Cloud (DeepSeek-V4-Flash on Scaleway) — estimated

**Tokens.** Measured per pass on the provider's own counts
(`docs/cloud-token-model.md`). Without the precision pass, a copy edit of real
prose costs 9.0 tokens per word in modern English and 11-16 in the older
Danish, German and Spanish prose (French 21); error-dense text costs more. For
a 60,000-word modern novel that is roughly **0.5-1.0 million tokens**, about
85% input.

**Energy per token.** No figure is published for DeepSeek-V4-Flash (284B total,
13B active per token) or for Scaleway's hardware. Two neighbours with the same
input-heavy shape (8k in / 1k out per query), GPU power only, from InferenceMAX
data (muxup.com, 2026 Q1):

| Model | Active params | Wh per 9k-token query | Wh per 1k tokens |
|---|---|---|---|
| gpt-oss-120B (B200, FP4) | ~5B | 0.11-0.20 | 0.012-0.022 |
| DeepSeek-R1 (H200/B200/GB200, FP8/FP4) | 37B | 0.63-3.7 | 0.07-0.41 |

V4-Flash sits between them; we use **0.03-0.15 Wh per 1k tokens** (GPU), the
top end for H100/H200-class serving.

| | |
|---|---|
| GPU energy, 0.5-1.0M tokens | 15-150 Wh |
| × data-centre overhead (cooling, host, network), 1.2-1.5 | **~20-225 Wh per 60,000 words** |
| In kettles | about **0.2-2**, central estimate about 0.8 (0.7M tokens at 0.09 Wh/1k × 1.35) |

An estimate built on another model's measurements, not a measurement: the
uncertainty is the width of that range, and it should be quoted as such.

## History

The website's first kettle card said "about 643,000 tokens": 10.7 tokens per
word, the old estimator's copy-edit figure, which left out a whole reviewing
call and under-counted the other. A later version of this note said 1.4
million tokens, calibrated on the error-dense benchmark fixtures alone and with
the precision pass still running; the real-prose runs and the removal of the
pass brought it to the figures above.
