// ── Pricing ──

import type { Env } from "./env";

export interface PriceQuote {
  tokens: number;
  priceEurCents: number;
}

/** Price an estimated token count in EUR cents: the provider's blended cost,
 *  marked up (MARKUP_MULTIPLIER), grossed up to absorb Stripe's own
 *  cut, and floored at a minimum charge so Stripe's fixed fee doesn't eat a
 *  disproportionate share of a tiny job. */
export function priceTokens(env: Env, estimatedTokens: number): PriceQuote {
  const tokens = Math.max(1, Math.round(estimatedTokens));
  const baseCostEur = tokens * Number(env.BASE_COST_EUR_PER_TOKEN);
  const markedUpEur = baseCostEur * Number(env.MARKUP_MULTIPLIER);
  const stripePct = Number(env.STRIPE_PCT_FEE);
  const stripeFixed = Number(env.STRIPE_FIXED_FEE_EUR);
  const grossedUpEur = (markedUpEur + stripeFixed) / (1 - stripePct);

  const minCents = Number(env.MIN_CHARGE_EUR_CENTS);
  const rawCents = Math.round(grossedUpEur * 100);
  // Round up to the nearest 50 cents — a price that reads as a clean number,
  // never a cent below what covers cost + markup + Stripe's cut.
  const roundedCents = Math.ceil(rawCents / 50) * 50;

  return { tokens, priceEurCents: Math.max(minCents, roundedCents) };
}
