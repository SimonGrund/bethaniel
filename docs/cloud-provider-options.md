# Cloud provider options

Betty in the Cloud is withdrawn from sale (`CLOUD_OFFER_SUSPENDED`) because
OVHcloud's Qwen3.5-9B endpoint serves at ~36 tok/s per stream against
DeepSeek's ~176 — roughly 4.8x, putting a 120,000-word copy edit at 25-40
minutes instead of ~4. This is the survey of where else it could run.

Researched 9 September 2026. **Nothing here is measured.** See the last section.

## What we are actually shopping for

In priority order, because the trade-offs conflict:

1. **Privacy and sovereignty.** This is why OVHcloud was chosen and why
   DeepSeek — fast, cheap, and already integrated as "External Betty" — is not
   the answer for the *paid* product. External Betty says plainly that the
   manuscript goes to DeepSeek's servers and the author opts into that. A
   Bethaniel-run service moves everyone onto those terms silently.
2. **Speed.** The reason we are here.
3. **The right models.** A Qwen3.5-9B-class model for copy and line edit, and
   something 70B-class for translation, where size demonstrably pays
   (`docs/language-quality-roadmap.md` §5).
4. **Green energy.** A real preference, and cheap to satisfy — European
   inference is mostly in low-carbon grids already.
5. **Rate headroom.** OVHcloud's 400 req/min is shared across every Bethaniel
   customer, which saturates at 5-11 concurrent jobs. Whatever replaces it
   needs a better answer, or a smaller per-job footprint.

## Candidates

### Scaleway (France) — the strongest fit

- **Models:** Qwen3.5-397B, Llama-3.3-70B, Mistral Medium 3.5, GLM 5.2,
  Qwen3.6-35b-a3b, DeepSeek-V4-Flash. The only provider found that covers both
  ends of what we need, and the 35b-a3b is an MoE with ~3B active parameters,
  which is the shape that tends to be genuinely fast.
- **Privacy:** Zero Data Retention *by default*, not on application — the exact
  distinction that ruled out Mistral last time. Data stored in Europe and
  explicitly outside extraterritorial legislation.
- **Energy:** DC5 runs a PUE of 1.16 against a 1.55 industry average, and the
  French grid is one of the lowest-carbon in Europe.
- **Rate limits:** 60 RPM on the free tier; higher after KYC. Notably the
  **Batch API has no rate limit and costs 50% less** — see below.
- **Watch:** per-model pricing varies widely ($0.12-$2.08 per Mtok input).

### Infomaniak (Switzerland) — the greenest, and the cleanest privacy story

- **Models:** Llama 3, Mistral. A narrower catalog — verify a Qwen-class model
  exists before committing, since that is what the benchmark picked for editing.
- **Privacy:** queries neither recorded nor used for training; end-to-end in
  Switzerland; FADP and GDPR. Arguably a better story than any EU provider.
- **Energy:** the best of the set — exclusively local renewable, own solar
  plants, heat recovery, CO2 offset. If green is a tiebreaker, this wins it.
- **Watch:** Switzerland is outside the EU and relies on an adequacy decision.
  Fine, but it is a different sentence to write on the privacy page.
- 1M free credits, so it costs nothing to benchmark.

### Nebius (Finland + Paris)

- Broad open-source catalog; independently noted for output speed and cost.
- EU data centres, GDPR, EU Data Act compliance since March 2026. Finland's
  grid is low-carbon and Nordic PUE is typically excellent.
- **Watch:** Nebius is the post-divestment continuation of Yandex N.V. For a
  product sold on sovereignty, that history is worth understanding before
  putting it on the privacy page — not disqualifying, but not invisible either.

### Also seen, not investigated

STACKIT (Schwarz Group, German data centres, no storage or training use),
Regolo (Italy, strict zero retention), Nordference, and Prem's Enclave API,
which runs inference inside hardware-enforced TEEs on encrypted GPUs. That last
one is the strongest privacy claim available if the story ever needs to be
airtight rather than merely good.

### Mistral — worth re-checking

Rejected once because zero retention had to be applied for rather than being
the default. Third-party comparisons note their policies change often. Cheap to
re-verify, and they are the obvious French incumbent.

## The lead worth chasing regardless of provider

**Scaleway's Batch API has no rate limit and costs 50% less.** A manuscript
edit is not interactive — nobody watches a chapter stream — so the thing that
has forced every rate-limit compromise so far may simply not apply. That would
address the 400/min shared ceiling AND halve the token cost, at the price of
restructuring the queue to submit and poll rather than stream.

Worth pricing out before choosing a provider on speed alone, because it changes
what "fast enough" means.

## Measured, 9 September 2026

Same 2,366-word chunk, same copy-edit prompt, full response timed.

| Provider / model | single stream | 8 concurrent (aggregate) |
|---|---|---|
| OVHcloud Qwen3.5-9B | 36 tok/s | 178 |
| Scaleway qwen3.6-35b-a3b | 48 tok/s | 308 |
| Scaleway deepseek-v4-flash | **75 tok/s** | 229 |
| DeepSeek direct (not EU) | 153-225 tok/s | 1,171-1,326 |

**DeepSeek-V4-Flash on Scaleway is twice OVHcloud's speed**, EU-hosted, zero
retention by default, and the model family already trusted through External
Betty. It is the leading candidate.

Two cautions before treating any of this as settled:

- **The aggregate column looks throttled.** 88 tok/s per stream across 8
  streams should aggregate near 700; it gives 229. Scaleway appears to queue
  concurrent requests, and their docs say official rate limits apply only
  after KYC. Re-measure on a verified account before drawing conclusions
  about parallelism — this is the number that decides whether the shared-
  ceiling problem follows us to the new provider.
- **This is speed only. Quality is unmeasured.** The frozen benchmark in
  `language-quality-roadmap.md` covers Qwen3.5-9B, Llama-3.3-70B and the two
  local models. Nothing is known about qwen3.6-35b-a3b or deepseek-v4-flash
  on planted-error recall, and speed is worthless if recall drops. The
  four-language grid has to be re-run against the candidate before it ships.

Scaleway's base URL is project-scoped, not model-scoped:
`https://api.scaleway.ai/<project-id>/v1` serves the whole catalog and the
model is chosen per request. Confirmed working model ids: `qwen3.6-35b-a3b`,
`deepseek-v4-flash` (reports as `deepseek-v4-flash-0731`), `glm-5.2`.

## Nobody publishes tokens per second

Not one provider states throughput. The best independent comparison found ships
a *benchmark script* instead of numbers, on the grounds that published figures
go stale. So this survey cannot pick a winner, and should not pretend to.

**Next step is measurement, not more reading.** Free tiers exist for Scaleway
(60 RPM) and Infomaniak (1M credits). The harness already exists — the same
2,366-word chunk and prompt used to measure OVHcloud at 36 tok/s and DeepSeek
at 176. An afternoon with two free API keys settles this properly.
