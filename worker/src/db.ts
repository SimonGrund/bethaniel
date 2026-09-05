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
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS);
  await env.DB.prepare(
    `INSERT INTO quotes (id, estimated_tokens, price_eur_cents, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, estimatedTokens, priceEurCents, now.toISOString(), expiresAt.toISOString())
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
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO credentials
       (id, token_hash, stripe_session_id, token_budget, reserved, spent, status, created_at, expires_at, customer_email)
     VALUES (?, ?, ?, ?, 0, 0, 'active', ?, ?, ?)`,
  )
    .bind(
      opts.id,
      opts.tokenHash,
      opts.stripeSessionId,
      opts.tokenBudget,
      new Date().toISOString(),
      opts.expiresAt,
      opts.customerEmail,
    )
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
