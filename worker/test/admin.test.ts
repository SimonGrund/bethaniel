// ── Operator access ──
//
// The property under test is that this fails CLOSED. On a public repo the
// /admin/* prefix is readable by anyone, so the only thing standing between a
// stranger and the refund machinery is that these return false by default.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAdminRequest, constantTimeEqual } from "../src/admin.ts";
import type { Env } from "../src/env.ts";

const TOKEN = "a".repeat(40);
const envWith = (over: Partial<Env>) => over as unknown as Env;
const req = (auth?: string) =>
  new Request("https://x/admin/sweep", {
    method: "POST",
    headers: auth ? { Authorization: auth } : {},
  });

test("the right token is admitted", () => {
  assert.equal(isAdminRequest(req(`Bearer ${TOKEN}`), envWith({ ADMIN_TOKEN: TOKEN })), true);
});

test("no secret configured means no admin surface at all", () => {
  // The dangerous failure: a deployment that forgot the secret must not be
  // wide open, and must not be open to the empty token either.
  for (const secret of [undefined, "", "short"]) {
    assert.equal(
      isAdminRequest(req(`Bearer ${TOKEN}`), envWith({ ADMIN_TOKEN: secret })),
      false,
      `ADMIN_TOKEN=${JSON.stringify(secret)}`,
    );
    assert.equal(isAdminRequest(req("Bearer "), envWith({ ADMIN_TOKEN: secret })), false);
  }
});

test("a wrong, absent, or malformed token is refused", () => {
  const env = envWith({ ADMIN_TOKEN: TOKEN });
  for (const auth of [undefined, "", "Bearer ", "Bearer wrong", TOKEN, `Basic ${TOKEN}`]) {
    assert.equal(isAdminRequest(req(auth), env), false, `auth=${JSON.stringify(auth)}`);
  }
});

test("a token that is a prefix of the real one is refused", () => {
  const env = envWith({ ADMIN_TOKEN: TOKEN });
  assert.equal(isAdminRequest(req(`Bearer ${TOKEN.slice(0, -1)}`), env), false);
  assert.equal(isAdminRequest(req(`Bearer ${TOKEN}x`), env), false);
});

test("constantTimeEqual agrees with equality", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "ab"), false);
  assert.equal(constantTimeEqual("", ""), true);
});
