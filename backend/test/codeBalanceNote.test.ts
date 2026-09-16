// ── What a task card says about a promo code ──
//
// The mapping from a code's balance to the line on a card. Kept pure and
// tested from here because the frontend has no test runner, the same way
// textLocate.test.ts reaches across for the correction locator.
//
// The two things worth pinning: a shared pool must never read as a per-card
// count (an author who sees "3 free runs" on four cards must not conclude
// they hold twelve), and every card the code cannot pay for says nothing at
// all — no price, no apology, exactly what it shows today.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  noteFor,
  PRODUCT_FOR_CARD,
  type CodeBalance,
} from "../../frontend/src/codeBalanceNote.ts";

const balance = (over: Partial<CodeBalance> = {}): CodeBalance => ({
  code: "SCAN2X200K",
  maxWords: 200_000,
  free: true,
  shared: false,
  runsLeft: { edit: 0, readthrough: 1, translate: 0, enhance: 0 },
  ...over,
});

test("each front card asks about its own product", () => {
  assert.deepEqual(PRODUCT_FOR_CARD, {
    edit: "edit",
    readthrough: "readthrough",
    translate: "translate",
    // The language card's cloud run is the enhanced analysis — the one card
    // whose name and product differ.
    language: "enhance",
  });
});

test("a per-product code speaks only on the card it covers", () => {
  const b = balance();
  assert.deepEqual(noteFor(b, "readthrough"), {
    key: "cloud_code_runs_card_one",
    runs: 1,
    maxWords: 200_000,
  });
  for (const card of ["edit", "translate", "language"] as const) {
    assert.equal(noteFor(b, card), null);
  }
});

test("a shared pool says so, on every card", () => {
  const b = balance({
    shared: true,
    runsLeft: { edit: 3, readthrough: 3, translate: 3, enhance: 3 },
  });
  for (const card of ["edit", "readthrough", "translate", "language"] as const) {
    assert.deepEqual(noteFor(b, card), {
      key: "cloud_code_runs_shared",
      runs: 3,
      maxWords: 200_000,
    });
  }
});

test("one run left reads as one run, not as 1 runs", () => {
  assert.equal(
    noteFor(balance({ shared: true, runsLeft: { edit: 1, readthrough: 1, translate: 1, enhance: 1 } }), "edit")?.key,
    "cloud_code_runs_shared_one",
  );
  assert.equal(noteFor(balance(), "readthrough")?.key, "cloud_code_runs_card_one");
});

test("more than one run on a capped code is still a per-card count", () => {
  const b = balance({ runsLeft: { edit: 0, readthrough: 2, translate: 0, enhance: 0 } });
  assert.deepEqual(noteFor(b, "readthrough"), {
    key: "cloud_code_runs_card",
    runs: 2,
    maxWords: 200_000,
  });
});

test("a code with no word cap drops the clause rather than printing null", () => {
  const b = balance({ maxWords: null });
  assert.equal(noteFor(b, "readthrough")?.maxWords, null);
});

test("a code that does not make a run free says nothing", () => {
  // Half price is a real discount and still shows at quote time; it is just
  // not "free runs", and saying so would be a lie.
  assert.equal(noteFor(balance({ free: false }), "readthrough"), null);
});

test("a spent code says nothing anywhere", () => {
  const b = balance({ runsLeft: { edit: 0, readthrough: 0, translate: 0, enhance: 0 } });
  for (const card of ["edit", "readthrough", "translate", "language"] as const) {
    assert.equal(noteFor(b, card), null);
  }
});

test("no code, or a balance that never arrived, says nothing", () => {
  assert.equal(noteFor(null, "readthrough"), null);
  assert.equal(noteFor(undefined, "readthrough"), null);
});

test("a malformed balance is treated as no balance, not as a crash", () => {
  // The Worker may be older than this app, or a proxy may answer something
  // unexpected. The cards must degrade to silence.
  assert.equal(noteFor({ known: false } as unknown as CodeBalance, "readthrough"), null);
  assert.equal(noteFor({ ...balance(), runsLeft: undefined } as unknown as CodeBalance, "readthrough"), null);
});
