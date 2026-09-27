// The price on the Run button and in the checkout dialog, in the currency the
// Worker quoted — see frontend/src/formatPrice.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPrice as raw } from "../../frontend/src/formatPrice.ts";

// Intl separates amount and symbol with a non-breaking space, which is what
// keeps "39 kr." on one line. Compared here as a plain space.
const formatPrice = (...a: Parameters<typeof raw>) => raw(...a).replace(/ | /g, " ");

test("dollars and kroner are written the local way in any app language", () => {
  for (const lang of ["en", "da", "de"]) {
    assert.equal(formatPrice(599, "USD", lang), "$5.99");
    assert.equal(formatPrice(3900, "DKK", lang), "39 kr.");
  }
  assert.equal(formatPrice(2340, "dkk", "en"), "23,40 kr.");
});

test("euros follow the app's language, and whole amounts drop the decimals", () => {
  assert.equal(formatPrice(500, "EUR", "en"), "€5");
  assert.equal(formatPrice(500, "EUR", "da"), "5 €");
  assert.equal(formatPrice(250, "EUR", "de"), "2,50 €");
});

test("a backend that sent no currency is a euro quote", () => {
  assert.equal(formatPrice(1200, undefined, "en"), "€12");
});

test("a currency the runtime does not know still shows the amount", () => {
  assert.equal(formatPrice(500, "XYZW", "en"), "5 XYZW");
});
