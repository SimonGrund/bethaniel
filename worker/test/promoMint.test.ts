// ── Minting discount codes over HTTP ──
//
// Two properties matter most. The minting token must open the promo routes
// and nothing else — the refund machinery stays behind ADMIN_TOKEN — and it
// must be confined to "site-" campaigns, so the website can neither mint
// under nor void a code the operator made by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isPromoMintRequest } from "../src/admin.ts";
import { validateMint, parseCodes, isoSeconds } from "../src/promoMint.ts";
import worker from "../src/index.ts";
import type { Env } from "../src/env.ts";

const ADMIN = "a".repeat(40);
const MINT = "m".repeat(40);
const NOW = new Date("2026-09-30T12:00:00.123Z");

const mint = (over: Record<string, unknown> = {}) => ({
  codes: ["betty-abcd-efgh"],
  campaign: "site-welcome",
  discount_pct: 50,
  max_uses: 1,
  products: ["edit", "readthrough"],
  ...over,
});

/* ── Validation ── */

test("a well-formed mint becomes rows the table's own way", () => {
  const v = validateMint(mint({ expires_at: "2026-12-31T23:59:59.500Z" }), NOW, true);
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(v.value, [{
    code: "BETTY-ABCD-EFGH",
    campaign: "site-welcome",
    discount_pct: 50,
    discount_cents: null,
    max_uses: 1,
    max_uses_per_product: null,
    max_words: null,
    products: '["edit","readthrough"]',
    created_at: "2026-09-30T12:00:00Z",
    expires_at: "2026-12-31T23:59:59Z",
  }]);
});

test("the minting token mints only under site- campaigns; the admin token anywhere", () => {
  assert.equal(validateMint(mint({ campaign: "launch" }), NOW, true).ok, false);
  assert.equal(validateMint(mint({ campaign: "launch" }), NOW, false).ok, true);
});

test("bad values are refused rather than stored", () => {
  const bad: Record<string, unknown>[] = [
    { codes: [] },
    { codes: Array.from({ length: 51 }, (_, i) => `CODE-${i}`) },
    { codes: ["ab"] },
    { codes: ["has space"] },
    { campaign: "Site-Welcome" },
    { discount_pct: 0 },
    { discount_pct: 101 },
    { discount_pct: 12.5 },
    { discount_pct: null },
    { max_uses: 0 },
    { max_uses: 1001 },
    { max_uses_per_product: 2 },
    { products: ["edit", "print"] },
    { products: "edit" },
    { expires_at: "2020-01-01T00:00:00Z" },
    { expires_at: "next week" },
    { max_words: -5 },
  ];
  for (const over of bad) {
    assert.equal(validateMint(mint(over), NOW, true).ok, false, JSON.stringify(over));
  }
  assert.equal(validateMint("nope", NOW, true).ok, false);
});

test("an empty products list means every product, not none", () => {
  const v = validateMint(mint({ products: [] }), NOW, true);
  assert.equal(v.ok && v.value[0].products, null);
});

test("a fixed discount alone is enough", () => {
  const v = validateMint(mint({ discount_pct: undefined, discount_cents: 250 }), NOW, true);
  assert.equal(v.ok && v.value[0].discount_cents, 250);
});

test("codes are normalised and de-duplicated", () => {
  const c = parseCodes([" betty-1234 ", "BETTY-1234", "other-code"], 50);
  assert.deepEqual(c.ok && c.value, ["BETTY-1234", "OTHER-CODE"]);
});

test("isoSeconds drops milliseconds, matching the rows written by hand", () => {
  assert.equal(isoSeconds(new Date("2026-09-30T12:00:00.999Z")), "2026-09-30T12:00:00Z");
});

/* ── The token ── */

const req = (path: string, auth?: string, body?: unknown) =>
  new Request(`https://x${path}`, {
    method: "POST",
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

test("the minting token fails closed", () => {
  for (const secret of [undefined, "", "short"]) {
    const env = { PROMO_MINT_TOKEN: secret } as unknown as Env;
    assert.equal(isPromoMintRequest(req("/admin/promo", MINT), env), false, JSON.stringify(secret));
  }
  const env = { PROMO_MINT_TOKEN: MINT } as unknown as Env;
  assert.equal(isPromoMintRequest(req("/admin/promo", MINT), env), true);
  assert.equal(isPromoMintRequest(req("/admin/promo", ADMIN), env), false);
});

/* ── The routes, end to end against a fake D1 ── */

function fakeEnv() {
  const sql: string[] = [];
  const stmt = (text: string) => {
    const s = {
      bind: () => s,
      run: async () => { sql.push(text); return { meta: { changes: 1 } }; },
      all: async () => { sql.push(text); return { results: [] }; },
      first: async () => null,
    };
    return s;
  };
  const DB = {
    prepare: (text: string) => stmt(text),
    batch: async (stmts: unknown[]) => { sql.push("batch"); return stmts.map(() => ({ meta: { changes: 1 } })); },
  };
  const env = { DB, ADMIN_TOKEN: ADMIN, PROMO_MINT_TOKEN: MINT } as unknown as Env;
  return { env, sql };
}

const call = (path: string, auth: string | undefined, body?: unknown) => {
  const { env, sql } = fakeEnv();
  return worker.fetch(req(path, auth, body), env, {} as ExecutionContext).then(async (res) => ({
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
    sql,
  }));
};

test("the minting token reaches the promo routes", async () => {
  const r = await call("/admin/promo", MINT, mint());
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.minted, ["BETTY-ABCD-EFGH"]);
});

test("the minting token gets a 404 everywhere else under /admin/", async () => {
  for (const path of ["/admin/sweep", "/admin/refund", "/admin/failures/ack"]) {
    const r = await call(path, MINT, { credentialId: "x", action: "refund" });
    assert.equal(r.status, 404, path);
    assert.deepEqual(r.sql, [], `${path} touched the database`);
  }
});

test("no token, or a wrong one, gets the same 404 on the promo routes", async () => {
  for (const auth of [undefined, "wrong-token-wrong-token"]) {
    const r = await call("/admin/promo", auth, mint());
    assert.equal(r.status, 404);
    assert.deepEqual(r.sql, []);
  }
});

test("void and lookup under the minting token are confined to site- campaigns", async () => {
  const v = await call("/admin/promo/void", MINT, { codes: ["LAUNCH100"] });
  assert.equal(v.status, 200);
  assert.match(v.sql[0], /campaign LIKE 'site-%'/);
  const l = await call("/admin/promo/lookup", MINT, { codes: ["LAUNCH100"] });
  assert.match(l.sql[0], /campaign LIKE 'site-%'/);
  const a = await call("/admin/promo/void", ADMIN, { codes: ["LAUNCH100"] });
  assert.doesNotMatch(a.sql[0], /campaign LIKE/);
});
