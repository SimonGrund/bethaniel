// ── D1 access helpers ──
//
// D1 is the write-through mirror and support/cron surface — the
// CredentialLedger Durable Object is authoritative for the hot
// reserve/commit/release path. Nothing here ever touches manuscript content.

import type { Env } from "./env";

export interface QuoteRow {
  id: string;
  estimated_tokens: number;
  price_eur_cents: number;
  promo_code: string | null;
  created_at: string;
  expires_at: string;
}

export interface CredentialRow {
  id: string;
  token_hash: string;
  stripe_session_id: string;
  token_budget: number;
  reserved: number;
  spent: number;
  status: "active" | "expired" | "void";
  created_at: string;
  expires_at: string;
  customer_email: string | null;
}

const QUOTE_TTL_MS = 15 * 60 * 1000;

export async function insertQuote(
  env: Env,
  id: string,
  estimatedTokens: number,
  priceEurCents: number,
  /** The code this price was computed with, redeemed at checkout. */
  promoCode?: string | null,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);
  await env.DB.prepare(
    `INSERT INTO quotes (id, estimated_tokens, price_eur_cents, promo_code, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      estimatedTokens,
      priceEurCents,
      promoCode ?? null,
      now.toISOString(),
      expiresAt.toISOString(),
    )
    .run();
}

export async function findQuote(env: Env, id: string): Promise<QuoteRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM quotes WHERE id = ?`).bind(id).first<QuoteRow>();
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

export async function insertCredential(
  env: Env,
  opts: {
    id: string;
    tokenHash: string;
    stripeSessionId: string;
    tokenBudget: number;
    expiresAt: string;
    customerEmail: string | null;
    stripePaymentIntent: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO credentials
       (id, token_hash, stripe_session_id, token_budget, reserved, spent, status,
        created_at, expires_at, customer_email, stripe_payment_intent)
     VALUES (?, ?, ?, ?, 0, 0, 'active', ?, ?, ?, ?)`,
  )
    .bind(
      opts.id,
      opts.tokenHash,
      opts.stripeSessionId,
      opts.tokenBudget,
      new Date().toISOString(),
      opts.expiresAt,
      opts.customerEmail,
      opts.stripePaymentIntent,
    )
    .run();
}

/**
 * Credentials that just expired and might be owed money back.
 *
 * Read AFTER sweepExpiredCredentials has flipped them to 'expired', and
 * only those not yet ruled on, so a refund is decided exactly once however
 * often the cron runs.
 */
export async function findUnruledExpiredCredentials(env: Env): Promise<
  {
    id: string;
    stripe_session_id: string;
    stripe_payment_intent: string | null;
    token_budget: number;
    spent: number;
  }[]
> {
  const { results } = await env.DB.prepare(
    `SELECT id, stripe_session_id, stripe_payment_intent, token_budget, spent
       FROM credentials
      WHERE status = 'expired' AND refund_status IS NULL
      LIMIT 100`,
  ).all<{
    id: string;
    stripe_session_id: string;
    stripe_payment_intent: string | null;
    token_budget: number;
    spent: number;
  }>();
  return results ?? [];
}

/** A credential the sweep could not decide about on its own. */
export interface RefundReviewRow {
  id: string;
  stripe_session_id: string;
  stripe_payment_intent: string | null;
  token_budget: number;
  spent: number;
  customer_email: string | null;
  created_at: string;
  expires_at: string;
}

/**
 * Everything waiting on a human.
 *
 * The sweep deliberately refuses to auto-refund a partly-used credential —
 * that rule is farmable (see refund.ts) — so it writes 'review' and moves on.
 * Until something reads this, the author it concerns is waiting on a decision
 * that exists only as a column value.
 */
export async function findRefundReviews(env: Env): Promise<RefundReviewRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, stripe_session_id, stripe_payment_intent, token_budget, spent,
            customer_email, created_at, expires_at
       FROM credentials
      WHERE refund_status = 'review'
      ORDER BY expires_at ASC
      LIMIT 200`,
  ).all<RefundReviewRow>();
  return results ?? [];
}

export async function findCredentialById(
  env: Env,
  id: string,
): Promise<RefundReviewRow & { refund_status: string | null } | null> {
  return env.DB.prepare(`SELECT * FROM credentials WHERE id = ?`)
    .bind(id)
    .first<RefundReviewRow & { refund_status: string | null }>();
}

export async function setRefundStatus(
  env: Env,
  id: string,
  status: "refunded" | "review" | "failed" | "none",
): Promise<void> {
  await env.DB.prepare(`UPDATE credentials SET refund_status = ? WHERE id = ?`)
    .bind(status, id)
    .run();
}

export async function findCredentialByStripeSession(
  env: Env,
  stripeSessionId: string,
): Promise<CredentialRow | null> {
  return env.DB.prepare(`SELECT * FROM credentials WHERE stripe_session_id = ?`)
    .bind(stripeSessionId)
    .first<CredentialRow>();
}

export async function findCredentialByTokenHash(
  env: Env,
  tokenHash: string,
): Promise<CredentialRow | null> {
  return env.DB.prepare(`SELECT * FROM credentials WHERE token_hash = ?`)
    .bind(tokenHash)
    .first<CredentialRow>();
}

export async function updateCredentialMirror(
  env: Env,
  tokenHash: string,
  reserved: number,
  spent: number,
): Promise<void> {
  await env.DB.prepare(`UPDATE credentials SET reserved = ?, spent = ? WHERE token_hash = ?`)
    .bind(reserved, spent, tokenHash)
    .run();
}

export async function sweepExpiredCredentials(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    `UPDATE credentials SET status = 'expired' WHERE status = 'active' AND expires_at < ?`,
  )
    .bind(new Date().toISOString())
    .run();
  return result.meta.changes ?? 0;
}

const PENDING_CLAIM_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Stash the raw token so the success page can retrieve it by session_id —
 *  the only place a raw credential briefly exists in plaintext at rest. */
export async function insertPendingClaim(
  env: Env,
  sessionId: string,
  token: string,
  tokenBudget: number,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PENDING_CLAIM_TTL_MS);
  await env.DB.prepare(
    `INSERT INTO pending_claims (session_id, token, token_budget, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO NOTHING`,
  )
    .bind(sessionId, token, tokenBudget, now.toISOString(), expiresAt.toISOString())
    .run();
}

export async function findPendingClaim(
  env: Env,
  sessionId: string,
): Promise<{ token: string; tokenBudget: number } | null> {
  const row = await env.DB.prepare(
    `SELECT token, token_budget, expires_at FROM pending_claims WHERE session_id = ?`,
  )
    .bind(sessionId)
    .first<{ token: string; token_budget: number; expires_at: string }>();
  if (!row || new Date(row.expires_at) < new Date()) return null;
  return { token: row.token, tokenBudget: row.token_budget };
}

export async function sweepExpiredPendingClaims(env: Env): Promise<number> {
  const result = await env.DB.prepare(`DELETE FROM pending_claims WHERE expires_at < ?`)
    .bind(new Date().toISOString())
    .run();
  return result.meta.changes ?? 0;
}

/** Quotes are write-once and short-lived; nothing reads one after it has been
 *  turned into a Checkout Session. Without this the table grew unboundedly,
 *  since anyone can ask for a price without paying. */
export async function sweepExpiredQuotes(env: Env): Promise<number> {
  const result = await env.DB.prepare(`DELETE FROM quotes WHERE expires_at < ?`)
    .bind(new Date().toISOString())
    .run();
  return result.meta.changes ?? 0;
}


// ── Promo codes ──

export interface PromoRow {
  code: string;
  campaign: string | null;
  discount_pct: number | null;
  discount_cents: number | null;
  max_uses: number;
  uses: number;
  max_words: number | null;
  created_at: string;
  expires_at: string | null;
  status: string;
}

/** Look a code up without consuming it. Quoting must not spend a use. */
export async function findPromo(env: Env, code: string): Promise<PromoRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM promo_codes WHERE code = ?`)
    .bind(code.trim().toUpperCase())
    .first<PromoRow>();
  if (!row) return null;
  if (row.status !== "active") return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  if (row.uses >= row.max_uses) return null;
  return row;
}

/**
 * Consume one use, atomically.
 *
 * The WHERE clause carries the guard rather than a prior SELECT, so two
 * checkouts racing on the last use of a code cannot both win: D1 applies the
 * UPDATE serially and the loser matches zero rows.
 */
/**
 * Hand a use back after a redemption that led nowhere.
 *
 * Redemption has to happen before the thing it pays for exists — a code
 * cannot be spent atomically with a Stripe call on another machine. So when
 * that call then fails, the author is left holding a spent single-use code
 * and nothing to show for it, and retrying answers "already used". This puts
 * it back.
 *
 * Guarded so it can only ever undo: `uses > 0` means a lost race or a double
 * call cannot push the counter below zero and mint free redemptions.
 */
export async function releasePromo(env: Env, code: string): Promise<void> {
  await env.DB.prepare(`UPDATE promo_codes SET uses = uses - 1 WHERE code = ? AND uses > 0`)
    .bind(code.trim().toUpperCase())
    .run();
}

export async function redeemPromo(env: Env, code: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE promo_codes SET uses = uses + 1
      WHERE code = ? AND status = 'active' AND uses < max_uses
        AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(code.trim().toUpperCase(), new Date().toISOString())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}
