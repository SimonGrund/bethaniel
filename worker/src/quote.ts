// ── Pricing ──

import type { Env } from "./env";

export interface PriceQuote {
  tokens: number;
  words: number;
  tiers: number;
  priceEurCents: number;
}

/**
 * Price a job by its SIZE, not by its token cost.
 *
 * A flat price per band of words: one band (PRICE_TIER_WORDS) costs
 * PRICE_TIER_EUR_CENTS, two bands cost double, and so on. A 100,000-word novel
 * and a 3,000-word story both fall in band one and both pay the same.
 *
 * This replaces cost-plus pricing, and the reason is that cost-plus produced
 * numbers too small to charge. Measured against the app's own estimator, a
 * 100,000-word manuscript is ~1.07M tokens for a copy edit and ~1.61M for a
 * translation. On the models this Worker serves that is EUR 0.16 and EUR 0.24
 * respectively — a bill dominated by Stripe's fixed fee, and a price no one can
 * reason about in advance. A flat band is predictable for the author and leaves
 * a comfortable margin at every size: the dearest case, translation on the 70B,
 * costs about EUR 1.08 in a band sold for EUR 5.
 *
 * The token estimate still matters, but for a different job — it sizes the
 * credential's spending ceiling (see /v1/checkout), which is what actually
 * bounds exposure now that the price no longer does.
 */
export function priceJob(
  env: Env,
  input: { estimatedTokens: number; words: number },
): PriceQuote {
  const tokens = Math.max(1, Math.round(input.estimatedTokens));
  const words = Math.max(1, Math.round(input.words));

  const bandWords = Number(env.PRICE_TIER_WORDS) || 100_000;
  const bandCents = Number(env.PRICE_TIER_EUR_CENTS) || 500;

  // Bands are whole: 1 word and 100,000 words are both one band.
  const tiers = Math.max(1, Math.ceil(words / bandWords));
  const priceEurCents = tiers * bandCents;

  return { tokens, words, tiers, priceEurCents };
}
