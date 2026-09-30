// ── The per-job report ──
//
// GET /admin/jobs: every credential in a date range, what it was sold as,
// and how much of it was used. The website's /admin/cloud page reads it with
// REPORT_TOKEN and joins it to Stripe for the exact fee and payout.
//
// Pure: the rows come in, the report goes out, so the rules are tested
// without a database. Customer email is included on purpose — the report
// exists for refunds and support, and the privacy policy says so.

import type { Env } from "./env";
import type { JobRow } from "./db";

/** The routes the report token opens, and the only ones. */
export const REPORT_ROUTES = ["/admin/jobs"];

export const MAX_JOBS = 2000;
const DEFAULT_DAYS = 90;
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `from`/`to` as YYYY-MM-DD, `to` inclusive; the last 90 days if omitted. */
export function parseRange(
  from: string | null,
  to: string | null,
  now = new Date(),
): { ok: true; from: string; to: string } | { ok: false; error: string } {
  if (!from && !to) {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS);
    return { ok: true, from: new Date(end.getTime() - DEFAULT_DAYS * DAY_MS).toISOString(), to: end.toISOString() };
  }
  if (!from || !to || !DATE.test(from) || !DATE.test(to)) {
    return { ok: false, error: "from and to are both YYYY-MM-DD" };
  }
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return { ok: false, error: "that is not a date range" };
  }
  return { ok: true, from: start.toISOString(), to: end.toISOString() };
}

/* What a token costs the provider, by product. Translation runs on a dearer
   model; everything else on the default one. These are the same rates the
   prices are computed from (quote.ts), so this is an estimate of what the
   provider will bill, not a reading of the bill. */
export function costPerToken(env: Env, product: string | null): number {
  const base = Number(env.BASE_COST_EUR_PER_TOKEN) || 0;
  if (product === "translate") return Number(env.BASE_COST_EUR_PER_TOKEN_TRANSLATE) || base;
  return base;
}

export interface JobReport {
  id: string;
  createdAt: string;
  expiresAt: string;
  status: string;
  kind: "paid" | "code";
  product: string | null;
  currency: string | null;
  priceCents: number | null;
  promoCode: string | null;
  customerEmail: string | null;
  paymentIntent: string | null;
  sessionId: string;
  tokenBudget: number;
  tokensUsed: number;
  refundStatus: string | null;
  providerCostEur: number;
}

export function toJobReport(row: JobRow, env: Env): JobReport {
  /* A job paid for entirely by a code never reaches Stripe; its session id
     is the synthetic promo_<quote> the free path mints. */
  const kind = row.stripe_session_id.startsWith("promo_") ? "code" : "paid";
  const used = Math.max(0, row.spent ?? 0);
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    kind,
    product: row.product,
    currency: row.currency,
    priceCents: row.price_cents ?? (kind === "code" ? 0 : null),
    promoCode: row.promo_code,
    customerEmail: row.customer_email,
    paymentIntent: row.stripe_payment_intent,
    sessionId: row.stripe_session_id,
    tokenBudget: row.token_budget,
    tokensUsed: used,
    refundStatus: row.refund_status,
    providerCostEur: Math.round(used * costPerToken(env, row.product) * 10_000) / 10_000,
  };
}
