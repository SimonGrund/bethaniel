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
4. `npm run deploy`. With `routes` still commented out this lands on
   `bethaniel-cloud.<your-subdomain>.workers.dev`, which is the right place to
   walk the checkout flow the first time — a real card, a real webhook, and a
   URL nothing in production points at yet.
5. Point a real domain at it (uncomment the `routes` line in `wrangler.toml`
   once DNS is set up), and update the `bethaniel-cloud` catalog entry's
   `defaultBaseUrl` in `backend/src/modelCatalog.ts` (or set
   `BETHANIEL_CLOUD_BASE_URL` in the app's environment) to match. Until then
   the app cannot reach the Worker: the catalog points at `cloud.bethaniel.eu`.

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
| `TOKEN_BUDGET_HEADROOM` | 1.5 | Multiplier on the estimate when minting a credential's ledger budget. The estimator is a heuristic; a job that runs 20% over its quote must still finish, or the user has paid for a truncated edit. Raising it loosens the per-user cap; lowering it risks a job dying mid-manuscript. |
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
- **`BASE_COST_EUR_PER_TOKEN` no longer sets any price**, and is knowingly the
  wrong model's rate. Pricing moved to flat word bands (see below), so this
  figure now only feeds globalMeter.ts's reading of the daily ceiling in money.
  It is Llama-3.3-70B's flat EUR 0.67/Mtok, while the editing model is
  Qwen3.5-9B, which OVHcloud prices lower and SPLIT (input and output at
  different rates). Kept high deliberately: over-estimating the cost makes the
  ceiling bite EARLIER than real spend warrants, which is the safe direction
  for a bound whose job is to stop runaway spending. Replace it with the
  blended Qwen rate when the real numbers are to hand, and the ceiling becomes
  accurate rather than merely safe.
- **Two models, chosen per pass by benchmark.** `PROVIDER_MODEL` is
  Qwen3.5-9B for copy and line edit; `PROVIDER_MODEL_TRANSLATE` keeps
  Meta-Llama-3.3-70B for translation alone. Measured 8 September 2026, all
  four models on one harness at identical settings (one editor, one reviewer,
  one request at a time), four languages of ~100 planted errors each:

  |                     | copy edit | line edit | translation (chrF) |
  |---|---|---|---|
  | Baby Betty 4B       | 60% | 52% | 75.8 |
  | Big Bad Betty 9B    | 60% | 49% | 76.5 |
  | Llama-3.3-70B       | 60% | **24%** | **78.3** |
  | Qwen3.5-9B (cloud)  | 59% | 52% | 76.7 |

  Copy edit is a four-way tie inside one point — a 4B on a laptop matches a
  70B that costs per token. Line edit is where they differ, and there the 70B
  is the worst of the four by a wide margin, less than half the free bundled
  model. Only translation rewards size, and it does so consistently: 78.3
  against 76.7 overall and five points on Danish. Hence the split. Read
  `docs/language-quality-roadmap.md` §5 before changing either model.
- **Pricing is flat word bands, not cost-plus.** `PRICE_TIER_WORDS` (100,000)
  costs `PRICE_TIER_EUR_CENTS` (EUR 5); two bands cost double, and so on. A
  100,000-word novel and a 3,000-word story both sit in band one and pay the
  same — band one is the floor, which is the deliberate trade for a price
  anyone can work out in their head. Cost-plus was abandoned because the costs
  are too small to bill: 100,000 words is ~1.07M tokens for a copy edit, about
  EUR 0.16 on the editing model. `MARKUP_MULTIPLIER` survives only for the
  cost model in globalMeter.ts and sets no price.
- **Promo codes are the only route to a discount or a free run.** A code
  carries a percentage, an absolute discount, or both, plus a use count, an
  expiry and optionally a word cap. Quoting never spends one; the use is taken
  atomically at `/v1/checkout`. A code that brings the price to zero skips
  Stripe entirely and mints the credential inline, keyed to a synthetic session
  id so a replay is idempotent. There is no admin endpoint yet, so mint one
  by hand — a code good for one free job of up to 5,000 words:

  ```
  npx wrangler d1 execute bethaniel-cloud --remote --command \
    "INSERT INTO promo_codes (code, campaign, discount_pct, max_uses, max_words,
                              created_at, expires_at)
     VALUES ('LAUNCH100', 'launch', 100, 1, 5000,
             '2026-09-08T00:00:00Z', '2026-12-31T00:00:00Z')"
  ```

  Dates are ISO-8601 strings, not epoch seconds — they are compared as text,
  so a `Z`-suffixed UTC timestamp is the only safe form. `discount_cents`
  takes an absolute EUR-cent discount instead of, or alongside, `discount_pct`.
  Codes are matched case-insensitively and stored uppercase. `max_uses` is
  total across all users, not per user — there are no user accounts to key it
  to, so a code that leaks is spent by whoever finds it first.
- Two things that will waste your afternoon if you do not know them:
  `wrangler dev` does NOT reload `[vars]` edits — restart it after changing
  `PROVIDER_MODEL` or you will benchmark the old model. And
  `PROVIDER_REASONING_EFFORT` is per-model: "none" for Qwen, "default"
  (omit the field) for Llama, and gpt-oss 400s on an explicit "none".
