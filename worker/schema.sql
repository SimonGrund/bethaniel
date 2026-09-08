-- Betty in the Cloud — D1 schema.
-- No manuscript content ever lands here — only token counts and credential
-- lifecycle metadata. Raw credential tokens are never stored, only their
-- SHA-256 hash (`credentials.token_hash`).

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  estimated_tokens INTEGER NOT NULL,
  price_eur_cents INTEGER NOT NULL,
  -- The code this quote was priced with, so /v1/checkout redeems exactly what
  -- the author was shown rather than trusting the client to resend it.
  promo_code TEXT,
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

-- ── Promo codes ──
--
-- A code is the only way to get a discounted or free run. There is no login and
-- no free tier: a free tier gated on nothing but an install id would draw on the
-- same DAILY_TOKEN_CEILING that serves paying customers, so abusing it would not
-- cost money — it would exhaust the ceiling and hand paying users a 503. Issuing
-- N codes bounds the whole campaign to N runs by construction.
--
-- discount_pct and discount_cents are alternatives: pct for "half price", cents
-- for "EUR 5 off", 100 pct for a comp. Whichever is set wins; pct is applied
-- first if both are.
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY,             -- compared case-insensitively, stored upper
  campaign TEXT,                     -- free-text label, so redemptions attribute
  discount_pct INTEGER,              -- 0-100
  discount_cents INTEGER,            -- absolute, in EUR cents
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  -- A code may cap the size it will pay for, so "free trial" can mean
  -- "free up to 5,000 words" without minting an unbounded credential.
  max_words INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT,                   -- NULL = never
  status TEXT NOT NULL DEFAULT 'active'  -- active | void
);

CREATE INDEX IF NOT EXISTS idx_promo_campaign ON promo_codes(campaign);
