// ── Worker environment bindings ──

export interface Env {
  DB: D1Database;
  CREDENTIAL_LEDGER: DurableObjectNamespace;
  GLOBAL_METER: DurableObjectNamespace;

  // Secrets — set via `wrangler secret put <NAME>`, never committed.
  PROVIDER_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  // Vars — non-secret tuning knobs, see wrangler.toml.
  PROVIDER_MODEL: string;
  /** Model used for the translate pass only — see wrangler.toml. */
  PROVIDER_MODEL_TRANSLATE?: string;
  /**
   * Provider overrides for the translation pass. Each falls back to its
   * default-route counterpart, so leaving them unset keeps the original
   * arrangement: one provider, two models.
   *
   * They exist so the two passes can sit on DIFFERENT vendors — which is
   * what a migration actually looks like, when credit remains on the old
   * provider and the new one is only better at part of the job.
   */
  PROVIDER_API_BASE_TRANSLATE?: string;
  /** Secret. `wrangler secret put`, never a var. */
  PROVIDER_API_KEY_TRANSLATE?: string;
  PROVIDER_REASONING_EFFORT_TRANSLATE?: string;
  PROVIDER_API_BASE: string;
  BASE_COST_EUR_PER_TOKEN: string;
  /** Rate for PROVIDER_MODEL_TRANSLATE, which is a different (dearer) model. */
  BASE_COST_EUR_PER_TOKEN_TRANSLATE?: string;
  MARKUP_MULTIPLIER: string;
  /** Words per pricing band. One band = PRICE_TIER_EUR_CENTS. */
  PRICE_TIER_WORDS?: string;
  /** Price of one band, in EUR cents. */
  PRICE_TIER_EUR_CENTS?: string;
  /** Price of one band of the enhanced language analysis, in EUR cents. */
  PRICE_ENHANCE_EUR_CENTS?: string;
  /** Multiplier on the token estimate when sizing a credential's ceiling. */
  TOKEN_BUDGET_HEADROOM?: string;
  STRIPE_PCT_FEE: string;
  STRIPE_FIXED_FEE_EUR: string;
  MIN_CHARGE_EUR_CENTS: string;
  CREDENTIAL_EXPIRY_DAYS: string;
  CHECKOUT_SUCCESS_URL_BASE: string;
  /**
   * Must be the string "true" before an `sk_live_` key is allowed to create
   * a Checkout Session. Absent or anything else, a live key is refused — see
   * assertPaymentsAllowed in stripe.ts for why this exists.
   */
  ALLOW_LIVE_PAYMENTS?: string;

  /**
   * Operator secret for /admin/*. A SECRET, never a var — set with
   * `wrangler secret put ADMIN_TOKEN`.
   *
   * Optional, and its absence disables the admin surface entirely rather
   * than opening it: see isAdminRequest in admin.ts. Must be at least 16
   * characters, so a placeholder cannot accidentally become a live
   * credential.
   */
  ADMIN_TOKEN?: string;

  /**
   * Per-IP rate limiter for the endpoints that need no credential.
   *
   * Bethaniel is open source, so this Worker's URL is published in
   * wrangler.toml for anyone to read. /v1/quote writes a D1 row per call and
   * /v1/checkout calls Stripe per call, and neither asks for a credential —
   * so without this, a loop against a URL sitting in a public repo is enough
   * to exhaust the daily D1 write quota.
   *
   * Optional so the type still describes a deployment without the binding
   * (Miniflare, an older wrangler); callers must treat its absence as
   * "allowed" rather than crash — see rateLimitOk in index.ts.
   */
  IP_RATE_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };

  // ── Safety limits ──
  // The provider offers budget alerts but no hard spending cap, so these are
  // the only real ceilings that exist. See globalMeter.ts.
  DAILY_TOKEN_CEILING: string;
  MAX_OUTPUT_TOKENS_PER_REQUEST: string;
  MAX_QUOTE_TOKENS: string;
  /**
   * Worker-wide requests per minute, across every customer.
   *
   * DAILY_TOKEN_CEILING bounds what Bethaniel spends; this bounds how fast it
   * asks. They are different failures: one customer running a full book at high
   * concurrency can saturate the provider for everyone else long before the
   * day's tokens run out, and a per-credential limit cannot see that because it
   * only knows about one credential.
   *
   * Fails OPEN when unset — pacing is not the spend control, and refusing every
   * request over a config typo would be worse than not pacing.
   */
  WORKER_REQUESTS_PER_MINUTE?: string;
  /** "none" (default) disables the model's chain-of-thought; "default" hands
   *  control back to the provider. Anything else is passed through verbatim. */
  PROVIDER_REASONING_EFFORT: string;
}
