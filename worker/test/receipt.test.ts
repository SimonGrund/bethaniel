// ── The buyer's receipt link (stripe.ts) ──

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchReceiptUrl, receiptUrlOf } from "../src/stripe.ts";
import type { Env } from "../src/env.ts";

test("the receipt link is read from the session's expanded charge", () => {
  const url = "https://pay.stripe.com/receipts/payment/abc";
  assert.equal(receiptUrlOf({ payment_intent: { latest_charge: { receipt_url: url } } }), url);
  // Not expanded, unpaid, free, or not a Stripe link: no receipt.
  assert.equal(receiptUrlOf({ payment_intent: "pi_123" }), null);
  assert.equal(receiptUrlOf({ payment_intent: { latest_charge: "ch_123" } }), null);
  assert.equal(receiptUrlOf({ payment_intent: null }), null);
  assert.equal(receiptUrlOf({ payment_intent: { latest_charge: { receipt_url: "javascript:alert(1)" } } }), null);
  assert.equal(receiptUrlOf(null), null);
});

test("only a real Checkout session id is looked up", async () => {
  let called = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    called++;
    return new Response(JSON.stringify({ payment_intent: { latest_charge: { receipt_url: "https://pay.stripe.com/r" } } }));
  }) as typeof fetch;
  try {
    const env = { STRIPE_SECRET_KEY: "rk_test_x" } as unknown as Env;
    // A promo code's free session, or anything injected, never reaches Stripe.
    assert.equal(await fetchReceiptUrl(env, "free_abc"), null);
    assert.equal(await fetchReceiptUrl(env, "cs_live_a/../../v1/refunds"), null);
    assert.equal(called, 0);
    assert.equal(await fetchReceiptUrl(env, "cs_live_a1B2c3"), "https://pay.stripe.com/r");
    assert.equal(called, 1);
  } finally {
    globalThis.fetch = real;
  }
});
