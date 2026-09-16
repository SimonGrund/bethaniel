// ── Pricing ──

import type { Env } from "./env";
import { parseProductUses } from "./db";
import type { PromoRow } from "./db";

/** The parts of a promo code that bear on price. */
export interface PromoTerms {
  code: string;
  discountPct?: number | null;
  discountCents?: number | null;
  maxWords?: number | null;
  /** Uses allowed per product; null or absent means the total alone governs. */
  maxUsesPerProduct?: number | null;
  /** Uses already taken, by product. Absent counts as none. */
  productUses?: Record<string, number>;
}

/** What is being bought. The three front cards — an edit, a final
 *  readthrough, a translation — are each priced by the size of the
 *  manuscript, at the same band price; they are told apart so the receipt
 *  and the quote row say what was sold. The enhanced language analysis
 *  reads only a sample of the book and is a flat, much smaller price per
 *  band. An app that sends no product is an edit. */
export type CloudProduct = "edit" | "readthrough" | "translate" | "enhance";

export const CLOUD_PRODUCTS: readonly CloudProduct[] = [
  "edit",
  "readthrough",
  "translate",
  "enhance",
];

/** How a product is named mid-sentence, for the reason a code is refused. */
export const PRODUCT_NOUNS: Record<CloudProduct, string> = {
  edit: "an edit",
  readthrough: "a readthrough",
  translate: "a translation",
  enhance: "an enhanced language analysis",
};

/** What the author sees on the Stripe receipt. */
export const PRODUCT_NAMES: Record<CloudProduct, string> = {
  edit: "Betty in the Cloud — copy and line edit",
  readthrough: "Betty in the Cloud — final readthrough",
  translate: "Betty in the Cloud — translation",
  enhance: "Betty in the Cloud — enhanced language analysis",
};

/**
 * What a code has left, resolved per product.
 *
 * The app puts a note on every task card the code can pay for, so it needs
 * the answer per product rather than the two raw counters — and it must be
 * the SAME answer the price is computed from, or a card promises a free run
 * the checkout then charges for. Hence one function, called by /v1/code and
 * echoed by /v1/quote.
 *
 * `shared` is the distinction that decides the wording. With no per-product
 * cap the count is one pool spent across every card ("3 free runs left, any
 * task"); with one, each card counts alone ("1 free run on this task"). An
 * author told the first as though it were the second reads four cards and
 * concludes they hold twelve runs.
 */
export interface CodeBalance {
  code: string;
  maxWords: number | null;
  /** True only of a code that takes the price to zero — see below. */
  free: boolean;
  /** One pool across all products, rather than a count per product. */
  shared: boolean;
  runsLeft: Record<CloudProduct, number>;
}

export function codeBalance(row: PromoRow): CodeBalance {
  const pool = Math.max(0, row.max_uses - row.uses);
  const perProduct = row.max_uses_per_product;
  const taken = parseProductUses(row);
  const runsLeft = {} as Record<CloudProduct, number>;
  for (const product of CLOUD_PRODUCTS) {
    // The total pool caps the per-product count and never the other way
    // round: two uses left with three allowed per product is two, or the card
    // offers a third run that redeemPromo refuses.
    runsLeft[product] =
      perProduct == null
        ? pool
        : Math.max(0, Math.min(pool, perProduct - (taken[product] ?? 0)));
  }
  return {
    code: row.code,
    maxWords: row.max_words,
    // Only a full comp is announced as free. A percentage short of 100 would
    // need the job priced before anything true could be said about it, and
    // pricing four cards to write four discounted figures is exactly the work
    // this endpoint exists to avoid. A partial code still discounts at quote
    // time, where the price is real; it just does not get a note.
    free: row.discount_pct === 100,
    shared: perProduct == null,
    runsLeft,
  };
}

export interface PriceQuote {
  product: CloudProduct;
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

/**
 * The same ceiling for the enhanced language analysis, which never reads the
 * whole manuscript: it samples about one passage per 7,000 words, at most
 * fourteen, and sends each once with a short verdict back, then one
 * synthesis call. Measured against the app's estimator that is 0.4 tokens
 * per word of manuscript on a novel and about 2 on a 2,000-word story (where
 * the sample is most of the text). Four clears the worst honest case and
 * stops the flat price from buying an edit-sized credential: 8M tokens
 * against it is 2M words, twenty bands, not two euros.
 */
export const ENHANCE_MAX_TOKENS_PER_WORD = 4;

export function priceJob(
  env: Env,
  input: { estimatedTokens: number; words: number; product?: CloudProduct },
  promo?: PromoTerms | null,
): PriceQuote {
  const product: CloudProduct = input.product ?? "edit";
  const tokens = Math.max(1, Math.round(input.estimatedTokens));
  const claimedWords = Math.max(1, Math.round(input.words));

  // The smallest word count that could honestly need this many tokens. A
  // caller who under-reports words (or omits them entirely, which lands here
  // as 1) is billed on this instead.
  const tokensPerWord =
    product === "enhance" ? ENHANCE_MAX_TOKENS_PER_WORD : MAX_TOKENS_PER_WORD;
  const impliedWords = Math.ceil(tokens / tokensPerWord);
  const words = Math.max(claimedWords, impliedWords);

  const bandWords = Number(env.PRICE_TIER_WORDS) || 100_000;
  // Translation has its own band price. It runs on a much dearer model than
  // the edits — GLM-5.2 at EUR 1.80/5.50 per million against deepseek-v4-flash
  // at EUR 0.40/0.80 — and a 100k-word translation costs about EUR 3.76 in
  // provider tokens, reviewer included, where an edit of the same book costs
  // cents. Sold in the edit band it would have cleared the markup policy on
  // paper and almost nothing in practice.
  const bandCents =
    product === "enhance"
      ? Number(env.PRICE_ENHANCE_EUR_CENTS) || 200
      : product === "translate"
        ? Number(env.PRICE_TRANSLATE_EUR_CENTS) || 1200
        : Number(env.PRICE_TIER_EUR_CENTS) || 500;

  // Bands are whole: 1 word and 100,000 words are both one band.
  const tiers = Math.max(1, Math.ceil(words / bandWords));
  const fullPriceEurCents = tiers * bandCents;

  if (!promo) {
    return { product, tokens, words, tiers, priceEurCents: fullPriceEurCents, fullPriceEurCents };
  }

  // A code may cap the size it will pay for, so "free trial" can mean "free up
  // to 5,000 words" without minting an unbounded credential. Over the cap the
  // code simply does not apply — the author still gets a price rather than an
  // error, and is told why.
  if (promo.maxWords != null && words > promo.maxWords) {
    return {
      product, tokens, words, tiers,
      priceEurCents: fullPriceEurCents,
      fullPriceEurCents,
      codeRejectedReason: `${promo.code} covers up to ${promo.maxWords.toLocaleString("en")} words; this job is ${words.toLocaleString("en")}.`,
    };
  }

  // A code minted as "one of each" is refused for a product it has already
  // paid for, here at quote time so the author reads why instead of meeting
  // a 409 at checkout. redeemPromo re-checks under the same guard, atomically.
  if (
    promo.maxUsesPerProduct != null &&
    (promo.productUses?.[product] ?? 0) >= promo.maxUsesPerProduct
  ) {
    return {
      product, tokens, words, tiers,
      priceEurCents: fullPriceEurCents,
      fullPriceEurCents,
      codeRejectedReason: `${promo.code} has already been used for ${PRODUCT_NOUNS[product]}.`,
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
    product, tokens, words, tiers, priceEurCents, fullPriceEurCents, appliedCode: promo.code,
  };
}
