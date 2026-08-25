// ── Worker environment bindings ──

export interface Env {
  DB: D1Database;
  CREDENTIAL_LEDGER: DurableObjectNamespace;

  // Secrets — set via `wrangler secret put <NAME>`, never committed.
  MISTRAL_API_KEY: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;

  // Vars — non-secret tuning knobs, see wrangler.toml.
  MISTRAL_MODEL: string;
  MISTRAL_API_BASE: string;
  BASE_COST_EUR_PER_TOKEN: string;
  MARKUP_MULTIPLIER: string;
  STRIPE_PCT_FEE: string;
  STRIPE_FIXED_FEE_EUR: string;
  MIN_CHARGE_EUR_CENTS: string;
  CREDENTIAL_EXPIRY_DAYS: string;
  CHECKOUT_SUCCESS_URL_BASE: string;
}
