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

test("the price does not depend on the token estimate", () => {
  const cheap = priceJob(env, { estimatedTokens: 10_000, words: 50_000 });
  const dear = priceJob(env, { estimatedTokens: 5_000_000, words: 50_000 });
  assert.equal(cheap.priceEurCents, dear.priceEurCents);
  // The estimate is still carried, because it sizes the credential's ceiling.
  assert.equal(dear.tokens, 5_000_000);
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
