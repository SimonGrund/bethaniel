// ── The live-key guard ──
//
// Test and live Stripe keys differ by four characters and both mint sessions
// that look alike from the outside, so the mistake this guards against — a
// live key pasted in while walking the flow — is invisible until a real card
// is charged. It happened once during the first deploy walkthrough; these
// tests are what stop it happening silently again.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPaymentsAllowed } from "../src/stripe.ts";
import type { Env } from "../src/env.ts";

const envWith = (over: Partial<Env>) => over as unknown as Env;

test("a test key passes whatever the flag says", () => {
  assertPaymentsAllowed(envWith({ STRIPE_SECRET_KEY: "sk_test_abc" }));
  assertPaymentsAllowed(
    envWith({ STRIPE_SECRET_KEY: "sk_test_abc", ALLOW_LIVE_PAYMENTS: "false" }),
  );
});

test("a live key is refused by default — of every kind Stripe issues", () => {
  // rk_live_ is a RESTRICTED live key, which is what this Worker should be
  // using: it needs only Checkout Sessions and Refunds. An earlier version
  // tested for "sk_live_" alone, so choosing the safer key silently defeated
  // the guard and took real money with the switch off.
  for (const key of ["sk_live_abc", "rk_live_abc"]) {
    assert.throws(
      () => assertPaymentsAllowed(envWith({ STRIPE_SECRET_KEY: key })),
      /live key/,
      key,
    );
  }
});

test("a restricted TEST key still passes — rk is not by itself live", () => {
  assertPaymentsAllowed(envWith({ STRIPE_SECRET_KEY: "rk_test_abc" }));
});

test("only the exact string \"true\" opens the gate", () => {
  for (const flag of ["false", "TRUE", "1", "yes", ""]) {
    assert.throws(
      () =>
        assertPaymentsAllowed(
          envWith({ STRIPE_SECRET_KEY: "sk_live_abc", ALLOW_LIVE_PAYMENTS: flag }),
        ),
      /live key/,
      `ALLOW_LIVE_PAYMENTS=${JSON.stringify(flag)} must not allow a live charge`,
    );
  }
  assertPaymentsAllowed(
    envWith({ STRIPE_SECRET_KEY: "sk_live_abc", ALLOW_LIVE_PAYMENTS: "true" }),
  );
});

test("a missing key does not throw — Stripe's own auth error is clearer", () => {
  assertPaymentsAllowed(envWith({}));
});
