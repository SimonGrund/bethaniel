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
  PROVIDER_API_BASE: string;
  BASE_COST_EUR_PER_TOKEN: string;
  MARKUP_MULTIPLIER: string;
  STRIPE_PCT_FEE: string;
  STRIPE_FIXED_FEE_EUR: string;
  MIN_CHARGE_EUR_CENTS: string;
  CREDENTIAL_EXPIRY_DAYS: string;
  CHECKOUT_SUCCESS_URL_BASE: string;

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
