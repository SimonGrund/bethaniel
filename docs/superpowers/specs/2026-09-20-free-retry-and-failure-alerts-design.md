# Free retry and failure alerts

**Date:** 2026-09-20
**Status:** approved, not yet implemented

## Why

A customer reported a translation that arrived with only the first chapter
translated, and an export that took minutes. Both faults are fixed (v2.22.1),
but the investigation exposed the shape of the problem rather than just the
instance:

- When a chunk fails, the pipeline pushes the **source** text into the output
  and moves on. One bad roll of the dice costs the author a chapter.
- There is no second attempt at chunk level. `retryPolicy.ts` retries whole
  chapters, but only for local engine faults (crash, unreachable, timeout, port
  conflict) — not for API faults, and not for bad model output.
- Nobody is told. A paying cloud customer hits this and Bethaniel learns about
  it only if they write in.

There are real paying customers now, so a single flaky response should not
reach an author, and when one does reach them Bethaniel should already know.

## What this is not

Not a general resilience project. Three narrow changes: retry a failed chunk
once, let that retry fit in the budget, and report it when it fails twice.

## Decisions

Settled during design; recorded so the reasoning is not relitigated.

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Retry scope | The failed **chunk**, in place | Whole chapter — throws away good chunks and re-translates them. Both layers — two retry paths to reason about for no measured gain. |
| What qualifies | Transient faults **and** bad output | Everything-but-cancel — a customer with an expired card waits through a pointless second attempt. Transient-only — misses the flaky-output case, which is the one a retry actually fixes. |
| Budget | Flat 20% overdraft on the credential ceiling | Skip-the-retry — hands the author the broken result the retry existed to prevent. Raise `TOKEN_BUDGET_HEADROOM` to 1.8 — every job reserves more than it needs. |
| Alert scope | Cloud jobs only | Local opt-in — a consent UI and a reporting path with no credential behind it. Always-report — sends data off the machine for local jobs, contradicting the product's core privacy claim. |
| Alert content | Classified diagnostics, no text | Plus an excerpt — the repo is public, so this would publish part of a paying author's unpublished book. Plus email — personal data in a public issue tracker. |
| Alert timing | Hourly, on the existing sweep | Immediate webhook — more moving parts and a new secret; add it only if an hour proves too slow. |

### Measured context

Three real Betty in the Cloud translations (GLM-5.2, 19 September 2026):

| Job | Estimate | Budget (1.5x) | Spent | % of budget |
|---|---|---|---|---|
| 4 ch / 1,080 w | 18,427 | 27,641 | 17,628 | 63% |
| 2 ch / 5,229 w | 63,245 | 94,868 | 75,009 | 79% |
| 6 ch / 15,749 w | 190,415 | 285,623 | 223,690 | 78% |

Actual spend is a stable ~117% of estimate and does not degrade with size. The
1.5x headroom absorbs that comfortably; it cannot absorb a whole-job re-run
(200%), which is a second reason the retry is scoped to the chunk.

## Part 1 — Chunk retry

**Files:** `backend/src/retryPolicy.ts`, `backend/src/queue.ts`

`retryPolicy.ts` gains one pure, dependency-free function beside the existing
`isRetryableHint` and `isRateLimitError`:

```ts
export function shouldRetryChunk(err: unknown): boolean
```

| Retried once | Fails immediately |
|---|---|
| network / socket faults | `ApiAccountError` (402 no credit, 401 bad key) |
| HTTP 5xx | abort / cancellation |
| timeouts and stalls | context-too-large |
| `draftGuard` rejections (empty, echoed, truncated) | |

In `queue.ts` the per-chunk body is wrapped so that a retryable failure logs,
waits a short backoff, and runs the chunk once more. A second failure falls
back exactly as today: source text into `pieces`, reason into `errors`, task
ends `error`.

### The seed is load-bearing

`deriveSeed(mode, job.name, j, "rewrite", attempt)` already takes `attempt`.
The retry MUST pass `attempt + 1`. With the same seed a deterministic model
reproduces the same empty or echoed response, and the retry is pure waste —
which is exactly the failure class being retried. A test pins this: two
attempts must derive different seeds.

### 429 stays out

Rate limits are already absorbed by `isRateLimitError` plus backoff. A 429 is
pacing, not failure; counting it here would spend the one retry on a queue that
was going to clear by itself.

## Part 2 — Budget overdraft

**File:** `worker/src/ledger.ts`

The ledger computes availability in exactly one place:

```js
const available = this.ledger.budgetTotal - this.ledger.reserved - this.ledger.spent;
```

It becomes:

```js
const ceiling = Math.ceil(this.ledger.budgetTotal * (1 + OVERDRAFT_FRACTION));
const available = ceiling - this.ledger.reserved - this.ledger.spent;
```

with `OVERDRAFT_FRACTION = 0.2`.

**Why a flat lift rather than a retry-only allowance.** The Worker proxies
inference calls; it has no concept of a job, a chapter or a retry. Any
"this is a retry" signal would be a client-asserted header, which is not a
gate. A flat cap needs no signal, cannot be forged, and is only ever reached by
a job that overran — retry or not. It also rescues a job stranded by a low
estimate, which is the same customer-facing failure.

**Exposure.** Worst case per credential rises 20%. `DAILY_TOKEN_CEILING` is
unchanged, so Bethaniel's total daily exposure is unchanged. Given measured
spend at 63–79% of budget, the overdraft should rarely be touched.

## Part 3 — Failure reporting

**Files:** `worker/schema.sql`, `worker/src/db.ts`, `worker/src/index.ts`,
`backend/src/queue.ts`

### Table

```sql
CREATE TABLE IF NOT EXISTS job_failures (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  product TEXT NOT NULL,
  unit_label TEXT,                 -- "Chapter 3", chunk "2/4"
  reason TEXT NOT NULL,            -- closed enum, see below
  attempts INTEGER NOT NULL,
  tokens_spent INTEGER,
  token_budget INTEGER,
  created_at TEXT NOT NULL,
  reported_at TEXT                 -- NULL until a sweep has raised it
);
CREATE INDEX IF NOT EXISTS idx_failures_unreported ON job_failures(reported_at);
```

An existing deployment needs this table created before a Worker that writes to
it is deployed, the same ordering constraint the README already records for
`promo_codes`.

### Endpoint

`POST /v1/failure`, authenticated by the credential token exactly as the proxy
is. Body: `{unitLabel, reason, attempts}`. The Worker supplies
`credential_id`, `product`, spend and budget from its own records — the client
is not trusted for any of them.

Rate-limited per credential (20 rows) so a pathological job cannot fill the
table; past the cap it 204s and drops the row rather than erroring, because a
failure report must never be the thing that fails a job.

### `reason` is a closed enum

`empty_output` | `echoed_source` | `truncated` | `network` | `provider_5xx` |
`timeout` | `other`

Anything unrecognised is stored as `other`. This is deliberate and is the whole
privacy design: error strings routinely embed the text that caused them, so a
free-text field would eventually carry a fragment of a paying author's
unpublished manuscript into the alert.

**`SimonGrund/bethaniel` is a public repository.** Its issues are world-readable
and indexed. A leaked excerpt would not be an internal mistake — it would
publish part of a customer's unpublished book. A closed enum makes that
structurally impossible rather than merely unlikely, which is the only standard
worth holding here. The same reasoning bars the Stripe customer email.

### Admin surface

`GET /admin/failures` — unreported rows, behind the existing `ADMIN_TOKEN`.
`POST /admin/failures/ack` — marks rows reported. Both mirror the shape of the
existing `/admin/refunds` and `/admin/refund`.

## Part 4 — Alerting and email

**File:** `.github/workflows/cloud-sweep.yml`

The sweep gains a step beside the existing refund-review step: fetch
`/admin/failures`; if there are unreported rows, open or update an issue
labelled `job-failure`; then ack them. It auto-closes when the queue empties,
exactly as the refund issue does.

### Fixing the email gap

GitHub emails a user about issues they are **assigned to** or **participating
in**. The current refund step does:

```bash
gh issue edit "$existing" --body-file body.md
```

**A body edit generates no notification.** So today Simon is emailed once, when
the refund issue is first opened, and never again — every later refund silently
rewrites a body nobody is told about. This is a live gap in the refund flow, not
just a concern for the new one.

Both flows change to:

1. `gh issue create --assignee SimonGrund …` — assignment notifies.
2. On update, still edit the body (so the issue always shows current state)
   **and** post a comment when the count has changed — comments notify.
3. Comment only on a change, never every hour. An issue that emails hourly
   regardless becomes a filter rule, and then the one that mattered is missed
   too.

No SMTP secret and no new integration: this is ordinary GitHub notification
behaviour, driven by assignment and participation.

## Part 5 — What the customer sees

- **Retry is quiet.** An engine-log line, and the phase reads
  `retrying chunk 2/4`. If it succeeds the run is otherwise unchanged and the
  author never learns anything happened.
- **Second failure** behaves as today — the chapter goes red and the
  all-done gate keeps a half-finished book from being exported — with a message
  saying it was attempted twice and that Bethaniel has been notified. One new
  i18n string, translated into the five supported languages.

## Testing

| Scope | Test |
|---|---|
| `retryPolicy.ts` | Classification table for `shouldRetryChunk`: each retryable and each hopeless class. Pure, no network. |
| Seed | Attempts 1 and 2 derive different seeds — the guard against a deterministic repeat. |
| Pipeline | The stub OpenAI-compatible server built during the v2.22.1 investigation drives the **real** queue. Program it to fail once then succeed; assert the chapter comes out translated, the task ends `done`, and one retry is logged. Then program it to fail twice; assert `error` and one `/v1/failure` call. |
| `worker/` | Ledger stops at exactly `budgetTotal * 1.2`. `/v1/failure` rejects a bad token, enforces the per-credential cap, and coerces an unknown reason to `other`. |
| Sweep | `/admin/failures` shape and ack idempotency. |

## Risks

- **Latency.** A failing chunk now takes roughly twice as long to give up.
  Bounded at one extra attempt.
- **`draftGuard` false positives** cost a retry instead of failing fast. Its
  length threshold is deliberately loose (40%) for this reason.
- **Overdraft** raises per-credential exposure 20%; daily total is unchanged.
- **Alert volume** is unknown until it runs. If the `job-failure` issue becomes
  noisy, that is information about reliability, not a reason to mute it.

## Out of scope

- Immediate (sub-hour) alerting via webhook. Revisit if hourly proves too slow.
- Local-job failure reporting.
- Retrying whole chapters on API faults — the chunk retry is the narrower fix;
  widen `RETRYABLE` only if evidence calls for it.
- The CLI writing an output file when every chapter failed. Real, separate,
  noted in the v2.22.1 report.
