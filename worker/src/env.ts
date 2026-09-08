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
  PROVIDER_API_BASE: string;
  BASE_COST_EUR_PER_TOKEN: string;
  /** Rate for PROVIDER_MODEL_TRANSLATE, which is a different (dearer) model. */
  BASE_COST_EUR_PER_TOKEN_TRANSLATE?: string;
  MARKUP_MULTIPLIER: string;
  /** Words per pricing band. One band = PRICE_TIER_EUR_CENTS. */
  PRICE_TIER_WORDS?: string;
  /** Price of one band, in EUR cents. */
  PRICE_TIER_EUR_CENTS?: string;
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

  // ── Safety limits ──
  // The provider offers budget alerts but no hard spending cap, so these are
  // the only real ceilings that exist. See globalMeter.ts.
  DAILY_TOKEN_CEILING: string;
  MAX_OUTPUT_TOKENS_PER_REQUEST: string;
  MAX_QUOTE_TOKENS: string;
  /** "none" (default) disables the model's chain-of-thought; "default" hands
   *  control back to the provider. Anything else is passed through verbatim. */
  PROVIDER_REASONING_EFFORT: string;
}
