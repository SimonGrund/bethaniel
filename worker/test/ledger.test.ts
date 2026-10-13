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

// ── Holds: pacing, settlement and orphans ──
//
// Measured 13 October 2026 on a test credential: 1,359,317 tokens stuck in
// holds with nothing running, a third of its budget. Every ledger call went
// through the per-credential rate limiter, so under a burst of short calls
// the proxy's background commits were refused — and fetch does not throw on a
// 429, so nothing noticed. Only taking a hold is paced now, and a hold whose
// settlement never arrives expires.

import { CredentialLedger, RESERVATION_TTL_MS } from "../src/ledger";

function fakeState(stored: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(stored));
  return {
    data,
    storage: {
      get: async (k: string) => data.get(k),
      put: async (k: string, v: unknown) => void data.set(k, JSON.parse(JSON.stringify(v))),
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
}

async function ledgerWith(budgetTotal: number, stored?: Record<string, unknown>) {
  const state = fakeState(stored);
  const l = new CredentialLedger(state as never, {} as never);
  await new Promise((r) => setTimeout(r, 0));
  if (!stored) {
    await l.fetch(new Request("https://ledger/init", {
      method: "POST",
      body: JSON.stringify({ budgetTotal, expiresAt: new Date(Date.now() + 864e5).toISOString() }),
    }));
  }
  return { l, state };
}
const call = (l: CredentialLedger, path: string, body?: unknown) =>
  l.fetch(new Request(`https://ledger${path}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
const status = async (l: CredentialLedger) => (await (await call(l, "/status")).json()) as { reserved: number; spent: number; remaining: number };

test("settling a hold is never rate-limited; only taking one is", async () => {
  const { l } = await ledgerWith(100_000_000);
  const ids: string[] = [];
  let refused = 0;
  for (let i = 0; i < 1300; i++) {
    const res = await call(l, "/reserve", { holdTokens: 10 });
    if (res.status === 429) { refused++; continue; }
    ids.push(((await res.json()) as { reservationId: string }).reservationId);
  }
  assert.ok(refused > 0, "taking holds past the limit is paced");
  for (const id of ids) {
    const res = await call(l, "/commit", { reservationId: id, actualTokens: 5 });
    assert.equal(res.status, 200);
  }
  const s = await status(l);
  assert.equal(s.reserved, 0);
  assert.equal(s.spent, ids.length * 5);
});

test("a hold whose settlement never arrives expires and its budget comes back", async () => {
  const { l } = await ledgerWith(1_000);
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0;
    assert.equal((await call(l, "/reserve", { holdTokens: 1_100 })).status, 200);
    // Within the ceiling (1,200) only 100 is left.
    assert.equal((await call(l, "/reserve", { holdTokens: 500 })).status, 402);
    Date.now = () => t0 + RESERVATION_TTL_MS + 1;
    assert.equal((await call(l, "/reserve", { holdTokens: 500 })).status, 200);
    assert.equal((await status(l)).reserved, 500);
  } finally {
    Date.now = realNow;
  }
});

test("holds stored before they carried a time expire after loading, not never", async () => {
  const realNow = Date.now;
  try {
    const t0 = realNow();
    Date.now = () => t0;
    const { l } = await ledgerWith(10_000, {
      ledger: { budgetTotal: 10_000, reserved: 9_000, spent: 0, status: "active", expiresAt: new Date(t0 + 864e5).toISOString(), initialized: true },
      reservations: { a: 4_000, b: 5_000 },
    });
    assert.equal((await status(l)).reserved, 9_000);
    Date.now = () => t0 + RESERVATION_TTL_MS + 1;
    assert.equal((await status(l)).reserved, 0);
  } finally {
    Date.now = realNow;
  }
});
