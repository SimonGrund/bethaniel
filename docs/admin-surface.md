# Admin surface — content sheet

Working notes for the operational surface behind Betty in the Cloud. Nothing
here is built yet. Started 8 September 2026, while walking the first live
checkout flow.

## Why this exists

Two moments in that walkthrough made the case:

- **Triggering the refund sweep** meant either waiting up to an hour for the
  cron or hand-editing the production D1. There is no "run it now".
- **A `refund_status = 'review'` row** is written by the sweep and read by
  nobody. The design deliberately routes ambiguous refunds to a human, and
  right now that human has no inbox.

Both are the same gap: the Worker has operational state with no way to see or
act on it that isn't `wrangler d1 execute` against live data.

## The question to settle first

**Endpoints or a dashboard?** They are not the same commitment.

Authenticated endpoints are a header check and some JSON. A dashboard is a
second auth system, a session model, a UI to maintain, and — because this repo
is public — a login page whose existence is known to everyone.

Recommendation: **endpoints first**, driven from a terminal. Build the page
only once there is a task that is genuinely painful without one. Most of what
follows is a handful of calls a week at current volume.

## Auth

Whatever gets built, this part does not change:

- A single `ADMIN_TOKEN` secret, set via `wrangler secret put`, never in
  `wrangler.toml`.
- **Fail closed**: if `ADMIN_TOKEN` is unset, every admin route 404s. A
  deployment that forgot the secret must not expose an open admin API — and it
  should 404 rather than 401, so the routes are not discoverable by probing.
- Timing-safe comparison, same helper as the Stripe signature check.
- Rate-limited like the public endpoints, on the same binding.
- Admin routes must never appear in the OpenAI-compatible surface the app
  talks to. Different prefix (`/admin/*`), so a leaked credential reaches
  nothing here.

## Candidate endpoints, roughly in order of need

| Endpoint | What it answers | Why now |
|---|---|---|
| `POST /admin/sweep` | run the expiry + refund pass on demand | needed to test refunds at all; removes the hour-long wait |
| `GET /admin/refunds?status=review` | which credentials are waiting on a decision | the sweep's output currently has no reader |
| `POST /admin/refund/:credentialId` | refund one, by hand, deliberately | the manual half of the refund design |
| `GET /admin/credential/:sessionOrToken` | look one up for a support email | "I paid and got nothing" arrives with a session id |
| `GET /admin/stats` | today's tokens, spend against ceiling, credentials issued | currently only visible in `wrangler tail` |
| `POST /admin/promo` | mint a code without hand-writing SQL | the README's INSERT is a footgun (ISO dates, column names) |
| `POST /admin/credential/:id/void` | kill a credential | no answer today if one leaks |

## Open questions

- **Where does a support request arrive?** The success page says "contact
  support" and names no address. That has to be answered before launch
  regardless of what gets built here.
- **Is `review` the right default?** It routes ambiguity to a human who may
  not look. An email on each one would fix that; so would a weekly digest.
  Neither exists.
- **Does an admin action need an audit trail?** A refund issued by hand is
  currently indistinguishable from one the cron issued. A `refunded_by`
  column is cheap now and impossible to backfill later.
- **Does a dashboard belong in the Electron app instead?** It already has a
  window, a settings panel, and no public URL — which removes the login page
  problem entirely. The admin token would live in the app's own config.

## Explicitly out of scope

- Per-user accounts. There are none, by design — a credential is the identity.
  Anything here that implies a user list is a bigger change than it looks.
- Anything that reads manuscript content. Nothing in this Worker ever sees it,
  and no admin convenience is worth being the first thing that does.
