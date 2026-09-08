// ── Pricing ──

import type { Env } from "./env";

/** The parts of a promo code that bear on price. */
export interface PromoTerms {
  code: string;
  discountPct?: number | null;
  discountCents?: number | null;
  maxWords?: number | null;
}

export interface PriceQuote {
  tokens: number;
  words: number;
  tiers: number;
  priceEurCents: number;
  /** Price before any code was applied, so the app can show the saving. */
  fullPriceEurCents: number;
  /** The code that was applied, if one was and it was valid. */
  appliedCode?: string;
  /** Set when a code was offered but does not cover a job this size. */
  codeRejectedReason?: string;
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
 *
 * Which is exactly why the two numbers cannot be trusted independently. Both
 * arrive from an unauthenticated caller, `words` sets the price and
 * `estimatedTokens` sets the ceiling — so `{ words: 1, estimatedTokens: 8M }`
 * would buy a 12M-token credential for the band-one minimum. Billing on
 * whichever number implies MORE work closes that without an error path: an
 * honest client is unaffected (its word count always dominates), and the
 * dishonest one simply pays what the tokens it asked for are worth.
 */
/**
 * The most tokens one word of manuscript could honestly consume.
 *
 * Measured against the app's own estimator at its heaviest setting — a
 * Danish translation with review, style agent and an extra pass — which
 * comes to 16.14 tokens per word; a copy edit is 10.7. Forty leaves roughly
 * 2.5x headroom over the worst real configuration, so no honest quote is
 * ever repriced by it, while the attack it exists to stop needs a ratio in
 * the millions.
 *
 * Raise it if a genuinely heavier mode is added; lowering it below ~20 would
 * start overcharging real translation jobs.
 */
export const MAX_TOKENS_PER_WORD = 40;

export function priceJob(
  env: Env,
  input: { estimatedTokens: number; words: number },
  promo?: PromoTerms | null,
): PriceQuote {
  const tokens = Math.max(1, Math.round(input.estimatedTokens));
  const claimedWords = Math.max(1, Math.round(input.words));

  // The smallest word count that could honestly need this many tokens. A
  // caller who under-reports words (or omits them entirely, which lands here
  // as 1) is billed on this instead.
  const impliedWords = Math.ceil(tokens / MAX_TOKENS_PER_WORD);
  const words = Math.max(claimedWords, impliedWords);

  const bandWords = Number(env.PRICE_TIER_WORDS) || 100_000;
  const bandCents = Number(env.PRICE_TIER_EUR_CENTS) || 500;

  // Bands are whole: 1 word and 100,000 words are both one band.
  const tiers = Math.max(1, Math.ceil(words / bandWords));
  const fullPriceEurCents = tiers * bandCents;

  if (!promo) {
    return { tokens, words, tiers, priceEurCents: fullPriceEurCents, fullPriceEurCents };
  }

  // A code may cap the size it will pay for, so "free trial" can mean "free up
  // to 5,000 words" without minting an unbounded credential. Over the cap the
  // code simply does not apply — the author still gets a price rather than an
  // error, and is told why.
  if (promo.maxWords != null && words > promo.maxWords) {
    return {
      tokens, words, tiers,
      priceEurCents: fullPriceEurCents,
      fullPriceEurCents,
      codeRejectedReason: `${promo.code} covers up to ${promo.maxWords.toLocaleString("en")} words; this job is ${words.toLocaleString("en")}.`,
    };
  }

  let cents = fullPriceEurCents;
  if (promo.discountPct != null) {
    const pct = Math.min(100, Math.max(0, promo.discountPct));
    cents = Math.round(cents * (1 - pct / 100));
  }
  if (promo.discountCents != null) cents -= promo.discountCents;
  const priceEurCents = Math.max(0, cents);

  return {
    tokens, words, tiers, priceEurCents, fullPriceEurCents, appliedCode: promo.code,
  };
}
