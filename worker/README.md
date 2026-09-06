# Betty in the Cloud — Cloudflare Worker

Standalone service behind the "Run in Cloud" button in the Bethaniel app. It
issues short-lived, prepaid credentials after a Stripe payment and meters
every request against an OVHcloud AI Endpoints proxy. See `../CLAUDE.md` and the
plan this was built from for the full design rationale — this file is just
the deploy checklist.

## One-time setup

1. `npm install`
2. Create the D1 database and copy its id into `wrangler.toml`:
   ```
   npx wrangler d1 create bethaniel-cloud
   # paste the returned database_id into wrangler.toml's [[d1_databases]] block
   npx wrangler d1 execute bethaniel-cloud --remote --file=./schema.sql
   ```
3. Set secrets (never committed — these live only in Cloudflare):
   ```
   npx wrangler secret put PROVIDER_API_KEY
   npx wrangler secret put STRIPE_SECRET_KEY
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```
   `STRIPE_WEBHOOK_SECRET` comes from the Stripe Dashboard once you've added
   an endpoint pointed at `https://<your-worker-domain>/webhooks/stripe`
   listening for `checkout.session.completed`.
4. Point a real domain at it (uncomment the `routes` line in `wrangler.toml`
   once DNS is set up), and update the `bethaniel-cloud` catalog entry's
   `defaultBaseUrl` in `backend/src/modelCatalog.ts` (or set
   `BETHANIEL_CLOUD_BASE_URL` in the app's environment) to match.
5. `npm run deploy`

## Local development

`npm run dev` runs against Miniflare with a local D1 instance. Put fake
secrets in a `.dev.vars` file (gitignored) to test without touching Stripe or
OVHcloud for real:
```
PROVIDER_API_KEY=fake-ovh-token
STRIPE_SECRET_KEY=sk_test_fake
STRIPE_WEBHOOK_SECRET=whsec_fake
```
`npx wrangler d1 execute bethaniel-cloud --local --file=./schema.sql` seeds
the local database's schema. A real Stripe test-mode key lets you drive an
actual Checkout Session end-to-end; without one, `/v1/quote` and the
credential-issuance ledger logic can still be exercised directly by posting a
hand-signed webhook payload (see the HMAC-SHA256 scheme Stripe documents for
its `Stripe-Signature` header).

## Safety limits

OVHcloud offers budget **alerts** (an email once forecast usage crosses a
threshold) but **no hard spending cap**, and an authenticated key may send 400
requests/minute per project per model — roughly EUR 187/hour at a
representative Bethaniel chunk. The ceilings below are therefore the only real
ones that exist, and they live here rather than at the provider.

| Var | Default | What it bounds |
|---|---|---|
| `DAILY_TOKEN_CEILING` | 15,000,000 | Worker-wide tokens per UTC day (~EUR 23 upstream). Enforced by the `GlobalMeter` DO. **Fails closed** if unset or unparseable. |
| `MAX_OUTPUT_TOKENS_PER_REQUEST` | 8,192 | Caps one call's generation however large a `max_tokens` it asks for. |
| `MAX_QUOTE_TOKENS` | 8,000,000 | Upper bound on an unauthenticated `/v1/quote`. Clamped at runtime to `min(MAX_QUOTE_TOKENS, DAILY_TOKEN_CEILING)` so we can never sell a job the ceiling would refuse. |
| `PROVIDER_REASONING_EFFORT` | `none` | See below. |

`CredentialLedger` caps what one *paying user* can spend; `GlobalMeter` caps
what Bethaniel spends in aggregate. Both are needed — ten thousand credentials
would otherwise mean ten thousand independent budgets and no total limit.
`npm test` covers the GlobalMeter's ceiling, fail-closed and concurrency
behaviour.

Sizing assumes cloud jobs run the **Speed** preset, which the backend forces
(`cloudRunKnobs`, backend/src/cloudEstimate.ts) rather than trusting the
client: the largest job anyone can buy is then a 400k-word manuscript at 4.98M
tokens. Without that forcing, "custom" would allow 4 editors + style agent + 4
reviewers + a second pass — 21.3M tokens for 300k words, several times these
ceilings.

**What GlobalMeter does not cover:** a stolen `PROVIDER_API_KEY`. That key is
used directly against OVHcloud and never passes through this Worker. The only
controls there are the provider account's funding and key rotation — which is
why it belongs on a separate, lightly-funded OVHcloud project.

### Reasoning must stay off

Qwen3.5 is a reasoning model and thinks by default. Measured against the live
API on a four-sentence copy-edit prompt: **102 input tokens produced 3,000
completion tokens of pure reasoning, `finish_reason: "length"`, and an empty
`content` field** — the app's JSON parser would have received nothing. With
`reasoning_effort: "none"` the same prompt costs 209 completion tokens and
returns the corrections array. That is both a >10x cost difference and the
difference between the feature working and not, so `proxy.ts` injects it on
every upstream call. Setting `PROVIDER_REASONING_EFFORT = "default"` hands
control back to the provider — don't, without re-measuring both cost and
whether `content` still arrives.

Note that OVHcloud rejects `chat_template_kwargs` (the vLLM/Qwen convention
for the same thing) with an explicit "not currently supported", so
`reasoning_effort` is the only lever available.

## Before launch

- OVHcloud AI Endpoints was chosen over Mistral because zero data retention
  is its default ("we keep only the data required for billing") rather than
  something you must apply for — Bethaniel's brand promise is that manuscripts
  stay private, and this Worker is the one place that promise is explicitly
  (and only ever opt-in) set aside. Re-confirm those terms in the contract
  before launch, and check the region the Base API tier actually serves from:
  the product page notes worldwide (non-EU) availability for that tier.
- `BASE_COST_EUR_PER_TOKEN` is OVHcloud's list price for
  `Meta-Llama-3_3-70B-Instruct`, which is FLAT at EUR 0.67/Mtok for input and
  output alike — so the figure is exact rather than a blend, and does not move
  with the input/output mix. Re-derive it against a real invoice once usage
  data exists — the whole price scales linearly with it.
- The model was chosen by benchmark, not by size. All five OVHcloud text
  models were run against `sample_texts/stress100` at the Speed preset;
  Llama-3.3-70B led on recall (56% vs 35% for the Qwen3.5-397B it replaced),
  on spelling recall specifically (78% vs 54%), on wall-clock (~2x), and on
  clean-text false positives (2 vs 39) — at half the token price. Full table
  in `sample_texts/run_mode_bench_results.txt`. Caveat: one run per model, and
  the 397B alone varied 35-41% across three runs, so treat the ranking as
  indicative until it is repeated.
- Two things that will waste your afternoon if you do not know them:
  `wrangler dev` does NOT reload `[vars]` edits — restart it after changing
  `PROVIDER_MODEL` or you will benchmark the old model. And
  `PROVIDER_REASONING_EFFORT` is per-model: "none" for Qwen, "default"
  (omit the field) for Llama, and gpt-oss 400s on an explicit "none".
- `MARKUP_MULTIPLIER` is 3 — the user pays 3x the blended provider cost,
  before Stripe's cut is grossed up on top.
