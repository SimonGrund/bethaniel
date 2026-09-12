// ── Pricing unit tests ──
//
// Betty in the Cloud prices by manuscript SIZE, not by token cost: a flat band
// of words, doubling per band. These tests pin the parts of that decision that
// would be easy to erode — that a band is whole, that band one is the floor,
// that the token estimate never touches the price, and that a promo code can
// discount but never produce a negative one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { priceJob } from "../src/quote.ts";
import type { Env } from "../src/env.ts";

const env = { PRICE_TIER_WORDS: "100000", PRICE_TIER_EUR_CENTS: "500" } as unknown as Env;

test("anything up to the band size costs one band", () => {
  for (const words of [1, 3_000, 50_000, 100_000]) {
    const q = priceJob(env, { estimatedTokens: 1_000_000, words });
    assert.equal(q.tiers, 1);
    assert.equal(q.priceEurCents, 500);
  }
});

test("a short story pays the same as a full novel — the floor is deliberate", () => {
  const story = priceJob(env, { estimatedTokens: 50_000, words: 3_000 });
  const novel = priceJob(env, { estimatedTokens: 1_070_000, words: 100_000 });
  assert.equal(story.priceEurCents, novel.priceEurCents);
});

test("crossing a band costs another band", () => {
  assert.equal(priceJob(env, { estimatedTokens: 1, words: 100_001 }).priceEurCents, 1000);
  assert.equal(priceJob(env, { estimatedTokens: 1, words: 200_000 }).priceEurCents, 1000);
  assert.equal(priceJob(env, { estimatedTokens: 1, words: 200_001 }).priceEurCents, 1500);
});

test("the price does not depend on the token estimate, within the plausible range", () => {
  // Both of these are ratios a real job produces (0.2 and 16 tokens per
  // word), so the word count alone decides the price.
  const cheap = priceJob(env, { estimatedTokens: 10_000, words: 50_000 });
  const dear = priceJob(env, { estimatedTokens: 800_000, words: 50_000 });
  assert.equal(cheap.priceEurCents, dear.priceEurCents);
  // The estimate is still carried, because it sizes the credential's ceiling.
  assert.equal(dear.tokens, 800_000);
});

test("beyond that range the estimate does move the price, deliberately", () => {
  // This test previously asserted the opposite, and that was the bug: an
  // estimate no word count could justify has to be paid for, or it is a free
  // credential. 5M tokens needs at least 125,000 words, which is two bands.
  const absurd = priceJob(env, { estimatedTokens: 5_000_000, words: 50_000 });
  assert.equal(absurd.tiers, 2);
  assert.equal(absurd.priceEurCents, 1000);
});

test("an app that sends no word count falls back to the cheapest band", () => {
  assert.equal(priceJob(env, { estimatedTokens: 1_000_000, words: 1 }).priceEurCents, 500);
});

test("a 100% code brings the price to zero, which skips Stripe entirely", () => {
  const q = priceJob(env, { estimatedTokens: 1e6, words: 50_000 }, { code: "LAUNCH", discountPct: 100 });
  assert.equal(q.priceEurCents, 0);
  assert.equal(q.fullPriceEurCents, 500);
  assert.equal(q.appliedCode, "LAUNCH");
});

test("a percentage takes its share of the band price", () => {
  const q = priceJob(env, { estimatedTokens: 1e6, words: 150_000 }, { code: "HALF", discountPct: 50 });
  assert.equal(q.fullPriceEurCents, 1000); // two bands
  assert.equal(q.priceEurCents, 500);
});

test("an absolute discount cannot make the price negative", () => {
  const q = priceJob(env, { estimatedTokens: 1e6, words: 10_000 }, { code: "BIG", discountCents: 99_999 });
  assert.equal(q.priceEurCents, 0);
});

test("a code capped by size does not apply to a larger job, and says why", () => {
  const q = priceJob(env, { estimatedTokens: 1e6, words: 40_000 }, {
    code: "TRY5K", discountPct: 100, maxWords: 5_000,
  });
  assert.equal(q.priceEurCents, 500, "full price, not free");
  assert.equal(q.appliedCode, undefined);
  assert.match(q.codeRejectedReason ?? "", /TRY5K/);
  assert.match(q.codeRejectedReason ?? "", /5,000/);
});

test("the same capped code applies at or under its limit", () => {
  const q = priceJob(env, { estimatedTokens: 50_000, words: 5_000 }, {
    code: "TRY5K", discountPct: 100, maxWords: 5_000,
  });
  assert.equal(q.priceEurCents, 0);
  assert.equal(q.appliedCode, "TRY5K");
});

test("no code leaves the band price untouched", () => {
  const q = priceJob(env, { estimatedTokens: 1e6, words: 50_000 }, null);
  assert.equal(q.priceEurCents, q.fullPriceEurCents);
  assert.equal(q.appliedCode, undefined);
});

// ── Cross-checking the two client-supplied numbers ──
//
// `words` sets the price and `estimatedTokens` sets the credential ceiling.
// Both come from an unauthenticated caller, so trusting them independently
// let one be minimised while the other was maximised. Found by review, 8
// September 2026.

test("under-reported words cannot buy an oversized credential cheaply", () => {
  // The attack: one word, eight million tokens. Previously band one, EUR 5.
  const q = priceJob(env, { estimatedTokens: 8_000_000, words: 1 });
  assert.ok(
    q.priceEurCents > 500,
    `expected more than the band-one minimum, got ${q.priceEurCents}`,
  );
  // 8M / 40 = 200,000 implied words = two bands.
  assert.equal(q.tiers, 2);
  assert.equal(q.priceEurCents, 1000);
});

test("omitting words entirely is the same loophole, and is closed too", () => {
  const q = priceJob(env, { estimatedTokens: 8_000_000, words: 0 });
  assert.equal(q.tiers, 2);
});

test("an honest job is never repriced — the word count dominates", () => {
  // 100,000 words at the estimator's heaviest real setting (translation,
  // 16.14 tok/word) still sits comfortably inside band one.
  const q = priceJob(env, { estimatedTokens: 1_614_000, words: 100_000 });
  assert.equal(q.tiers, 1);
  assert.equal(q.priceEurCents, 500);
});

test("a copy edit quoted from tokens alone lands in the right band", () => {
  // A client too old to send `words`: 100k words is ~1.07M tokens.
  const q = priceJob(env, { estimatedTokens: 1_070_000, words: 0 });
  assert.equal(q.tiers, 1);
});

// ── The enhanced language analysis: its own price, the same guard ──

test("the enhanced analysis is a flat band price, well under an edit", () => {
  const e = { ...env, PRICE_ENHANCE_EUR_CENTS: "200" } as unknown as Env;
  for (const words of [3_000, 50_000, 100_000]) {
    const q = priceJob(e, { estimatedTokens: 40_000, words, product: "enhance" });
    assert.equal(q.product, "enhance");
    assert.equal(q.tiers, 1);
    assert.equal(q.priceEurCents, 200);
  }
  assert.equal(
    priceJob(e, { estimatedTokens: 60_000, words: 150_000, product: "enhance" }).priceEurCents,
    400,
  );
});

test("an enhance quote cannot buy an edit-sized credential for two euros", () => {
  // The analysis samples the book; asking for edit-sized tokens against the
  // small price is billed on the words those tokens imply, on its own —
  // tighter — ceiling.
  const q = priceJob(env, { estimatedTokens: 1_000_000, words: 50_000, product: "enhance" });
  assert.equal(q.tiers, 3); // 1M / 4 = 250,000 words
  assert.equal(q.priceEurCents, 600);
});

test("a quote without a product is an edit", () => {
  assert.equal(priceJob(env, { estimatedTokens: 1e6, words: 50_000 }).product, "edit");
});

test("the three front cards are told apart but priced alike", () => {
  const prices = new Set<number>();
  for (const product of ["edit", "readthrough", "translate"] as const) {
    const q = priceJob(env, { estimatedTokens: 800_000, words: 50_000, product });
    assert.equal(q.product, product);
    assert.equal(q.tiers, 1);
    prices.add(q.priceEurCents);
  }
  assert.deepEqual([...prices], [500]);
  // Same guard on every one of them: translation's heavier token count
  // still sits well inside the ceiling, so it is never repriced by it.
  assert.equal(priceJob(env, { estimatedTokens: 1_610_000, words: 100_000, product: "translate" }).tiers, 1);
});
