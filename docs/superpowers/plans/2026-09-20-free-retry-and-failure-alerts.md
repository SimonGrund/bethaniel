# Free Retry and Failure Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retry a chunk whose model output is unusable, pay for that retry out of a 20% budget overdraft, and raise a GitHub issue when a chunk fails twice on a paid cloud job.

**Architecture:** Three independent slices. (1) `backend/` moves translation output validation inside the attempt ladder that already exists at `queue.ts:1916`, so a rejected draft is a failed *attempt* rather than a failed *chunk*. (2) `worker/` lifts the credential ledger's ceiling by a flat 20% and gains a `job_failures` table with a `POST /v1/failure` endpoint. (3) `.github/workflows/cloud-sweep.yml` reports those failures as a GitHub issue and fixes a live notification bug in the existing refund step.

**Tech Stack:** TypeScript, Node's built-in `node:test` via the `tsx` loader (backend), Cloudflare Workers + D1 + Durable Objects (worker), `gh` CLI in GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-20-free-retry-and-failure-alerts-design.md`

## Global Constraints

- **Never put manuscript text in a failure report.** `reason` is a closed enum; anything unrecognised becomes `other`. `SimonGrund/bethaniel` is a public repo — a leaked excerpt publishes a customer's unpublished book.
- **Never put the Stripe customer email in a failure report**, for the same reason.
- Backend tests run with `cd backend && npm test` (node:test via tsx, `test/**/*.test.ts`). No new dependencies.
- Worker tests run with `cd worker && npm test`.
- Backend must typecheck: `cd backend && npm run build` (runs `tsc`).
- Comments explain *why*, matching the surrounding prose style. Do not add comments that restate the code.
- Do **not** push to `main` during implementation — any push to main cuts a release. Commit locally; the human decides when to release.
- A failure report must never be the thing that fails a job. Every reporting call is best-effort and swallowed.

---

### Task 1: `DraftRejectedError` and the retry-limit classifier

Pure, dependency-free classification. Nothing wired up yet.

**Files:**
- Modify: `backend/src/retryPolicy.ts` (add `DraftRejectedError` and `chunkRetryLimit`)
- Test: `backend/test/retryPolicy.test.ts`

> **Revised during execution.** An earlier draft put `DraftRejectedError` in
> `translationUpgrade.ts` and had `retryPolicy.ts` import it. That breaks a
> stated property of the module — `retryPolicy.ts` has zero imports and its
> header says it is "pure and dependency-free so the policy can be tested on
> its own" — and a runtime import would have pulled the whole upgrade
> orchestrator in behind it. The error is a retry-classification concern, so it
> lives here; `draftGuard` keeps returning `{ok, reason}` and is not touched.

**Interfaces:**
- Consumes: `isRateLimitError` (already exported from `backend/src/retryPolicy.ts`), `ApiAccountError` (already exported from `backend/src/llm.ts`).
- Produces:
  - `class DraftRejectedError extends Error` with `readonly reason: string`, exported from `backend/src/translationUpgrade.ts`.
  - `function chunkRetryLimit(err: unknown, isTransient: boolean): number`, exported from `backend/src/retryPolicy.ts`. Returns the **total** number of attempts permitted for that error class: `2` for a draft rejection, `5` for a transient fault, `1` otherwise.

Note `isTransient` is passed in rather than computed. `isTransientFetchError` is a private function in `queue.ts`; passing its result keeps `retryPolicy.ts` free of that dependency and keeps the function pure.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/retryPolicy.test.ts`:

```ts
import { chunkRetryLimit } from "../src/retryPolicy.ts";
import { DraftRejectedError } from "../src/translationUpgrade.ts";
import { ApiAccountError } from "../src/llm.ts";

// ── How many goes each kind of failure gets ──
// A network fault costs a failed socket, so it can afford five. A rejected
// draft costs a whole re-translation of the chunk, so it gets one retry and
// no more — the ceiling the customer was promised, and the one that keeps a
// flaky model from eating a paid budget.

test("chunkRetryLimit: a rejected draft gets exactly one retry", () => {
  assert.equal(chunkRetryLimit(new DraftRejectedError("empty translation output"), false), 2);
});

test("chunkRetryLimit: a transient fault keeps the full network ladder", () => {
  assert.equal(chunkRetryLimit(new Error("fetch failed"), true), 5);
});

test("chunkRetryLimit: a draft rejection is capped even if also transient", () => {
  // Defensive: the output ceiling must win, or a mis-set flag buys five
  // re-translations of the same chunk.
  assert.equal(chunkRetryLimit(new DraftRejectedError("empty translation output"), true), 2);
});

test("chunkRetryLimit: no credit is not retried", () => {
  assert.equal(chunkRetryLimit(new ApiAccountError(402, "Insufficient Balance"), false), 1);
});

test("chunkRetryLimit: an unknown error is not retried", () => {
  assert.equal(chunkRetryLimit(new Error("context length exceeded"), false), 1);
});

test("DraftRejectedError carries its reason for the failure report", () => {
  const err = new DraftRejectedError("echoed source");
  assert.equal(err.reason, "echoed source");
  assert.equal(err.name, "DraftRejectedError");
  assert.ok(err instanceof Error);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx tsx --test test/retryPolicy.test.ts`
Expected: FAIL — `chunkRetryLimit` and `DraftRejectedError` are not exported.

- [ ] **Step 3: Add `DraftRejectedError`**

In `backend/src/translationUpgrade.ts`, directly above `export function draftGuard`:

```ts
/**
 * A draft translation that `draftGuard` refused.
 *
 * A distinct type because the chunk loop has to tell it apart from a failed
 * request: the request succeeded, and what came back was unusable. That
 * distinction sets how many more goes it gets — a socket fault is cheap to
 * retry, a re-translation is not.
 */
export class DraftRejectedError extends Error {
  constructor(public readonly reason: string) {
    super(`translation rejected: ${reason}`);
    this.name = "DraftRejectedError";
  }
}
```

- [ ] **Step 4: Add `chunkRetryLimit`**

In `backend/src/retryPolicy.ts`, append:

```ts
import { DraftRejectedError } from "./translationUpgrade.js";

/** Total attempts allowed for a chunk whose model output was unusable. */
export const MAX_OUTPUT_ATTEMPTS = 2;

/** Total attempts allowed for a chunk that failed to reach the model at all. */
export const MAX_TRANSIENT_ATTEMPTS = 5;

/**
 * How many times in total this chunk may be attempted, given what went wrong.
 *
 * Two ceilings, not one. A transient fetch fault costs a failed socket, so it
 * can afford the full ladder. A rejected draft costs a complete
 * re-translation of the chunk — real tokens against a budget the author has
 * already paid for — so it gets one retry and then tells the truth.
 *
 * A number rather than a boolean so both ceilings live here instead of
 * spreading `instanceof` checks through the chunk loop's catch.
 *
 * `isTransient` is supplied by the caller: the classifier that knows the
 * network signatures lives in queue.ts, and importing it here would drag the
 * queue into a module that is deliberately pure.
 */
export function chunkRetryLimit(err: unknown, isTransient: boolean): number {
  // Checked before the transient test on purpose. If a rejection ever also
  // matches a network signature, the cheaper ceiling must still win.
  if (err instanceof DraftRejectedError) return MAX_OUTPUT_ATTEMPTS;
  if (isTransient) return MAX_TRANSIENT_ATTEMPTS;
  return 1;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx tsx --test test/retryPolicy.test.ts`
Expected: PASS, all six new tests.

- [ ] **Step 6: Verify no import cycle**

`retryPolicy.ts` now imports from `translationUpgrade.ts`. Confirm `translationUpgrade.ts` does not import `retryPolicy.ts`.

Run: `cd backend && grep -n "retryPolicy" src/translationUpgrade.ts; npm run build`
Expected: no grep output, and `tsc` completes silently.

- [ ] **Step 7: Commit**

```bash
git add backend/src/retryPolicy.ts backend/src/translationUpgrade.ts backend/test/retryPolicy.test.ts
git commit -m "feat(retry): tell a bad answer apart from a failed request"
```

---

### Task 2: Validate the draft inside the attempt ladder

The behavioural change. A rejected draft now re-rolls instead of ending the chunk.

**Files:**
- Modify: `backend/src/queue.ts` (the attempt loop's break at ~2342, its catch at ~2344, and the translate branch at ~2616)
- Test: `backend/test/seedVariation.test.ts` (create)

**Interfaces:**
- Consumes: `DraftRejectedError`, `chunkRetryLimit` (Task 1); `draftGuard` (already wired into `queue.ts`); `deriveSeed` (already imported in `queue.ts` from `./llm.js`).
- Produces: no new exports. Behaviour only.

**Background — read before editing.** `queue.ts:1916` runs `for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++)`. The loop breaks on success at `lastErr = null; break;` (~line 2342) the moment the **stream finishes**. Everything that inspects what the model *said* — including the `draftGuard` call added in v2.22.1 — runs *after* the loop, so a successful request returning rubbish currently falls through to the outer `catch` and loses the chunk. This task moves that judgement inside the loop.

- [ ] **Step 1: Write the failing test**

Create `backend/test/seedVariation.test.ts`:

```ts
// The retry is only worth running if it asks a different question. With a
// fixed seed a deterministic model reproduces the same empty or echoed
// response, and a retry costs a full re-translation to arrive back where it
// started. The chunk loop passes `attempt` into the seed for exactly this
// reason; this pins it so it cannot be quietly dropped.

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveSeed } from "../src/llm.ts";

test("a retried chunk asks with a different seed", () => {
  const first = deriveSeed("translate", "Chapter 1", 0, "rewrite", 1);
  const second = deriveSeed("translate", "Chapter 1", 0, "rewrite", 2);
  assert.notEqual(first, second);
});

test("the same attempt derives the same seed — runs stay reproducible", () => {
  assert.equal(
    deriveSeed("translate", "Chapter 1", 0, "rewrite", 1),
    deriveSeed("translate", "Chapter 1", 0, "rewrite", 1),
  );
});

test("different chunks of one chapter do not collide", () => {
  assert.notEqual(
    deriveSeed("translate", "Chapter 1", 0, "rewrite", 1),
    deriveSeed("translate", "Chapter 1", 1, "rewrite", 1),
  );
});
```

- [ ] **Step 2: Run it**

Run: `cd backend && npx tsx --test test/seedVariation.test.ts`
Expected: PASS immediately — `deriveSeed` already varies by attempt. This test is a regression guard for Task 2's edit, not a red test. Commit it now so the guard exists *before* the loop is touched.

- [ ] **Step 3: Commit the guard**

```bash
git add backend/test/seedVariation.test.ts
git commit -m "test(retry): pin that a retried chunk re-rolls its seed"
```

- [ ] **Step 4: Import the new helpers in `queue.ts`**

Find the existing import at `backend/src/queue.ts:113-114`:

```ts
  shouldAutoRetry,
  MAX_AUTO_ATTEMPTS,
```

Add `chunkRetryLimit` to that same import block from `./retryPolicy.js`, so it reads:

```ts
  shouldAutoRetry,
  MAX_AUTO_ATTEMPTS,
  chunkRetryLimit,
```

Find the existing import at `backend/src/queue.ts:81`:

```ts
import { draftGuard, runTranslationUpgrade } from "./translationUpgrade.js";
```

Change to:

```ts
import {
  DraftRejectedError,
  draftGuard,
  runTranslationUpgrade,
} from "./translationUpgrade.js";
```

- [ ] **Step 5: Validate the draft before the loop breaks**

At `backend/src/queue.ts` ~2342, find:

```ts
            lastErr = null;
            break; // success
```

Replace with:

```ts
            // The stream finished, which is not the same as the model having
            // answered. For a translation, judge the draft HERE — inside the
            // ladder — so a rejected one is a failed attempt that re-rolls
            // with a fresh seed, not a failed chunk that ships the source
            // text. Everything downstream (the polish pass, the fluency
            // reviewer) is built on this draft, so nothing should be built
            // until it is worth building on.
            if (mode === "translate") {
              const check = draftGuard(chunk.body, acc.trim());
              if (!check.ok) throw new DraftRejectedError(check.reason);
            }
            lastErr = null;
            break; // success
```

- [ ] **Step 5b: Record how many attempts were actually made**

The outer `catch` is outside the `for`, so the loop counter is gone by the time
a failure is reported. Capture it.

At `backend/src/queue.ts:1915`, find:

```ts
        let lastErr: unknown = null;
```

Replace with:

```ts
        let lastErr: unknown = null;
        // The outer catch reports how many goes this chunk actually had, and
        // the loop variable is out of scope by then. Reporting the class
        // ceiling instead would put a number in the failure record that never
        // happened.
        attemptsMade = 0;
```

And declare it beside the other per-chunk variables at `backend/src/queue.ts:1899`
(next to `let acc = "";`):

```ts
      let attemptsMade = 0;
```

Then, inside the loop directly after `chunkPrompt = prompt;` (~line 1921), add:

```ts
          attemptsMade = attempt;
```

- [ ] **Step 6: Apply the two ceilings in the catch**

At `backend/src/queue.ts` ~2344, find:

```ts
          } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            if (!isTransientFetchError(err) || attempt === MAX_ATTEMPTS) {
              throw err;
            }
```

Replace with:

```ts
          } catch (err) {
            lastErr = err;
            const msg = err instanceof Error ? err.message : String(err);
            // Two ceilings: five goes at a failed socket, two at a bad answer.
            // A re-translation costs tokens the author has already paid for,
            // so it is allowed one retry and then has to be honest.
            const limit = chunkRetryLimit(err, isTransientFetchError(err));
            if (attempt >= limit) {
              throw err;
            }
```

Note `MAX_ATTEMPTS` remains declared at line 1914 and still bounds the `for`; `limit` is always `<= 5`, so the loop condition is never the binding constraint. Leave `MAX_ATTEMPTS` as is.

- [ ] **Step 7: Remove the now-duplicated guard from the translate branch**

At `backend/src/queue.ts` ~2616 (inside `if (mode === "translate") {`), find and **delete** this block, which Step 5 supersedes — the draft is now judged before the loop breaks, so this can only ever be a second call on text that already passed:

```ts
            // The draft is checked before anything is built on it. The
            // chunk loop's only failure path pushes the SOURCE text into the
            // output, so an empty or echoed-back draft used to leave an empty
            // or untranslated chapter on a task that finished "done" — a
            // finished-looking book with the source language still in it.
            // Raised as a chunk error instead, which is what it is.
            const draftCheck = draftGuard(chunk.body, rewritten);
            if (!draftCheck.ok) {
              throw new Error(
                `translation rejected for chunk ${chunkLabel}: ${draftCheck.reason}`,
              );
            }

```

- [ ] **Step 8: Typecheck and run the whole backend suite**

Run: `cd backend && npm run build && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tsc` silent; `fail 0`. The suite was 1091 tests / 1083 passing before this plan; it should now be higher and still `fail 0`.

- [ ] **Step 9: Prove it end-to-end against the real pipeline**

The v2.22.1 investigation used a stub OpenAI-compatible server to drive the real queue. Rebuild it to fail once, then succeed.

Create `backend/test/fixtures/flaky-stub.mjs`:

```js
// An OpenAI-compatible stub that returns an EMPTY completion for the first
// request and a real one thereafter. Proves the chunk retry end to end: the
// first draft is rejected, the second is accepted, and the chapter survives.
import http from "node:http";

let calls = 0;
const TRANSLATION = "Færgen holdt op med at sejle i oktober.\n\nHendes far var druknet under den.";

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls++;
      const out = calls === 1 ? "" : TRANSLATION;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const ch of out.match(/[\s\S]{1,40}/g) ?? [])
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: ch } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  })
  .listen(8799, () => console.log("flaky stub on 8799"));
```

Then, by hand:

```bash
cd backend
node test/fixtures/flaky-stub.mjs &
STUB=$!
mkdir -p /tmp/bethaniel-retry-check
printf '{ "apiKey": "stub", "model": "deepseek-chat", "baseUrl": "http://127.0.0.1:8799" }\n' \
  > /tmp/bethaniel-retry-check/api-config.json
printf '# Chapter 1\n\nThe ferry stopped running in October.\n\nHer father had drowned under it.\n' \
  > /tmp/bethaniel-retry-check/book.md
npx tsx src/cli.ts --model custom-deepseek --mode translation --language Danish \
  --input-doc /tmp/bethaniel-retry-check/book.md --export-format md \
  --out-dir /tmp/bethaniel-retry-check/out --data-dir /tmp/bethaniel-retry-check
kill $STUB
cat /tmp/bethaniel-retry-check/out/book.translation.md
```

Expected: the CLI reports **no** errors, and the output file is the Danish text — not the English source and not blank. Before this task the same stub produced a chapter that failed outright.

- [ ] **Step 10: Commit**

```bash
git add backend/src/queue.ts backend/test/fixtures/flaky-stub.mjs
git commit -m "feat(retry): a rejected draft re-rolls instead of losing the chapter"
```

---

### Task 3: Ledger overdraft

**Files:**
- Modify: `worker/src/ledger.ts`
- Test: `worker/test/ledger.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export const OVERDRAFT_FRACTION = 0.2` and `export function spendCeiling(budgetTotal: number): number` from `worker/src/ledger.ts`.

- [ ] **Step 1: Write the failing test**

Create `worker/test/ledger.test.ts`:

```ts
// The credential ceiling with its overdraft.
//
// A flat lift rather than a retry-only allowance because the Worker proxies
// inference calls and has no concept of a job, a chapter or a retry — any
// "this is a retry" signal would be a client-asserted header, which is not a
// gate. The cap is the guarantee, and only a job that overran ever reaches it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { OVERDRAFT_FRACTION, spendCeiling } from "../src/ledger.ts";

test("the overdraft is 20 per cent", () => {
  assert.equal(OVERDRAFT_FRACTION, 0.2);
});

test("a credential may spend a fifth beyond its budget, and not a token more", () => {
  assert.equal(spendCeiling(100_000), 120_000);
});

test("the ceiling rounds up, so a small budget still gets its overdraft", () => {
  assert.equal(spendCeiling(3), 4);
});

test("a zero budget stays zero — an unfunded credential buys nothing", () => {
  assert.equal(spendCeiling(0), 0);
});
```

- [ ] **Step 2: Run it**

Run: `cd worker && npx tsx --test test/ledger.test.ts`
Expected: FAIL — `OVERDRAFT_FRACTION` and `spendCeiling` are not exported.

If `npx tsx --test` is not how this package runs tests, match `worker/package.json`'s `test` script instead and use that runner throughout Tasks 3–4.

- [ ] **Step 3: Implement**

In `worker/src/ledger.ts`, above the `CredentialLedger` class:

```ts
/**
 * How far past its budget a credential may spend.
 *
 * The budget is already the estimate times TOKEN_BUDGET_HEADROOM, and measured
 * runs land at 63-79% of it — so this is rarely touched. It exists for the job
 * that overran: without it a chunk retry late in a nearly-spent credential is
 * refused, and the author gets exactly the broken result the retry was added
 * to prevent. They have paid a flat band price; absorbing a bounded token
 * overrun is cheaper than a refund and far cheaper than a bad review.
 *
 * Flat rather than retry-only on purpose. This Worker sees inference calls,
 * not jobs, so a "this is a retry" flag could only come from the client, and
 * a client-asserted privilege is not a control. The cap is the control.
 *
 * DAILY_TOKEN_CEILING is unchanged, so total exposure is unchanged — this
 * moves the per-credential bound only.
 */
export const OVERDRAFT_FRACTION = 0.2;

/** The most a credential may ever spend, budget plus overdraft. */
export function spendCeiling(budgetTotal: number): number {
  return Math.ceil(budgetTotal * (1 + OVERDRAFT_FRACTION));
}
```

Then find the single availability computation in the `/reserve` handler (`worker/src/ledger.ts` ~line 177):

```ts
      const available =
        this.ledger.budgetTotal - this.ledger.reserved - this.ledger.spent;
```

Replace with:

```ts
      const available =
        spendCeiling(this.ledger.budgetTotal) -
        this.ledger.reserved -
        this.ledger.spent;
```

- [ ] **Step 4: Update the status handler to match**

At `worker/src/ledger.ts` ~line 227 the status response reports remaining budget using the same subtraction. Find:

```ts
          this.ledger.budgetTotal - this.ledger.reserved - this.ledger.spent,
```

Replace with:

```ts
          spendCeiling(this.ledger.budgetTotal) -
          this.ledger.reserved -
          this.ledger.spent,
```

Leaving this one un-updated would make `/status` disagree with what `/reserve` actually allows, which is exactly the kind of drift that makes a ledger untrustworthy.

- [ ] **Step 5: Run tests**

Run: `cd worker && npx tsx --test test/ledger.test.ts && npm test`
Expected: the four new tests PASS, and the existing worker suite still passes.

- [ ] **Step 6: Commit**

```bash
git add worker/src/ledger.ts worker/test/ledger.test.ts
git commit -m "feat(cloud): a fifth of overdraft, so a retry is never refused for want of budget"
```

---

### Task 4: `job_failures` table and `POST /v1/failure`

**Files:**
- Modify: `worker/schema.sql`
- Modify: `worker/src/db.ts`
- Modify: `worker/src/index.ts`
- Test: `worker/test/failureReason.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export const FAILURE_REASONS: readonly string[]` and `export function coerceFailureReason(raw: unknown): string` from `worker/src/db.ts`.
  - `export async function recordJobFailure(env, row): Promise<boolean>` from `worker/src/db.ts`, returning `false` when the per-credential cap is reached.
  - `export async function listUnreportedFailures(env)` and `export async function ackFailures(env, ids: string[])` from `worker/src/db.ts`.
  - `POST /v1/failure`, `GET /admin/failures`, `POST /admin/failures/ack` on the Worker.

- [ ] **Step 1: Write the failing test**

Create `worker/test/failureReason.test.ts`:

```ts
// The closed enum is the whole privacy design.
//
// Error strings routinely embed the text that caused them. SimonGrund/bethaniel
// is a public repository, so a free-text reason would eventually publish a
// fragment of a paying author's unpublished book, world-readable and indexed.
// Anything unrecognised collapses to "other" — the failure is still counted,
// the words never travel.

import { test } from "node:test";
import assert from "node:assert/strict";

import { coerceFailureReason, FAILURE_REASONS } from "../src/db.ts";

test("every known reason survives unchanged", () => {
  for (const r of FAILURE_REASONS) assert.equal(coerceFailureReason(r), r);
});

test("an unknown reason collapses to other", () => {
  assert.equal(coerceFailureReason("kaboom"), "other");
});

test("a reason carrying manuscript text collapses to other", () => {
  assert.equal(
    coerceFailureReason('translation rejected: "The ferry stopped running in October"'),
    "other",
  );
});

test("a non-string collapses to other", () => {
  assert.equal(coerceFailureReason(null), "other");
  assert.equal(coerceFailureReason(42), "other");
  assert.equal(coerceFailureReason({ reason: "empty_output" }), "other");
});

test("the enum is exactly the seven agreed reasons", () => {
  assert.deepEqual([...FAILURE_REASONS].sort(), [
    "echoed_source",
    "empty_output",
    "network",
    "other",
    "provider_5xx",
    "timeout",
    "truncated",
  ]);
});
```

- [ ] **Step 2: Run it**

Run: `cd worker && npx tsx --test test/failureReason.test.ts`
Expected: FAIL — `coerceFailureReason` is not exported.

- [ ] **Step 3: Add the schema**

Append to `worker/schema.sql`:

```sql
-- Chunks that failed twice on a paid job. Diagnostics only: `reason` is a
-- closed enum (see coerceFailureReason in src/db.ts) because this table feeds
-- a GitHub issue on a PUBLIC repository, and a free-text error string
-- eventually carries a fragment of the manuscript that caused it.
CREATE TABLE IF NOT EXISTS job_failures (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  product TEXT NOT NULL,
  unit_label TEXT,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  tokens_spent INTEGER,
  token_budget INTEGER,
  created_at TEXT NOT NULL,
  reported_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_failures_unreported
  ON job_failures(reported_at);
CREATE INDEX IF NOT EXISTS idx_failures_credential
  ON job_failures(credential_id);
```

- [ ] **Step 4: Implement the db helpers**

Append to `worker/src/db.ts`:

```ts
/**
 * Every reason a failure report may carry.
 *
 * Closed on purpose, and this is the privacy control rather than a tidiness
 * one: these rows are rendered into a GitHub issue on a public repository, and
 * a free-text field fed by error messages will eventually carry the text that
 * caused the error — a customer's unpublished prose.
 */
export const FAILURE_REASONS = [
  "empty_output",
  "echoed_source",
  "truncated",
  "network",
  "provider_5xx",
  "timeout",
  "other",
] as const;

/** Anything not on the list becomes "other". The count survives; the words do not. */
export function coerceFailureReason(raw: unknown): string {
  return typeof raw === "string" && (FAILURE_REASONS as readonly string[]).includes(raw)
    ? raw
    : "other";
}

/** The products a job can be, mirroring CloudProduct in the app's cloudEstimate.ts. */
export const FAILURE_PRODUCTS = [
  "edit",
  "readthrough",
  "translate",
  "enhance",
  "unknown",
] as const;

/**
 * Coerce the client's product label.
 *
 * The credentials table has no product column — product is a property of the
 * quote — so the client names it. Closed for the same reason as the reason
 * enum: a client-supplied string must never be able to become free text in a
 * public issue, however harmless this particular one looks.
 */
export function coerceProduct(raw: unknown): string {
  return typeof raw === "string" && (FAILURE_PRODUCTS as readonly string[]).includes(raw)
    ? raw
    : "unknown";
}

/**
 * How many failures one credential may file.
 *
 * A job that fails every chunk of a long book would otherwise write a row per
 * chunk, and the twentieth adds nothing the first told us.
 */
export const MAX_FAILURES_PER_CREDENTIAL = 20;

export interface JobFailureRow {
  credentialId: string;
  product: string;
  unitLabel: string | null;
  reason: string;
  attempts: number;
  tokensSpent: number | null;
  tokenBudget: number | null;
}

/** Record one failure. Returns false once this credential has filed enough. */
export async function recordJobFailure(
  env: Env,
  row: JobFailureRow,
): Promise<boolean> {
  const seen = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM job_failures WHERE credential_id = ?`,
  )
    .bind(row.credentialId)
    .first<{ n: number }>();
  if ((seen?.n ?? 0) >= MAX_FAILURES_PER_CREDENTIAL) return false;

  await env.DB.prepare(
    `INSERT INTO job_failures
       (id, credential_id, product, unit_label, reason, attempts,
        tokens_spent, token_budget, created_at, reported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      crypto.randomUUID(),
      row.credentialId,
      row.product,
      row.unitLabel,
      coerceFailureReason(row.reason),
      row.attempts,
      row.tokensSpent,
      row.tokenBudget,
      new Date().toISOString(),
    )
    .run();
  return true;
}

/** Failures no sweep has raised yet. */
export async function listUnreportedFailures(env: Env) {
  const res = await env.DB.prepare(
    `SELECT id, credential_id, product, unit_label, reason, attempts,
            tokens_spent, token_budget, created_at
       FROM job_failures
      WHERE reported_at IS NULL
      ORDER BY created_at ASC
      LIMIT 200`,
  ).all();
  return res.results ?? [];
}

/** Mark rows raised, so the next sweep does not report them again. */
export async function ackFailures(env: Env, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const marks = ids.map(() => "?").join(",");
  const res = await env.DB.prepare(
    `UPDATE job_failures SET reported_at = ?
      WHERE id IN (${marks}) AND reported_at IS NULL`,
  )
    .bind(new Date().toISOString(), ...ids)
    .run();
  return res.meta?.changes ?? 0;
}
```

- [ ] **Step 5: Add the endpoints**

In `worker/src/index.ts`, alongside the existing `/v1/*` routes (after the `/v1/credential` handler), add:

```ts
      if (url.pathname === "/v1/failure" && request.method === "POST") {
        // Authenticated exactly as the proxy is (see handleChatCompletions in
        // src/proxy.ts): bearer token -> hash -> credential row. Spend and
        // budget are read from our own record; the client is trusted only for
        // the chunk label, the reason and the product, and all three are
        // clamped or coerced below.
        const authHeader = request.headers.get("Authorization") ?? "";
        const match = /^Bearer\s+(.+)$/i.exec(authHeader);
        if (!match) return json({ error: "Unauthorized" }, 401);
        const credential = await findCredentialByTokenHash(
          env,
          await hashToken(match[1]),
        );
        if (!credential) return json({ error: "Unauthorized" }, 401);

        const body = (await request.json()) as {
          unitLabel?: unknown;
          reason?: unknown;
          attempts?: unknown;
          product?: unknown;
        };
        const unitLabel =
          typeof body.unitLabel === "string" ? body.unitLabel.slice(0, 80) : null;
        const attempts =
          typeof body.attempts === "number" && Number.isFinite(body.attempts)
            ? Math.max(1, Math.min(99, Math.trunc(body.attempts)))
            : 1;

        await recordJobFailure(env, {
          credentialId: credential.id,
          // The credentials table has no product column — product lives on the
          // quote, and a promo credential reaches it only through a synthetic
          // session id. Rather than join for a label, the client names its own
          // product and it is coerced to a closed set. A product name carries
          // no manuscript text, so there is nothing here worth a join.
          product: coerceProduct(body.product),
          unitLabel,
          reason: coerceFailureReason(body.reason),
          attempts,
          tokensSpent: credential.spent ?? null,
          tokenBudget: credential.token_budget ?? null,
        });
        // 204 whether it was stored or dropped at the cap. A failure report
        // must never become a second failure for the caller to handle.
        return new Response(null, { status: 204 });
      }
```

And with the other `/admin/*` routes:

```ts
        if (url.pathname === "/admin/failures" && request.method === "GET") {
          const rows = await listUnreportedFailures(env);
          return json({ count: rows.length, failures: rows });
        }

        if (url.pathname === "/admin/failures/ack" && request.method === "POST") {
          const { ids } = (await request.json()) as { ids?: string[] };
          const acked = await ackFailures(env, Array.isArray(ids) ? ids : []);
          return json({ ok: true, acked });
        }
```

Add to `worker/src/index.ts`'s imports:

```ts
import { hashToken } from "./crypto";
import {
  ackFailures,
  coerceFailureReason,
  coerceProduct,
  findCredentialByTokenHash,
  listUnreportedFailures,
  recordJobFailure,
} from "./db";
```

Several of these may already be imported — merge rather than duplicating. `findCredentialByTokenHash` and `hashToken` are the same pair `src/proxy.ts` uses at its lines 52–54; this is deliberately the identical auth path, not a second one.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd worker && npx tsx --test test/failureReason.test.ts && npm test`
Expected: five new tests PASS, existing worker suite still green.

- [ ] **Step 7: Commit**

```bash
git add worker/schema.sql worker/src/db.ts worker/src/index.ts worker/test/failureReason.test.ts
git commit -m "feat(cloud): record a twice-failed chunk, with no manuscript in it"
```

---

### Task 5: Report the failure from the backend

**Files:**
- Modify: `backend/src/queue.ts` (the outer chunk catch at ~2743)
- Create: `backend/src/cloudFailureReport.ts`
- Test: `backend/test/cloudFailureReport.test.ts`

**Interfaces:**
- Consumes: `DraftRejectedError` (Task 1); `POST /v1/failure` (Task 4).
- Produces: `export function failureReasonFor(err: unknown): string` and `export async function reportCloudFailure(opts): Promise<void>` from `backend/src/cloudFailureReport.ts`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/cloudFailureReport.test.ts`:

```ts
// Mapping a local error onto the Worker's closed enum. The mapping lives on
// this side so the Worker never has to parse an error string at all.

import { test } from "node:test";
import assert from "node:assert/strict";

import { failureReasonFor } from "../src/cloudFailureReport.ts";
import { DraftRejectedError } from "../src/translationUpgrade.ts";

test("an empty draft reports empty_output", () => {
  assert.equal(
    failureReasonFor(new DraftRejectedError("empty translation output")),
    "empty_output",
  );
});

test("an echoed source reports echoed_source", () => {
  assert.equal(
    failureReasonFor(
      new DraftRejectedError("untranslated — the source text came back unchanged"),
    ),
    "echoed_source",
  );
});

test("a short draft reports truncated", () => {
  assert.equal(
    failureReasonFor(
      new DraftRejectedError("translation too short (120/900 chars) — the chunk was probably truncated"),
    ),
    "truncated",
  );
});

test("a network fault reports network", () => {
  assert.equal(failureReasonFor(new Error("fetch failed")), "network");
});

test("a timeout reports timeout", () => {
  assert.equal(failureReasonFor(new Error("ETIMEDOUT")), "timeout");
});

test("a 500 reports provider_5xx", () => {
  assert.equal(failureReasonFor(new Error("upstream returned 503")), "provider_5xx");
});

test("anything else reports other — and never the message itself", () => {
  const reason = failureReasonFor(new Error('failed on "The ferry stopped running"'));
  assert.equal(reason, "other");
  assert.ok(!reason.includes("ferry"));
});
```

- [ ] **Step 2: Run it**

Run: `cd backend && npx tsx --test test/cloudFailureReport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `backend/src/cloudFailureReport.ts`:

```ts
// ── Telling Bethaniel that a paid chunk failed twice ──
//
// Cloud jobs only. Betty runs on the author's own machine and a local run has
// no credential, nowhere to report to, and no promise to keep — reporting one
// would mean sending text off a machine the product promises never sends text
// off. A cloud job already talks to the Worker, and the author has already
// paid, so the report is both possible and owed.
//
// Nothing here is allowed to fail a job. Every call is best-effort.

import { DraftRejectedError } from "./translationUpgrade.js";

/**
 * Map a local error onto the Worker's closed enum.
 *
 * Done on this side so the Worker never parses an error string, and so the
 * only thing that crosses the wire is one of seven known words. The message
 * itself is never sent: it can contain the manuscript that caused it, and the
 * issue it would land in is public.
 */
export function failureReasonFor(err: unknown): string {
  if (err instanceof DraftRejectedError) {
    const r = err.reason.toLowerCase();
    if (r.includes("empty")) return "empty_output";
    if (r.includes("untranslated")) return "echoed_source";
    if (r.includes("too short") || r.includes("truncat")) return "truncated";
    return "other";
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (msg.includes("etimedout") || msg.includes("timeout") || msg.includes("timed out"))
    return "timeout";
  if (/\b5\d\d\b/.test(msg)) return "provider_5xx";
  if (
    msg.includes("fetch failed") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("undici") ||
    msg.includes("epipe")
  )
    return "network";
  return "other";
}

export interface CloudFailureReport {
  /** Worker origin, e.g. https://bethaniel-cloud.cloudwatcher.workers.dev */
  baseUrl: string;
  /** The credential token — the same one the proxy authenticates with. */
  apiKey: string;
  /** "Chapter 3 · chunk 2/4". No manuscript text. */
  unitLabel: string;
  reason: string;
  attempts: number;
  /** "edit" | "readthrough" | "translate" | "enhance" — coerced Worker-side. */
  product: string;
}

/**
 * File one failure report. Swallows everything.
 *
 * A job that has already lost a chunk must not also fail because telling us
 * about it failed, so there is no error path out of here by design.
 */
export async function reportCloudFailure(opts: CloudFailureReport): Promise<void> {
  try {
    await fetch(`${opts.baseUrl}/v1/failure`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        unitLabel: opts.unitLabel,
        reason: opts.reason,
        attempts: opts.attempts,
        product: opts.product,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* best effort — see the note above */
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd backend && npx tsx --test test/cloudFailureReport.test.ts`
Expected: all seven PASS.

- [ ] **Step 5: Wire it into the outer catch**

At `backend/src/queue.ts` ~2743, find:

```ts
      } catch (err) {
        pieces.push(chunk.core);
        errors.push(
          `chunk ${j + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
```

Replace with:

```ts
      } catch (err) {
        pieces.push(chunk.core);
        errors.push(
          `chunk ${j + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
        // The retries are spent and the author is getting source text where a
        // translation should be. On a paid cloud job, say so — this is the
        // only way Bethaniel learns a customer's run broke without them
        // writing in. Not awaited: the chapter's outcome does not depend on
        // it, and the report can never fail the job.
        void reportChunkFailureIfCloud(model, job, chunkLabel, err, attemptsMade);
      }
```

Then add the helper near the top of `backend/src/queue.ts`, below the imports:

```ts
/**
 * Report a twice-failed chunk, if this is a Betty in the Cloud job.
 *
 * Silent for local runs and for a user's own API key: neither has a Bethaniel
 * credential, and a local manuscript must never generate network traffic.
 */
async function reportChunkFailureIfCloud(
  model: string,
  job: JobData,
  chunkLabel: string,
  err: unknown,
  attempts: number,
): Promise<void> {
  const entry = getModelByFileName(model);
  if (entry?.id !== "bethaniel-cloud") return;
  const cfg = readApiConfig("bethaniel-cloud");
  if (!cfg?.apiKey) return;
  const baseUrl = cfg.baseUrl ?? entry.defaultBaseUrl;
  if (!baseUrl) return;
  await reportCloudFailure({
    baseUrl,
    apiKey: cfg.apiKey,
    // The chapter's NAME, never its text. Chapter names are the author's
    // words too, but they are already on the receipt and in the queue, and
    // without one the report cannot be matched to anything.
    unitLabel: `${job.name} · chunk ${chunkLabel}`,
    reason: failureReasonFor(err),
    attempts,
    product: job.mode === "translate" ? "translate" : "edit",
  });
}
```

Add to `backend/src/queue.ts`'s imports:

```ts
import { failureReasonFor, reportCloudFailure } from "./cloudFailureReport.js";
import { readApiConfig } from "./modelConfig.js";
```

`getModelByFileName` is already imported at `backend/src/queue.ts:110`
(`import { isApiModel, isCustomGgufModel, getModelByFileName } from "./modelCatalog.js";`)
— do not add a second import for it. Check whether `readApiConfig` is already
imported before adding it.

`ModelCatalogEntry.defaultBaseUrl` exists (`backend/src/modelCatalog.ts:31`) and
is optional, which is why the helper returns early when it is absent.

- [ ] **Step 6: Typecheck and run the full suite**

Run: `cd backend && npm run build && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: `tsc` silent, `fail 0`.

- [ ] **Step 7: Verify no report on a local job**

Re-run the Task 2 Step 9 stub check, but make the stub fail **every** time (change `calls === 1` to `true`). The model is `custom-deepseek`, not `bethaniel-cloud`, so no request must reach `/v1/failure`.

Confirm by watching the stub's own log: it should see only the translation attempts, and the run must complete (with errors) rather than hanging.

- [ ] **Step 8: Commit**

```bash
git add backend/src/cloudFailureReport.ts backend/src/queue.ts backend/test/cloudFailureReport.test.ts
git commit -m "feat(cloud): a twice-failed chunk tells Bethaniel, and says nothing about the book"
```

---

### Task 6: Raise the issue, and fix the refund email gap

**Files:**
- Modify: `.github/workflows/cloud-sweep.yml`

**Interfaces:**
- Consumes: `GET /admin/failures`, `POST /admin/failures/ack` (Task 4).
- Produces: nothing consumed by later tasks.

**Background.** GitHub emails a user about issues they are **assigned to** or **participating in**. The existing refund step calls `gh issue edit "$existing" --body-file body.md` on every later sweep, and **a body edit generates no notification** — so the refund queue has emailed Simon exactly once, when it first opened, and never since. Comments do notify. This task fixes that and applies the same pattern to the new failure issue.

- [ ] **Step 1: Assign the refund issue on creation**

In `.github/workflows/cloud-sweep.yml`, find:

```bash
                    gh issue create --label refund-review \
                      --title "Refunds awaiting a decision" --body-file body.md
```

Replace with:

```bash
                    # Assigned, because GitHub emails assignees and this queue
                    # is only useful if someone is told it has something in it.
                    gh issue create --label refund-review \
                      --assignee SimonGrund \
                      --title "Refunds awaiting a decision" --body-file body.md
```

- [ ] **Step 2: Comment when the refund count changes**

Find:

```bash
                  if [ -n "$existing" ]; then
                    gh issue edit "$existing" --body-file body.md
                    echo "updated issue #$existing"
```

Replace with:

```bash
                  if [ -n "$existing" ]; then
                    # The body always shows current state. But a body edit
                    # sends no notification, so on its own this queue grows in
                    # silence — which is how it has behaved until now. A
                    # comment notifies; gating on a CHANGE keeps it from
                    # emailing hourly and becoming a filter rule.
                    previous=$(gh issue view "$existing" --json body \
                      --jq '.body' | grep -oE '^<!-- count:[0-9]+ -->' \
                      | grep -oE '[0-9]+' || echo "")
                    printf '<!-- count:%s -->\n' "$count" | cat - body.md > body-stamped.md
                    mv body-stamped.md body.md
                    gh issue edit "$existing" --body-file body.md
                    if [ "$previous" != "$count" ]; then
                      gh issue comment "$existing" \
                        --body "Queue changed: now $count credential(s) awaiting a decision."
                    fi
                    echo "updated issue #$existing"
```

The `<!-- count:N -->` marker is an HTML comment: invisible when rendered, and it makes the previous count readable without a second API call or any new state.

- [ ] **Step 3: Stamp the count on creation too**

So the first update has something to compare against. Immediately before the `gh issue create --label refund-review` line from Step 1, add:

```bash
                    printf '<!-- count:%s -->\n' "$count" | cat - body.md > body-stamped.md
                    mv body-stamped.md body.md
```

- [ ] **Step 4: Add the failure-reporting step**

Append a new step to the `sweep` job, after "Raise anything waiting on a human":

```yaml
            - name: Raise chunks that failed twice
              env:
                  ADMIN_TOKEN: ${{ secrets.CLOUD_ADMIN_TOKEN }}
                  GH_TOKEN: ${{ github.token }}
                  GH_REPO: ${{ github.repository }}
              run: |
                  set -euo pipefail

                  # A chunk that failed twice on a PAID job. The author got
                  # source text where a translation should be, and this is the
                  # only way that fact reaches anyone without them writing in.
                  curl --silent --show-error --fail-with-body --max-time 60 \
                    "$WORKER/admin/failures" \
                    -H "Authorization: Bearer ${ADMIN_TOKEN}" > failures.json

                  count=$(jq -r '.count' failures.json)
                  echo "$count unreported failure(s)"
                  [ "$count" -eq 0 ] && exit 0

                  {
                    echo "These chunks failed twice on paid cloud jobs since the last"
                    echo "sweep. Each one is an author who received source text where a"
                    echo "translation should have been."
                    echo
                    echo "Diagnostics only — no manuscript text is recorded, deliberately."
                    echo "Find the customer via the credential id in Stripe."
                    echo
                    echo '```json'
                    jq '.failures' failures.json
                    echo '```'
                    echo
                    echo "reason values: empty_output and echoed_source mean the model"
                    echo "answered badly twice; truncated means the chunk hit the output"
                    echo "cap; network, provider_5xx and timeout point at the provider."
                  } > failures.md

                  gh label create job-failure --color D93F0B \
                    --description "A paid cloud chunk failed twice" 2>/dev/null || true

                  # A NEW issue each sweep that has failures, not one running
                  # issue: each batch is a distinct incident with its own
                  # customers, and creating it is what sends the email.
                  gh issue create --label job-failure --assignee SimonGrund \
                    --title "$count cloud chunk(s) failed twice" --body-file failures.md

                  jq -r '[.failures[].id]' failures.json > ids.json
                  curl --silent --show-error --fail-with-body --max-time 60 \
                    -X POST "$WORKER/admin/failures/ack" \
                    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
                    -H "Content-Type: application/json" \
                    -d "{\"ids\": $(cat ids.json)}"
```

Note the ack runs **after** the issue is created, so a failure to raise the issue leaves the rows unreported and the next sweep tries again. Losing a report is worse than sending it twice.

- [ ] **Step 5: Lint the workflow**

Run: `cd /Users/simon/code/Bethaniel && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/cloud-sweep.yml')); print('YAML OK')"`
Expected: `YAML OK`.

This matters more than it looks: `docs/superpowers/specs/` records that a previous workflow edit shipped with a YAML parse error and went unnoticed for two releases because the commit carried `[skip ci]`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/cloud-sweep.yml
git commit -m "feat(cloud): raise twice-failed chunks, and actually email about refunds"
```

---

### Task 7: Tell the author, and deploy

**Files:**
- Modify: `frontend/src/i18n.ts`
- Modify: `frontend/src/components/ReviewExport.tsx`
- Modify: `worker/README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Add the string in all five languages**

`frontend/src/i18n.ts` keys an object per string with one field per language
(see `export_translation` at line 3449 for the shape). Add beside it:

```ts
  chapter_failed_twice: {
    en: "Betty tried this chapter twice and could not finish it. Nothing has been changed — your original text is safe. Bethaniel has been notified.",
    da: "Betty forsøgte dette kapitel to gange og kunne ikke gøre det færdigt. Intet er ændret — din originaltekst er uberørt. Bethaniel er blevet underrettet.",
    de: "Betty hat dieses Kapitel zweimal versucht und konnte es nicht abschließen. Es wurde nichts geändert — Ihr Originaltext ist unversehrt. Bethaniel wurde benachrichtigt.",
    es: "Betty intentó este capítulo dos veces y no pudo terminarlo. No se ha cambiado nada: tu texto original está intacto. Bethaniel ha sido notificado.",
    fr: "Betty a essayé ce chapitre deux fois sans pouvoir le terminer. Rien n'a été modifié : votre texte d'origine est intact. Bethaniel a été prévenu.",
  },
```

All five languages, `fr` included. Note that `export_translation` itself is
missing `fr` — do **not** copy that omission; French is supported (commit
43eb6bf) and a missing key silently falls back to English.

- [ ] **Step 2: Show it on a failed chapter**

`frontend/src/components/ReviewExport.tsx` already renders an error pill for a
failed chapter at ~line 4325:

```tsx
                    {task.status === "error" && (
                      ...
                        <span className="task-status-pill qs-error">
                          {t("status_error")}
```

Add the explanation directly beneath that pill, for translate tasks only —
this copy promises the original is safe, which is true because a failed chunk
falls back to the source text, and it would be a lie on a mode that edits in
place:

```tsx
                    {task.status === "error" && task.mode === "translate" && (
                      <p className="task-error-note">{t("chapter_failed_twice")}</p>
                    )}
```

Follow the surrounding markup: if no `task-error-note` class exists in
`frontend/src/styles/`, add a modest one beside the existing `qs-error` rules
rather than inventing a new stylesheet.

- [ ] **Step 3: Build the frontend**

Run: `cd frontend && npm run build`
Expected: completes with no TypeScript errors.

- [ ] **Step 4: Document the deploy order**

In `worker/README.md`, beside the existing note about `promo_codes` columns, add:

```markdown
   A database that predates failure reporting needs the `job_failures` table
   before a Worker that writes to it is deployed — without it every
   `/v1/failure` call 500s (harmlessly, since the app swallows the result,
   but the reports are lost):
   ```
   npx wrangler d1 execute bethaniel-cloud --remote --file worker/schema.sql
   ```
   `schema.sql` is written with `CREATE TABLE IF NOT EXISTS` throughout, so
   replaying it whole is safe.
```

- [ ] **Step 5: Record the behaviour in CLAUDE.md**

In the "Betty in the Cloud" section of `CLAUDE.md`, add a bullet:

```markdown
- **When a chunk fails twice.** `queue.ts`'s attempt ladder now judges the
  translation draft *inside* the loop (`draftGuard` → `DraftRejectedError`), so
  an unusable answer re-rolls with a fresh seed instead of costing the chapter.
  Two ceilings, from `chunkRetryLimit`: five goes at a network fault, two at a
  bad answer. When both are spent on a cloud job, `cloudFailureReport.ts` files
  a diagnostics-only row via `POST /v1/failure`, and the hourly `cloud-sweep`
  workflow raises a GitHub issue. The reason is a closed enum — this repo is
  public and a free-text error string would eventually carry the manuscript
  that caused it. The ledger carries a flat 20% overdraft
  (`OVERDRAFT_FRACTION`) so a retry is never refused for want of budget.
```

- [ ] **Step 6: Full verification**

Run:
```bash
cd backend && npm run build && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"
cd ../worker && npm test
cd ../frontend && npm run build
```
Expected: backend `fail 0`, worker green, frontend builds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/i18n.ts frontend/src/components/ReviewExport.tsx worker/README.md CLAUDE.md
git commit -m "feat(ui): a chapter that failed twice says so, and says the original is safe"
```

- [ ] **Step 8: Deploy the Worker — ORDER MATTERS**

Not part of the commit. Run by hand, in this order:

```bash
cd worker
npx wrangler d1 execute bethaniel-cloud --remote --file schema.sql   # table FIRST
npm run deploy                                                        # then the Worker
```

Deploying the Worker before the table exists means every `/v1/failure` call 500s and those reports are lost for good.

Verify:
```bash
curl -s -X POST https://bethaniel-cloud.cloudwatcher.workers.dev/v1/failure \
  -H "Authorization: Bearer not-a-real-token" -H "Content-Type: application/json" \
  -d '{"reason":"empty_output","attempts":2}' -o /dev/null -w '%{http_code}\n'
```
Expected: `401`. A `404` means the route did not deploy; a `500` means the table is missing.

- [ ] **Step 9: Hand back to the human**

Do **not** push. A push to `main` cuts a release. Report what is committed, that the Worker is deployed, and let Simon choose when to ship.

---

## Verification checklist

- [ ] `cd backend && npm test` — `fail 0`
- [ ] `cd backend && npm run build` — silent
- [ ] `cd worker && npm test` — green
- [ ] `cd frontend && npm run build` — no TS errors
- [ ] Flaky stub (fail once, then succeed) → chapter translated, **no** error
- [ ] Always-failing stub on a **local** model → errors, and **no** `/v1/failure` call
- [ ] `job_failures` table created before the Worker is deployed
- [ ] `/v1/failure` with a bad token returns `401`
- [ ] `cloud-sweep.yml` parses as YAML
- [ ] No manuscript text anywhere in `job_failures`, and no customer email
