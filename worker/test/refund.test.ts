// ── Reimbursement rules ──
//
// The rule that matters most here is the one that is deliberately absent:
// there is no automatic refund for a partly-used credential, because that is
// farmable (buy a band, edit a few chapters, wait out the expiry, collect).
// These tests pin that boundary so a later "be more generous" change has to
// argue with them first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { refundVerdict, UNUSED_TOKEN_TOLERANCE } from "../src/refund.ts";

const paid = (over: Partial<Parameters<typeof refundVerdict>[0]> = {}) => ({
  stripe_session_id: "cs_test_abc",
  stripe_payment_intent: "pi_abc",
  token_budget: 225_000,
  spent: 0,
  ...over,
});

test("a paid credential that expired unused is refunded", () => {
  assert.equal(refundVerdict(paid()).action, "refund");
});

test("a trivial amount of spend still counts as unused", () => {
  assert.equal(refundVerdict(paid({ spent: UNUSED_TOKEN_TOLERANCE })).action, "refund");
});

test("a partly-used credential is flagged, never auto-refunded", () => {
  // The farming case: real editing happened, so no money goes back on its own.
  for (const spent of [UNUSED_TOKEN_TOLERANCE + 1, 50_000, 112_499]) {
    assert.equal(refundVerdict(paid({ spent })).action, "review", `spent=${spent}`);
  }
});

test("a substantially-used credential gets nothing", () => {
  for (const spent of [112_500, 200_000, 225_000]) {
    assert.equal(refundVerdict(paid({ spent })).action, "none", `spent=${spent}`);
  }
});

test("a free promo credential is never refunded — there was no charge", () => {
  const v = refundVerdict(paid({ stripe_session_id: "promo_xyz", spent: 0 }));
  assert.equal(v.action, "none");
  assert.match(v.reason, /nothing was charged/);
});

test("a paid credential with no payment_intent goes to a human", () => {
  const v = refundVerdict(paid({ stripe_payment_intent: null }));
  assert.equal(v.action, "review");
});

test("a zero budget cannot divide by zero into a refund", () => {
  const v = refundVerdict(paid({ token_budget: 0, spent: 10_000 }));
  assert.equal(v.action, "none");
});
