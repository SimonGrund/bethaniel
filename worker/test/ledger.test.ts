// The credential ceiling, with its overdraft.
//
// A flat lift rather than a retry-only allowance because this Worker proxies
// inference calls and has no concept of a job, a chapter or a retry — any
// "this is a retry" signal could only come from the client, and a
// client-asserted privilege is not a control. The cap is the control, and
// only a job that overran its budget ever reaches it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { OVERDRAFT_FRACTION, spendCeiling } from "../src/ledger";

test("the overdraft is 20 per cent", () => {
  assert.equal(OVERDRAFT_FRACTION, 0.2);
});

test("a credential may spend a fifth beyond its budget, and not a token more", () => {
  assert.equal(spendCeiling(100_000), 120_000);
});

test("the ceiling rounds up, so a small budget still gets its overdraft", () => {
  assert.equal(spendCeiling(3), 4);
});

test("a zero budget stays zero — an unfunded credential buys nothing", () => {
  assert.equal(spendCeiling(0), 0);
});

test("the ceiling is monotonic in the budget", () => {
  // Guards against a refactor that clamps or caps the lift and accidentally
  // makes a bigger budget buy less.
  let previous = -1;
  for (const budget of [0, 1, 1_000, 27_641, 94_868, 285_623, 5_000_000]) {
    const ceiling = spendCeiling(budget);
    assert.ok(ceiling >= budget, `ceiling ${ceiling} below budget ${budget}`);
    assert.ok(ceiling > previous, `ceiling ${ceiling} not above previous ${previous}`);
    previous = ceiling;
  }
});
