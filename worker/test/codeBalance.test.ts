// ── What a code has left, per product ──
//
// The app puts a note on every task card a code can pay for ("2 free runs
// left, up to 200,000 words"), so it needs the balance resolved PER PRODUCT
// rather than the two raw counters. The arithmetic is here, once, because
// /v1/code and /v1/quote both answer with it and must never disagree.
//
// Fixtures are the real rows in production, including the readthrough-only
// shape: max_uses_per_product with the other three products pre-spent, which
// is how a code is bound to one product when the schema has no column for it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { codeBalance } from "../src/quote.ts";
import type { PromoRow } from "../src/db.ts";

const row = (over: Partial<PromoRow>): PromoRow => ({
  code: "TEST",
  campaign: "comp",
  discount_pct: 100,
  discount_cents: null,
  max_uses: 1,
  uses: 0,
  max_words: 200_000,
  max_uses_per_product: null,
  product_uses: "{}",
  created_at: "2026-09-16T00:00:00Z",
  expires_at: null,
  status: "active",
  ...over,
});

test("a shared pool offers its whole count to every product", () => {
  const b = codeBalance(row({ max_uses: 3, uses: 0 }));
  assert.equal(b.shared, true);
  assert.deepEqual(b.runsLeft, {
    edit: 3,
    readthrough: 3,
    translate: 3,
    enhance: 3,
  });
});

test("a shared pool counts down as it is spent, on every card at once", () => {
  // Three runs, one taken: every card says two, because two is what is left
  // to spend — not two each.
  const b = codeBalance(row({ max_uses: 3, uses: 1 }));
  assert.deepEqual(b.runsLeft, {
    edit: 2,
    readthrough: 2,
    translate: 2,
    enhance: 2,
  });
});

test("a per-product cap is not shared, and each product counts alone", () => {
  // FOURRUNS200K: one of each, one readthrough already taken.
  const b = codeBalance(
    row({
      code: "FOURRUNS200K",
      max_uses: 4,
      uses: 1,
      max_uses_per_product: 1,
      product_uses: '{"readthrough":1}',
    }),
  );
  assert.equal(b.shared, false);
  assert.deepEqual(b.runsLeft, {
    edit: 1,
    readthrough: 0,
    translate: 1,
    enhance: 1,
  });
});

test("a code bound to one product by pre-spending the others", () => {
  // SCAN2X200K, live: readthrough-only, one of its two uses taken.
  const b = codeBalance(
    row({
      code: "SCAN2X200K",
      max_uses: 2,
      uses: 1,
      max_uses_per_product: 2,
      product_uses: '{"readthrough":1,"edit":2,"translate":2,"enhance":2}',
    }),
  );
  assert.deepEqual(b.runsLeft, {
    edit: 0,
    readthrough: 1,
    translate: 0,
    enhance: 0,
  });
});

test("the total pool caps a per-product count, never the other way round", () => {
  // Two uses left in total, but three allowed per product: the pool wins, or
  // the card would promise a third run the ledger refuses.
  const b = codeBalance(
    row({ max_uses: 5, uses: 3, max_uses_per_product: 3, product_uses: "{}" }),
  );
  assert.deepEqual(b.runsLeft, {
    edit: 2,
    readthrough: 2,
    translate: 2,
    enhance: 2,
  });
});

test("a spent code has nothing left anywhere, and never goes negative", () => {
  const b = codeBalance(row({ max_uses: 2, uses: 2 }));
  assert.deepEqual(b.runsLeft, {
    edit: 0,
    readthrough: 0,
    translate: 0,
    enhance: 0,
  });
});

test("only a code that makes a run free is free", () => {
  assert.equal(codeBalance(row({ discount_pct: 100 })).free, true);
  assert.equal(codeBalance(row({ discount_pct: 50 })).free, false);
  assert.equal(
    codeBalance(row({ discount_pct: null, discount_cents: 500 })).free,
    false,
  );
});

test("the word cap and the code are carried through for the note", () => {
  const b = codeBalance(row({ code: "scan2x200k", max_words: 200_000 }));
  assert.equal(b.maxWords, 200_000);
  assert.equal(b.code, "scan2x200k");
});

test("a code with no word cap says so, rather than guessing one", () => {
  assert.equal(codeBalance(row({ max_words: null })).maxWords, null);
});

test("unparsable product_uses counts as none taken, not as a crash", () => {
  const b = codeBalance(
    row({ max_uses: 2, max_uses_per_product: 1, product_uses: "not json" }),
  );
  assert.deepEqual(b.runsLeft, {
    edit: 1,
    readthrough: 1,
    translate: 1,
    enhance: 1,
  });
});

// ── A code that does not cover a product has no runs left on it ──
//
// codeBalance is what the app puts on the task cards. The comment on it is
// explicit that the answer must be the SAME one the price is computed from,
// "or a card promises a free run the checkout then charges for". A scope is
// exactly that risk: without this, an edit-only code would advertise free
// translations and priceJob would refuse them.

test("a scoped code shows runs only on the products it covers", () => {
  const b = codeBalance({
    code: "LANCE100K",
    campaign: null,
    discount_pct: 100,
    discount_cents: null,
    max_uses: 6,
    uses: 0,
    max_words: 100_000,
    max_uses_per_product: 2,
    product_uses: "{}",
    products: '["edit","readthrough","enhance"]',
    created_at: "2026-09-24T00:00:00.000Z",
    expires_at: null,
    status: "active",
  } as never);
  assert.equal(b.runsLeft.edit, 2);
  assert.equal(b.runsLeft.readthrough, 2);
  assert.equal(b.runsLeft.enhance, 2);
  assert.equal(b.runsLeft.translate, 0, "not covered — the card must not offer it");
});

test("an unscoped code is unchanged", () => {
  const b = codeBalance({
    code: "OPEN",
    campaign: null,
    discount_pct: 100,
    discount_cents: null,
    max_uses: 4,
    uses: 0,
    max_words: null,
    max_uses_per_product: 1,
    product_uses: "{}",
    products: null,
    created_at: "2026-09-24T00:00:00.000Z",
    expires_at: null,
    status: "active",
  } as never);
  for (const p of ["edit", "readthrough", "translate", "enhance"] as const) {
    assert.equal(b.runsLeft[p], 1, p);
  }
});
