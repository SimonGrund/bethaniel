// ── Operator access ──
//
// The Worker holds state that only a human can act on: credentials flagged
// for a refund decision, an expiry sweep that needs running when the cron has
// not, a credential that must be killed because it leaked. None of that has a
// home in the OpenAI-compatible surface the app talks to, so it lives under
// /admin/* behind its own secret.
//
// Design notes, all of which matter more because this repo is public:
//
//  - **Fail closed.** No ADMIN_TOKEN means no admin surface at all. A
//    deployment that forgot the secret must not expose an open one.
//  - **404, not 401.** An unauthenticated caller is told the route does not
//    exist, so /admin/* is not discoverable by probing a URL anyone can read
//    in wrangler.toml. 401 would confirm what to attack.
//  - **Constant-time comparison**, so a wrong token cannot be refined one
//    character at a time from response timing.
//  - The admin token is unrelated to a credential token. A leaked customer
//    credential reaches inference and nothing here.

import type { Env } from "./env";

/** Byte-for-byte comparison that does not return early on the first
 *  difference. Length is allowed to leak; the content is not. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True only for a request bearing the configured admin token.
 *
 * Returns false — never throws, never distinguishes — when the secret is
 * unset, so the caller's single "not authorised" branch covers both the
 * misconfigured deployment and the unauthorised caller.
 */
export function isAdminRequest(request: Request, env: Env): boolean {
  const expected = env.ADMIN_TOKEN;
  if (!expected || expected.length < 16) return false;
  const header = request.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return false;
  return constantTimeEqual(presented, expected);
}

/**
 * True only for a request bearing the promo-minting token — a second,
 * narrower secret for a caller that should be able to make discount codes
 * and nothing else. The website's newsletter mints a welcome code per
 * subscriber; if the website were ever compromised, this token reaches the
 * /admin/promo routes and not the refund machinery behind ADMIN_TOKEN.
 *
 * Same rules as isAdminRequest: fails closed, at least 16 characters,
 * constant-time. The routes it opens are listed in PROMO_ROUTES
 * (promoMint.ts), and index.ts admits it nowhere else.
 */
export function isPromoMintRequest(request: Request, env: Env): boolean {
  const expected = env.PROMO_MINT_TOKEN;
  if (!expected || expected.length < 16) return false;
  const header = request.headers.get("Authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return false;
  return constantTimeEqual(presented, expected);
}
