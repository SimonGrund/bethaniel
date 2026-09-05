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

## Before launch

- OVHcloud AI Endpoints was chosen over Mistral because zero data retention
  is its default ("we keep only the data required for billing") rather than
  something you must apply for — Bethaniel's brand promise is that manuscripts
  stay private, and this Worker is the one place that promise is explicitly
  (and only ever opt-in) set aside. Re-confirm those terms in the contract
  before launch, and check the region the Base API tier actually serves from:
  the product page notes worldwide (non-EU) availability for that tier.
- `BASE_COST_EUR_PER_TOKEN` is derived from OVHcloud's list price for
  `Qwen3.5-397B-A17B` (EUR 0.60/Mtok in, EUR 3.60/Mtok out) blended at the
  68/32 input/output split the estimator predicts. Re-derive it against a real
  invoice once usage data exists — the whole price scales linearly with it.
- `MARKUP_MULTIPLIER` is 3 — the user pays 3x the blended provider cost,
  before Stripe's cut is grossed up on top.
