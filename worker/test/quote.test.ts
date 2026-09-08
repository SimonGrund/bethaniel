// Pricing is by manuscript SIZE, not token cost. These tests pin the shape of
// that decision: bands are whole, band one is the floor, and doubling the words
// doubles the price.

import { describe, it, expect } from "vitest";
import { priceJob } from "../src/quote";

const env = { PRICE_TIER_WORDS: "100000", PRICE_TIER_EUR_CENTS: "500" } as never;

describe("priceJob", () => {
  it("charges one band for anything up to the band size", () => {
    for (const words of [1, 3_000, 50_000, 100_000]) {
      const q = priceJob(env, { estimatedTokens: 1_000_000, words });
      expect(q.tiers).toBe(1);
      expect(q.priceEurCents).toBe(500);
    }
  });

  it("a short story pays the same as a full novel — the floor is deliberate", () => {
    const story = priceJob(env, { estimatedTokens: 50_000, words: 3_000 });
    const novel = priceJob(env, { estimatedTokens: 1_070_000, words: 100_000 });
    expect(story.priceEurCents).toBe(novel.priceEurCents);
  });

  it("crossing a band costs another band", () => {
    expect(priceJob(env, { estimatedTokens: 1, words: 100_001 }).priceEurCents).toBe(1000);
    expect(priceJob(env, { estimatedTokens: 1, words: 200_000 }).priceEurCents).toBe(1000);
    expect(priceJob(env, { estimatedTokens: 1, words: 200_001 }).priceEurCents).toBe(1500);
  });

  it("price does not depend on the token estimate", () => {
    const cheap = priceJob(env, { estimatedTokens: 10_000, words: 50_000 });
    const dear = priceJob(env, { estimatedTokens: 5_000_000, words: 50_000 });
    expect(cheap.priceEurCents).toBe(dear.priceEurCents);
    // ...but the estimate is still carried, because it sizes the ledger ceiling.
    expect(dear.tokens).toBe(5_000_000);
  });

  it("falls back to band one when an older client sends no word count", () => {
    const q = priceJob(env, { estimatedTokens: 1_000_000, words: 1 });
    expect(q.priceEurCents).toBe(500);
  });
});
