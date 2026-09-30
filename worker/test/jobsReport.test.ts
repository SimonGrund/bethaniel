// ── The per-job report ──
//
// What matters: the report token reads GET /admin/jobs and reaches nothing
// else; a credential is still minted for a paying customer when the new
// columns do not exist yet; and each job carries what it was sold as.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { parseRange, toJobReport } from "../src/jobsReport.ts";
import { insertCredential, isMissingColumn, type JobRow } from "../src/db.ts";
import { verifyAndParseStripeWebhook } from "../src/stripe.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";

const ADMIN = "a".repeat(40);
const MINT = "m".repeat(40);
const REPORT = "r".repeat(40);
const RATES = { BASE_COST_EUR_PER_TOKEN: "0.000000509", BASE_COST_EUR_PER_TOKEN_TRANSLATE: "0.000003300" };

const row = (over: Partial<JobRow> = {}): JobRow => ({
  id: "c1", created_at: "2026-09-30T10:00:00.000Z", expires_at: "2026-10-07T10:00:00.000Z",
  status: "active", stripe_session_id: "cs_live_1", stripe_payment_intent: "pi_1",
  customer_email: "author@example.com", token_budget: 1_000_000, reserved: 0, spent: 400_000,
  refund_status: null, product: "edit", currency: "eur", price_cents: 500, promo_code: null,
  ...over,
});

/* ── The report's shape ── */

test("a paid job reports what it was sold as, who bought it, and its estimated provider cost", () => {
  const r = toJobReport(row(), RATES as unknown as Env);
  assert.equal(r.kind, "paid");
  assert.equal(r.priceCents, 500);
  assert.equal(r.customerEmail, "author@example.com");
  assert.equal(r.tokensUsed, 400_000);
  assert.equal(r.providerCostEur, 0.2036);
});

test("translation is costed at its own, dearer rate", () => {
  const r = toJobReport(row({ product: "translate", spent: 100_000 }), RATES as unknown as Env);
  assert.equal(r.providerCostEur, 0.33);
});

test("a job paid for by a code is a code job, and cost nothing to the author", () => {
  const r = toJobReport(row({ stripe_session_id: "promo_q1", stripe_payment_intent: null, price_cents: null }), RATES as unknown as Env);
  assert.equal(r.kind, "code");
  assert.equal(r.priceCents, 0);
});

test("an old job without the new columns still reports, with what is unknown left unknown", () => {
  const r = toJobReport(row({ product: null, currency: null, price_cents: null }), RATES as unknown as Env);
  assert.equal(r.product, null);
  assert.equal(r.priceCents, null);
  assert.equal(r.providerCostEur, 0.2036);
});

test("the range defaults to the last 90 days and takes inclusive dates", () => {
  const d = parseRange(null, null, new Date("2026-09-30T12:00:00Z"));
  assert.deepEqual(d, { ok: true, from: "2026-07-03T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
  const e = parseRange("2026-09-01", "2026-09-30");
  assert.deepEqual(e, { ok: true, from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" });
  for (const [f, t] of [["2026-09-30", "2026-09-01"], ["yesterday", "2026-09-30"], ["2026-09-01", null]] as const) {
    assert.equal(parseRange(f, t).ok, false, `${f}..${t}`);
  }
});

/* ── Minting a credential before the migration has run ── */

test("a paying customer's credential is still minted when the new columns do not exist yet", async () => {
  const sql: string[] = [];
  const DB = {
    prepare: (text: string) => ({
      bind: () => ({
        run: async () => {
          sql.push(text);
          if (text.includes("product")) throw new Error("D1_ERROR: table credentials has no column named product: SQLITE_ERROR");
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  await insertCredential({ DB } as unknown as Env, {
    id: "c1", tokenHash: "h", stripeSessionId: "cs_1", tokenBudget: 10, expiresAt: "x",
    customerEmail: "a@b.co", stripePaymentIntent: "pi_1", product: "edit", currency: "eur", priceCents: 500,
  });
  assert.equal(sql.length, 2);
  assert.doesNotMatch(sql[1], /product/);
});

test("any other database error is not swallowed", async () => {
  const DB = { prepare: () => ({ bind: () => ({ run: async () => { throw new Error("D1_ERROR: UNIQUE constraint failed"); } }) }) };
  await assert.rejects(
    insertCredential({ DB } as unknown as Env, {
      id: "c1", tokenHash: "h", stripeSessionId: "cs_1", tokenBudget: 10, expiresAt: "x",
      customerEmail: null, stripePaymentIntent: null,
    }),
    /UNIQUE/,
  );
  assert.equal(isMissingColumn(new Error("no such column: product")), true);
});

/* ── The webhook reads back what was sold ── */

test("the webhook returns the amount, currency, product and code of the session", async () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    data: { object: {
      id: "cs_live_1", payment_status: "paid", payment_intent: "pi_1", amount_total: 250, currency: "eur",
      customer_details: { email: "author@example.com" },
      metadata: { quoteId: "q1", tokenBudget: "1000", product: "readthrough", promoCode: "BETTY-ABCD-EFGH" },
    } },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const e = await verifyAndParseStripeWebhook({ STRIPE_WEBHOOK_SECRET: secret } as unknown as Env, payload, `t=${t},v1=${v1}`);
  assert.equal(e?.amountTotal, 250);
  assert.equal(e?.currency, "eur");
  assert.equal(e?.product, "readthrough");
  assert.equal(e?.promoCode, "BETTY-ABCD-EFGH");
  assert.equal(e?.customerEmail, "author@example.com");
});

/* ── The report token's reach ── */

function fakeEnv() {
  const sql: string[] = [];
  const stmt = (text: string) => {
    const s = {
      bind: () => s,
      all: async () => { sql.push(text); return { results: [row()] }; },
      run: async () => { sql.push(text); return { meta: { changes: 1 } }; },
      first: async () => null,
    };
    return s;
  };
  const env = {
    DB: { prepare: stmt, batch: async (x: unknown[]) => x.map(() => ({ meta: { changes: 1 } })) },
    ADMIN_TOKEN: ADMIN, PROMO_MINT_TOKEN: MINT, REPORT_TOKEN: REPORT, ...RATES,
  } as unknown as Env;
  return { env, sql };
}

async function call(method: string, path: string, auth?: string, body?: unknown) {
  const { env, sql } = fakeEnv();
  const res = await worker.fetch(
    new Request(`https://x${path}`, {
      method,
      headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    }),
    env,
    {} as ExecutionContext,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, sql };
}

test("the report token reads the job report", async () => {
  const r = await call("GET", "/admin/jobs?from=2026-09-01&to=2026-09-30", REPORT);
  assert.equal(r.status, 200);
  assert.equal((r.body.jobs as unknown[]).length, 1);
});

test("the report token reaches nothing else, and cannot write", async () => {
  for (const [method, path] of [
    ["POST", "/admin/jobs"], ["POST", "/admin/sweep"], ["POST", "/admin/refund"],
    ["GET", "/admin/refunds"], ["POST", "/admin/promo"], ["POST", "/admin/promo/void"],
  ] as const) {
    const r = await call(method, path, REPORT, { codes: ["X-YZ"], credentialId: "c1", action: "refund" });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(r.sql, [], `${method} ${path} touched the database`);
  }
});

test("the minting token cannot read the report, and no token gets a 404", async () => {
  for (const auth of [MINT, undefined, "wrong-token-wrong-token"]) {
    const r = await call("GET", "/admin/jobs", auth);
    assert.equal(r.status, 404, String(auth));
    assert.deepEqual(r.sql, []);
  }
});

test("a bad range is refused before the database is asked", async () => {
  const r = await call("GET", "/admin/jobs?from=2026-09-30&to=2026-09-01", REPORT);
  assert.equal(r.status, 400);
  assert.deepEqual(r.sql, []);
});
