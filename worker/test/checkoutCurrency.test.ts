// The Checkout Session charges the quote's own currency and amount — a
// krone quote must not reach Stripe as the same number of euro cents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCheckoutSession } from "../src/stripe.ts";
import type { Env } from "../src/env.ts";

const env = {
  STRIPE_SECRET_KEY: "sk_test_x",
  CHECKOUT_SUCCESS_URL_BASE: "https://example.test",
} as unknown as Env;

async function sentBody(opts: Parameters<typeof createCheckoutSession>[1]) {
  const real = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    body = String(init?.body ?? "");
    return new Response(JSON.stringify({ id: "cs_1", url: "https://stripe.test/cs_1" }));
  }) as typeof fetch;
  try {
    await createCheckoutSession(env, opts);
  } finally {
    globalThis.fetch = real;
  }
  return new URLSearchParams(body);
}

test("a krone quote is charged in kroner, in øre", async () => {
  const p = await sentBody({ quoteId: "q", tokenBudget: 1, amountCents: 3900, currency: "dkk" });
  assert.equal(p.get("line_items[0][price_data][currency]"), "dkk");
  assert.equal(p.get("line_items[0][price_data][unit_amount]"), "3900");
});

test("a dollar quote is charged in dollars", async () => {
  const p = await sentBody({ quoteId: "q", tokenBudget: 1, amountCents: 599, currency: "usd" });
  assert.equal(p.get("line_items[0][price_data][currency]"), "usd");
});

test("no currency is euros, as every session was before", async () => {
  const p = await sentBody({ quoteId: "q", tokenBudget: 1, amountCents: 500 });
  assert.equal(p.get("line_items[0][price_data][currency]"), "eur");
});
