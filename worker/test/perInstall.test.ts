// ── Codes limited per app install ──
//
// A code can be used N times per install of the app (max_uses_per_install).
// The install is a random UUID the app keeps in its data folder. These pin
// that the price, the task cards and the mint all read the limit the same
// way, and that an app too old to send an id is refused rather than let
// through uncounted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { codeBalance, installRefusal, priceJob } from "../src/quote.ts";
import { parseInstallId, type PromoRow } from "../src/db.ts";
import { validateMint } from "../src/promoMint.ts";
import type { Env } from "../src/env.ts";

const env = {
  PRICE_TIER_WORDS: "100000",
  PRICE_TIER_EUR_CENTS: "500",
  PRICE_TRANSLATE_WORDS: "10000",
  PRICE_TRANSLATE_EUR_CENTS: "150",
} as unknown as Env;

const once = { code: "TRANSLATE50", discountPct: 50, products: ["translate"], maxUsesPerInstall: 1 };
const job = { estimatedTokens: 1_000_000, words: 60_000, product: "translate" as const };

test("an install that has not used the code gets the discount", () => {
  const q = priceJob(env, job, { ...once, installUses: 0 });
  assert.equal(q.appliedCode, "TRANSLATE50");
  assert.equal(q.priceEurCents, 450);
});

test("an install that has used it up pays full price and is told why", () => {
  const q = priceJob(env, job, { ...once, installUses: 1 });
  assert.equal(q.appliedCode, undefined);
  assert.equal(q.priceEurCents, 900);
  assert.match(q.codeRejectedReason ?? "", /already been used on this computer/);
});

test("an app that sends no install id is asked to update, not let through", () => {
  const q = priceJob(env, job, { ...once, installUses: null });
  assert.equal(q.appliedCode, undefined);
  assert.match(q.codeRejectedReason ?? "", /latest version/);
});

test("a code without the limit ignores the install entirely", () => {
  const q = priceJob(env, job, { ...once, maxUsesPerInstall: null, installUses: null });
  assert.equal(q.appliedCode, "TRANSLATE50");
  assert.equal(installRefusal("X", null, 99), null);
});

test("a limit above one counts up to it", () => {
  assert.equal(installRefusal("X", 2, 1), null);
  assert.match(installRefusal("X", 2, 2) ?? "", /2 times/);
});

const row = (over: Partial<PromoRow>): PromoRow => ({
  code: "TRANSLATE50",
  campaign: "site-ad",
  discount_pct: 50,
  discount_cents: null,
  max_uses: 200,
  uses: 10,
  max_words: null,
  max_uses_per_product: null,
  product_uses: "{}",
  products: '["translate"]',
  created_at: "2026-10-15T00:00:00Z",
  expires_at: null,
  status: "active",
  max_uses_per_install: 1,
  ...over,
});

test("the cards offer this install what it has left, not the whole pool", () => {
  assert.equal(codeBalance(row({}), 0).runsLeft.translate, 1);
  assert.equal(codeBalance(row({}), 1).runsLeft.translate, 0);
  // No id: the code cannot be used from this app, so the cards offer nothing.
  assert.equal(codeBalance(row({}), null).runsLeft.translate, 0);
  // Without the limit the pool is what it was.
  assert.equal(codeBalance(row({ max_uses_per_install: null }), null).runsLeft.translate, 190);
  // The pool still caps it.
  assert.equal(codeBalance(row({ uses: 200, max_uses_per_install: 3 }), 0).runsLeft.translate, 0);
});

test("only a UUID counts as an install id", () => {
  assert.equal(
    parseInstallId(" 3F2504E0-4F89-41D3-9A0C-0305E82C3301 "),
    "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  );
  for (const bad of ["", "abc", 42, null, undefined, "3f2504e0-4f89-41d3-9a0c-0305e82c330"]) {
    assert.equal(parseInstallId(bad), null);
  }
});

test("max_uses_per_install is minted, bounded by max_uses", () => {
  const base = { codes: ["TRANSLATE50"], campaign: "site-ad", discount_pct: 50, max_uses: 200 };
  const now = new Date("2026-10-15T12:00:00Z");
  const ok = validateMint({ ...base, max_uses_per_install: 1 }, now, true);
  assert.equal(ok.ok && ok.value[0].max_uses_per_install, 1);
  const none = validateMint(base, now, true);
  assert.equal(none.ok && none.value[0].max_uses_per_install, null);
  assert.equal(validateMint({ ...base, max_uses_per_install: 0 }, now, true).ok, false);
  assert.equal(validateMint({ ...base, max_uses_per_install: 201 }, now, true).ok, false);
});
