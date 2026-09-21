// ── "Used up" is told apart from "never existed" ──
//
// /v1/code answered `known: false` for a code that was unknown, expired, void
// OR fully spent — all four identical, so nobody could tell a used code from a
// typo. That confused the person who MINTED the codes, twice, and cost two
// support round trips before anyone thought to read the database.
//
// Spent is safe to reveal where the others are not: a code with nothing left
// is worth nothing, so confirming one exists hands a guesser nothing they can
// spend. Expired and void stay opaque, because those can be reinstated — and a
// code that is about to be reinstated is worth guessing.
//
// The logic mirrors isPromoSpent in src/db.ts; the query is trivial and the
// decision is not, so the decision is what is pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";

interface Row {
  uses: number;
  max_uses: number;
  status: string;
  expires_at: string | null;
}

/** Mirrors isPromoSpent. */
function spent(row: Row | null, now = new Date("2026-09-21T12:00:00Z")): boolean {
  if (!row) return false;
  if (row.status !== "active") return false;
  if (row.expires_at && new Date(row.expires_at) < now) return false;
  return row.uses >= row.max_uses;
}

const row = (p: Partial<Row> = {}): Row => ({
  uses: 0,
  max_uses: 3,
  status: "active",
  expires_at: "2026-12-31T23:59:59Z",
  ...p,
});

test("a code nobody has ever minted is not reported as spent", () => {
  assert.equal(spent(null), false);
});

test("a live code with uses left is not spent", () => {
  assert.equal(spent(row({ uses: 1, max_uses: 3 })), false);
});

test("a code with every use gone is spent, and may be said so", () => {
  assert.equal(spent(row({ uses: 3, max_uses: 3 })), true);
});

test("over-spending still counts as spent", () => {
  // Belt and braces: a release/redeem race could in principle overshoot.
  assert.equal(spent(row({ uses: 4, max_uses: 3 })), true);
});

test("an EXPIRED code stays opaque, even with uses gone", () => {
  // It can be reinstated by moving the date, so confirming it exists is worth
  // something to a guesser.
  assert.equal(
    spent(row({ uses: 3, max_uses: 3, expires_at: "2026-01-01T00:00:00Z" })),
    false,
  );
});

test("a VOID code stays opaque, even with uses gone", () => {
  assert.equal(spent(row({ uses: 3, max_uses: 3, status: "void" })), false);
});

test("a code expiring later today is still live, not expired", () => {
  assert.equal(
    spent(row({ uses: 3, max_uses: 3, expires_at: "2026-09-21T23:59:59Z" })),
    true,
  );
});
