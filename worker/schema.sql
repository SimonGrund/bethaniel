-- Betty in the Cloud — D1 schema.
-- No manuscript content ever lands here — only token counts and credential
-- lifecycle metadata. Raw credential tokens are never stored, only their
-- SHA-256 hash (`credentials.token_hash`).

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  estimated_tokens INTEGER NOT NULL,
  price_eur_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  stripe_session_id TEXT NOT NULL UNIQUE,
  token_budget INTEGER NOT NULL,
  -- Write-through mirror of the Durable Object's authoritative counters —
  -- used for the cron sweep and support lookups, never the hot decrement path.
  reserved INTEGER NOT NULL DEFAULT 0,
  spent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', -- active | expired | void
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  customer_email TEXT
);

CREATE INDEX IF NOT EXISTS idx_credentials_expiry ON credentials(status, expires_at);

-- Short-lived handoff so the success page can retrieve the raw token once by
-- session_id (the permanent `credentials` table only ever stores its hash).
-- Swept by the hourly cron well before its 1-hour expiry — this is the one
-- place a raw credential exists in plaintext at rest, and only briefly.
CREATE TABLE IF NOT EXISTS pending_claims (
  session_id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  token_budget INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
