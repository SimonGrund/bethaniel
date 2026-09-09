# Launch checklist — Betty in the Cloud

What stands between the current `workers.dev` test deployment and taking real
money. Written 8 September 2026, after the first end-to-end payment walkthrough
and the cloud review of #48.

Status legend: **BLOCKER** must be done, **SHOULD** do it or accept a known
cost, **LATER** can follow launch.

## BLOCKER — the automatic refund promise is not kept

The success page tells the customer, in writing: *"Unused credit is refunded
automatically when it expires."* That is **false in production today**. The
hourly cron has never fired on this Cloudflare account — registered, shown in
the dashboard with a next-run time, zero invocations observed at a one-minute
cadence. Nothing has ever run the sweep except a manual `POST /admin/sweep`.

Without it: credentials never expire, the `quotes` table grows unboundedly on
an unauthenticated endpoint, and nobody is ever refunded.

Three ways out, any one is enough:

1. Fix the cron (see `docs/cron-investigation.md`).
2. Call `/admin/sweep` on a schedule from somewhere that does work — a GitHub
   Action on a schedule, or any external pinger with the admin token.
3. Change the sentence on the success page, so the product does not promise
   something it does not do.

Do not launch having done none of these.

## BLOCKER — secrets to rotate

- **The `sk_live_` Stripe key.** It sat in the deployed Worker briefly on
  8 September during the environment mix-up. Unused, but rotate it.
- **`ADMIN_TOKEN`.** Generated during testing on 8 September. It is a working
  credential to the refund machinery.

## BLOCKER — the live payment path has never run

Everything so far was Stripe test mode. Going live means:

- A **live-mode webhook endpoint** at the production URL. A sandbox or
  test-mode endpoint does not carry over, and its `whsec_` will not verify.
  The signing secret belongs to the ENDPOINT, not the key — what has to match
  is the environment the two live in.
- `ALLOW_LIVE_PAYMENTS = "true"` in `wrangler.toml`. Until then any live key
  is refused by design (`assertPaymentsAllowed`).
- One real payment, end to end, on the real domain, before announcing it.

**Use a restricted key, not a full one.** The Worker makes exactly two Stripe
API calls, so the grant is:

| Scope | Level |
|---|---|
| Checkout Sessions | Write |
| Refunds | Write |
| everything else | None |

Verified against a restricted TEST key on 9 September 2026: a real test
payment minted its credential, and an expired-unused credential was refunded
through the live Stripe API. Inline `price_data` needs no Products or Prices
scope. Webhook verification is a local HMAC and touches no key at all.

A full key can read every payment and customer you have and move money out;
these two can take payments (which only ever pay you) and reverse them.
`Refunds: write` is the one scope with teeth and cannot be dropped without
giving up the automatic-refund promise.

Note that restricted keys are `rk_live_`, not `sk_live_` — the guard tests
the `_live_` segment for exactly this reason. See the 9 September fix.

## RESOLVED — production runs on workers.dev

Decided 9 September 2026: no custom domain for now.

A Workers Custom Domain requires Cloudflare to be authoritative for the zone.
`bethaniel.eu` is on simply.com nameservers and carries Google Workspace mail
(`MX smtp.google.com`) — which serves `simon@bethaniel.eu`, the address the
checkout failure page tells customers to write to. Moving nameservers to gain
a prettier URL risks the mailbox that catches "I paid and got nothing".

`backend/src/modelCatalog.ts` now points at
`https://bethaniel-cloud.cloudwatcher.workers.dev`, which matches
`CHECKOUT_SUCCESS_URL_BASE`, and `routes` stays commented out.

The cost is that customers see that URL in the address bar during checkout.
If it is ever worth changing, FOUR things move together — `routes`,
`CHECKOUT_SUCCESS_URL_BASE`, `defaultBaseUrl`, and the live webhook endpoint's
URL in Stripe. Missing the last one charges customers and gives them nothing.

## SHOULD — a `review`-flagged refund has no reader

The sweep writes `refund_status = 'review'` for credentials that are partly
used, deliberately leaving the decision to a human. Nobody is notified. A
customer waiting on that decision is waiting on an inbox that does not exist.
Minimum: a recurring reminder to run the query. Better: `GET /admin/refunds`
(see `docs/admin-surface.md`) and an actual look at it each week.

## SHOULD — no audit trail on refunds

A refund issued by hand is indistinguishable from one the sweep issued. A
`refunded_by` column costs nothing now and cannot be backfilled later.

## SHOULD — decide where this lives

The Cloudflare account is under `simon@journeycatcher.dk`, not the address the
work is done from. Billing, alerts and access recovery all follow that account.
Fine if deliberate; worth confirming it is.

## LATER

- Promo `max_uses` is global, not per-customer — a leaked code is spent by
  whoever finds it first. Acceptable for "exclusive" marketing; not for
  anything printed publicly.
- `MARKUP_MULTIPLIER` and `MIN_CHARGE_EUR_CENTS` are vestigial and set no
  price. `BASE_COST_EUR_PER_TOKEN` is knowingly the wrong model's rate, kept
  high so the daily ceiling errs early. Replace with the blended Qwen rate once
  a real invoice exists.
- The admin surface is one endpoint. `docs/admin-surface.md` has the rest.

## Done

- Rate limiting on the unauthenticated endpoints (per-IP, 30/min).
- The pricing hole: `words` and `estimatedTokens` are cross-checked, so an
  under-reported word count cannot buy an oversized credential cheaply.
- Promo codes are returned when the checkout they paid for fails.
- Settlement steps are isolated, so one failure cannot leak a reservation for
  a credential's whole life.
- OVHcloud key confirmed on a dedicated, small-funded project.
- Support address named on the failure page.
- Refund path proven end to end against real money, test mode.
