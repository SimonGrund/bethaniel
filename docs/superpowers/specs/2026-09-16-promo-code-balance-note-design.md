# Promo code balance notes on the task cards

**Date:** 2026-09-16
**Status:** approved, implementing

## The problem

A promo code can carry several uses, and — since `max_uses_per_product` — a
different number of them per product. Nothing in the app says so. The author
types a code into the box under the Run button, sees "code applied", and has
no way to learn that they hold two free publication scans and nothing else
until they try a card and watch the price stay at EUR 10.

## What we are building

Each of the four front cards carries a note when the author's code can pay for
a run of that task:

```
shared pool   🎟 3 free runs left (any task), up to 200,000 words
per-product   🎟 1 free run on this task, up to 200,000 words
```

The same note appears under the code input, replacing today's bare "code
applied" line, so a freshly typed code gives immediate feedback on the step it
was typed on.

The code string persists between sessions. **The count never does.**

## Why the count is never persisted

The balance is shared state. Two machines can hold the same code, and the
number one of them last saw is not a fact about the code — it is a fact about
a moment. A cached "2 free runs left" promises something checkout will refuse.

This is not a correctness risk for the ledger. `redeemPromo` (`worker/src/db.ts`)
takes the use in one guarded UPDATE:

```sql
UPDATE promo_codes SET uses = uses + 1, product_uses = json_set(...)
 WHERE code = ?1 AND status = 'active' AND uses < max_uses
   AND (max_uses_per_product IS NULL
        OR coalesce(json_extract(product_uses,'$.'||?2),0) < max_uses_per_product)
```

D1 applies writes serially, so two machines racing on the last use cannot both
match; the loser changes zero rows. Persisting the code grants nothing a user
could not get by retyping it.

**The rule: the note is decoration, the quote is advice, the checkout is
truth.** Nothing on the run path may block on the balance endpoint answering.

## Architecture

### One pure function

In `worker/src/quote.ts`, beside `priceJob`:

```ts
export interface CodeBalance {
  code: string;
  maxWords: number | null;
  free: boolean;    // discount_pct === 100
  shared: boolean;  // max_uses_per_product IS NULL → one pool, any task
  runsLeft: Record<CloudProduct, number>;
}
export function codeBalance(row: PromoRow): CodeBalance;
```

`runsLeft` is resolved per product so no caller does arithmetic:

- shared: `max_uses - uses` for every product
- capped: `min(max_uses - uses, max_uses_per_product - product_uses[p])`

Both consumers below call this one function, so the card note and the price
cannot drift.

### Worker — two changes, one deploy, no schema change

- **`POST /v1/code`** — `{code}` in; `CodeBalance` out, or `{known: false}`.
  Joins the existing `rateLimitOk` gate beside `/v1/quote` and `/v1/checkout`.
  Unknown, expired, void and fully-spent codes all answer `{known: false}`
  identically, so the endpoint is no more of an oracle than quoting already is.
  Writes nothing — no `quotes` row.
- **`POST /v1/quote`** — the response gains the same `codeBalance` block when
  the code matched. `findPromo` already loads the row, so this costs nothing.

### Backend

- **`POST /api/cloud/code`** in `routes.ts`, proxying to the Worker exactly as
  `/cloud/estimate` does, behind the same `CLOUD_OFFER_SUSPENDED` 503.
- `/api/cloud/estimate` passes `codeBalance` through to the renderer.

### Store

```ts
promoCode: string             // added to the partialize allowlist — PERSISTED
codeBalance: CodeBalance|null // transient — never written to localStorage
```

### Refresh points

| when | call | extra cost |
|---|---|---|
| code typed (debounced) | `POST /api/cloud/code` | 1 |
| landing on the task step, incl. app start with a persisted code | `POST /api/cloud/code` | 1 |
| clicking Run | `POST /api/cloud/estimate` — already happens, now carries `codeBalance` | 0 |

The third overwrites the store's copy, so a stale card note is corrected
before the author pays.

## Deliberate limits

- **Only free codes get a note** (`discount_pct === 100`). "3 free runs left"
  on a half-price code is a lie, and pricing four cards to render four
  discounted figures is the work this design exists to avoid. A partial
  discount keeps today's behaviour: struck-through price at quote time.
- **Nothing renders on an unhappy card.** Exhausted product, spent pool,
  manuscript over the word cap, no code, code not free — all silent. The
  over-cap case is still explained by today's `codeRejectedReason` under the
  code box, on the card the author actually tries.

## Copy

`FrontCard → CloudProduct` is a four-line mapper (`language → enhance`; the
rest identity). Singular and plural are separate i18n keys in all four
languages. `maxWords: null` drops the "up to N words" clause rather than
printing "up to null".

## Failure modes

| case | behaviour |
|---|---|
| Worker unreachable / offline | no note; cards exactly as today |
| Worker not yet deployed (404) | no note — the app must never depend on the field |
| `CLOUD_OFFER_SUSPENDED` → 503 | treated as unreachable |
| code spent on another machine | Run's quote returns `runsLeft: 0` and full price; `codeRejectedReason` explains; `redeemPromo` refuses regardless |
| malformed or partial response | treated as unknown |

## Deploy order is load-bearing

**Worker first, then the app.** Reversed, `/v1/code` 404s and the notes
silently never appear. No D1 migration is needed — this reads columns that
already exist.

## Tests

Two pure functions carry the logic, and neither needs a browser.

- `worker/test/codeBalance.test.ts` — shared pool, per-product cap,
  pre-seeded exhaustion (the live `SCAN2X200K` shape), spent, expired, and a
  50%-off code returning `free: false`. Fixtures are the real production rows.
- `backend/test/codeBalanceNote.test.ts` — imports
  `frontend/src/codeBalanceNote.ts` directly, as `textLocate.test.ts` already
  reaches across packages, and pins balance → copy: plural vs singular,
  shared vs per-card, `maxWords: null`, and the `runsLeft: 0` silences.
- An i18n guard test that the new keys exist in all four languages, in the
  shape of the `scan_check_*` guard.

## Not building

Partial-discount notes, a code box on the task step, expiry countdowns, any
local cache of the count.
