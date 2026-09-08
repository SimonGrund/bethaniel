// ── GlobalMeter unit tests ──
//
// This DO is the only hard ceiling on what Bethaniel can spend upstream in a
// day — the provider offers alerts but no cap — so its behaviour is worth
// asserting rather than assuming. Cloudflare's DO runtime is stubbed here:
// only `storage.get/put` and `blockConcurrencyWhile` are used, so a Map and a
// pass-through are a faithful enough stand-in for the logic under test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GlobalMeter } from "../src/globalMeter.ts";
import type { Env } from "../src/env.ts";

function makeState() {
  const store = new Map<string, unknown>();
  return {
    storage: {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
    },
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
  };
}

function makeMeter(ceiling: string) {
  const env = { DAILY_TOKEN_CEILING: ceiling } as unknown as Env;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new GlobalMeter(makeState() as any, env);
}

const post = (m: GlobalMeter, path: string, body: unknown) =>
  m.fetch(
    new Request(`https://meter${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

const status = async (m: GlobalMeter) =>
  (await m.fetch(new Request("https://meter/status"))).json() as Promise<{
    ceiling: number;
    reserved: number;
    spent: number;
    used: number;
    remaining: number;
    liveHolds: number;
  }>;

test("reserves under the ceiling and reports what is left", async () => {
  const m = makeMeter("1000");
  const res = await post(m, "/reserve", { holdTokens: 400 });
  assert.equal(res.status, 200);
  const s = await status(m);
  assert.equal(s.reserved, 400);
  assert.equal(s.remaining, 600);
});

test("refuses the request that would cross the ceiling", async () => {
  const m = makeMeter("1000");
  await post(m, "/reserve", { holdTokens: 900 });
  const res = await post(m, "/reserve", { holdTokens: 200 });
  assert.equal(res.status, 503);
  assert.equal((await res.json() as { reason: string }).reason, "daily_ceiling_reached");
  // The refused hold must not be counted — otherwise repeated refusals would
  // silently consume the very budget they were denied.
  assert.equal((await status(m)).reserved, 900);
});

test("an unset or malformed ceiling fails CLOSED, not open", async () => {
  for (const bad of ["", "0", "not-a-number", "-5"]) {
    const res = await post(makeMeter(bad), "/reserve", { holdTokens: 1 });
    assert.equal(res.status, 503, `ceiling ${JSON.stringify(bad)} should refuse`);
  }
});

test("commit converts a hold into spend, releasing the unused remainder", async () => {
  const m = makeMeter("10000");
  const { holdId } = (await (await post(m, "/reserve", { holdTokens: 5000 })).json()) as {
    holdId: string;
  };
  await post(m, "/commit", { holdId, actualTokens: 1200 });
  const s = await status(m);
  assert.equal(s.reserved, 0, "hold fully released");
  assert.equal(s.spent, 1200, "only real usage counted");
  assert.equal(s.remaining, 8800, "the other 3800 went back to the pool");
  assert.equal(s.liveHolds, 0);
});

test("release returns a hold without recording any spend", async () => {
  const m = makeMeter("10000");
  const { holdId } = (await (await post(m, "/reserve", { holdTokens: 5000 })).json()) as {
    holdId: string;
  };
  await post(m, "/release", { holdId });
  const s = await status(m);
  assert.equal(s.reserved, 0);
  assert.equal(s.spent, 0);
  assert.equal(s.remaining, 10000);
});

test("holds accumulate, so concurrent requests cannot jointly overshoot", async () => {
  const m = makeMeter("1000");
  // Ten concurrent 100-token holds exactly fill the ceiling...
  const oks = await Promise.all(
    Array.from({ length: 10 }, () => post(m, "/reserve", { holdTokens: 100 })),
  );
  assert.ok(oks.every((r) => r.status === 200));
  // ...and the eleventh is refused, even though nothing has committed yet.
  assert.equal((await post(m, "/reserve", { holdTokens: 1 })).status, 503);
  assert.equal((await status(m)).remaining, 0);
});

test("an unknown holdId still records the spend rather than losing it", async () => {
  const m = makeMeter("10000");
  await post(m, "/commit", { holdId: "vanished", actualTokens: 700 });
  assert.equal((await status(m)).spent, 700);
});

test("commit never lets a negative actualTokens credit the meter back", async () => {
  const m = makeMeter("10000");
  const { holdId } = (await (await post(m, "/reserve", { holdTokens: 500 })).json()) as {
    holdId: string;
  };
  await post(m, "/commit", { holdId, actualTokens: -9999 });
  const s = await status(m);
  assert.equal(s.spent, 0);
  assert.ok(s.remaining <= 10000);
});

test("unknown routes are rejected", async () => {
  const res = await makeMeter("1000").fetch(new Request("https://meter/whatever"));
  assert.equal(res.status, 404);
});
