// ── Prices in the author's own currency ──
//
// Americans pay in dollars, Danes in kroner, everyone else in euros — at set
// prices, not at a conversion. These pin what would be easy to get wrong:
// that the band maths is the same in every currency, that a euro-minted
// discount means the same share everywhere, and that an app from before
// currencies is never priced in anything but euros.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bandPrice, currencyForCountry, priceJob } from "../src/quote.ts";
import type { Env } from "../src/env.ts";

const env = {
  PRICE_TIER_WORDS: "100000",
  PRICE_TIER_EUR_CENTS: "500",
  PRICE_TRANSLATE_EUR_CENTS: "1200",
  PRICE_ENHANCE_EUR_CENTS: "200",
  PRICE_TIER_USD_CENTS: "599",
  PRICE_TRANSLATE_USD_CENTS: "1399",
  PRICE_ENHANCE_USD_CENTS: "249",
  PRICE_TIER_DKK_ORE: "3900",
  PRICE_TRANSLATE_DKK_ORE: "8900",
  PRICE_ENHANCE_DKK_ORE: "1500",
} as unknown as Env;

test("the United States pays in dollars, the Danish realm in kroner, the rest in euros", () => {
  assert.equal(currencyForCountry("US"), "usd");
  for (const c of ["DK", "dk", " GL ", "FO"]) assert.equal(currencyForCountry(c), "dkk");
  for (const c of ["DE", "FR", "GB", "SE", "CA", "", null, undefined]) {
    assert.equal(currencyForCountry(c), "eur");
  }
});

test("each product has its own band in each currency", () => {
  assert.equal(bandPrice(env, "edit", "usd"), 599);
  assert.equal(bandPrice(env, "readthrough", "usd"), 599);
  assert.equal(bandPrice(env, "translate", "usd"), 1399);
  assert.equal(bandPrice(env, "enhance", "usd"), 249);
  assert.equal(bandPrice(env, "edit", "dkk"), 3900);
  assert.equal(bandPrice(env, "translate", "dkk"), 8900);
  assert.equal(bandPrice(env, "enhance", "dkk"), 1500);
  assert.equal(bandPrice(env, "edit", "eur"), 500);
});

test("an unset var sells at the published price, never at zero", () => {
  const bare = { PRICE_TIER_WORDS: "100000" } as unknown as Env;
  assert.equal(bandPrice(bare, "edit", "usd"), 599);
  assert.equal(bandPrice(bare, "translate", "dkk"), 8900);
  assert.equal(bandPrice(bare, "enhance", "eur"), 200);
});

test("bands multiply the same way in every currency", () => {
  const q = priceJob(env, { estimatedTokens: 1, words: 250_000, currency: "dkk" });
  assert.equal(q.tiers, 3);
  assert.equal(q.currency, "dkk");
  assert.equal(q.priceCents, 3 * 3900);
  assert.equal(q.fullPriceCents, 3 * 3900);
  // The euro list price of the same job travels with it.
  assert.equal(q.priceEurCents, 3 * 500);
});

test("no currency is a euro quote, and the two prices agree", () => {
  const q = priceJob(env, { estimatedTokens: 1, words: 50_000 });
  assert.equal(q.currency, "eur");
  assert.equal(q.priceCents, 500);
  assert.equal(q.priceEurCents, 500);
});

test("a percentage code takes the same share in every currency", () => {
  const q = priceJob(
    env,
    { estimatedTokens: 1, words: 50_000, currency: "usd" },
    { code: "HALF", discountPct: 50 },
  );
  assert.equal(q.priceCents, 300); // 599 / 2, rounded
  assert.equal(q.fullPriceCents, 599);
  assert.equal(q.appliedCode, "HALF");
});

test("a free code is free in every currency", () => {
  for (const currency of ["eur", "usd", "dkk"] as const) {
    const q = priceJob(
      env,
      { estimatedTokens: 1, words: 50_000, product: "translate", currency },
      { code: "COMP", discountPct: 100 },
    );
    assert.equal(q.priceCents, 0, currency);
  }
});

test("a fixed euro discount is the same share of the band, not a conversion", () => {
  // EUR 2 off a EUR 5 band is 40%; so it is 40% off 39 kr. and off $5.99.
  const dkk = priceJob(
    env,
    { estimatedTokens: 1, words: 50_000, currency: "dkk" },
    { code: "TWO", discountCents: 200 },
  );
  assert.equal(dkk.priceCents, 3900 - 1560);
  const usd = priceJob(
    env,
    { estimatedTokens: 1, words: 50_000, currency: "usd" },
    { code: "TWO", discountCents: 200 },
  );
  assert.equal(usd.priceCents, 599 - 240);
  assert.equal(usd.priceEurCents, 300);
});

test("a refused code leaves the local price whole", () => {
  const q = priceJob(
    env,
    { estimatedTokens: 1, words: 150_000, currency: "usd" },
    { code: "SMALL", discountPct: 100, maxWords: 5_000 },
  );
  assert.equal(q.priceCents, 2 * 599);
  assert.equal(q.currency, "usd");
  assert.match(q.codeRejectedReason ?? "", /5,000 words/);
});
