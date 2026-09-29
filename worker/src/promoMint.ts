// ── Minting discount codes over HTTP ──
//
// The README's hand-written INSERT was a footgun (ISO dates compared as text,
// column names from memory), and docs/admin-surface.md planned this endpoint
// to replace it. It now has a second caller: the website, which mints one
// welcome code per newsletter subscriber and lets its /admin page mint codes
// by hand.
//
// Everything here is pure — the request is checked and turned into rows
// before anything touches D1 — so the rules can be tested without a
// database.

import { CLOUD_PRODUCTS, type CloudProduct } from "./quote";

/** The routes the promo-minting token opens, and the only ones. */
export const PROMO_ROUTES = ["/admin/promo", "/admin/promo/void", "/admin/promo/lookup"];

/** A caller holding only PROMO_MINT_TOKEN may touch codes in these campaigns
 *  and no others — so the website can neither mint under nor void a code the
 *  operator made by hand, like a launch or reviewer code. */
export const SITE_CAMPAIGN_PREFIX = "site-";

export const MAX_CODES_PER_REQUEST = 50;
const MAX_USES = 1000;
const MAX_WORDS = 10_000_000;
const MAX_DISCOUNT_CENTS = 100_000;

/** Stored uppercase and matched case-insensitively, as findPromo expects. */
const CODE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;
const CAMPAIGN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PromoInsert {
  code: string;
  campaign: string;
  discount_pct: number | null;
  discount_cents: number | null;
  max_uses: number;
  max_uses_per_product: number | null;
  max_words: number | null;
  products: string | null;
  created_at: string;
  expires_at: string | null;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** The form the rest of the table uses: whole seconds, `Z`. Compared as text
 *  in redeemPromo, so every row must be spelled the same way. */
export function isoSeconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function intIn(v: unknown, lo: number, hi: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}

/** The codes named in a request: 1..limit of them, normalised, each once. */
export function parseCodes(v: unknown, limit: number): Result<string[]> {
  if (!Array.isArray(v) || v.length === 0 || v.length > limit) {
    return { ok: false, error: `send "codes": an array of 1 to ${limit} codes` };
  }
  const out = new Set<string>();
  for (const raw of v) {
    const code = typeof raw === "string" ? raw.trim().toUpperCase() : "";
    if (!CODE.test(code)) return { ok: false, error: `not a valid code: ${JSON.stringify(raw)}` };
    out.add(code);
  }
  return { ok: true, value: [...out] };
}

/**
 * A mint request, checked. `siteOnly` is true for a caller holding only
 * PROMO_MINT_TOKEN, who must mint under a "site-" campaign.
 */
export function validateMint(body: unknown, now: Date, siteOnly: boolean): Result<PromoInsert[]> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "send a JSON object" };
  }
  const b = body as Record<string, unknown>;

  const codes = parseCodes(b.codes, MAX_CODES_PER_REQUEST);
  if (!codes.ok) return codes;

  const campaign = typeof b.campaign === "string" ? b.campaign : "";
  if (!CAMPAIGN.test(campaign)) {
    return { ok: false, error: 'campaign: lowercase letters, digits and dashes, e.g. "site-welcome"' };
  }
  if (siteOnly && !campaign.startsWith(SITE_CAMPAIGN_PREFIX)) {
    return { ok: false, error: `this token mints only under campaigns starting "${SITE_CAMPAIGN_PREFIX}"` };
  }

  const pct = b.discount_pct == null ? null : intIn(b.discount_pct, 1, 100);
  if (b.discount_pct != null && pct === null) return { ok: false, error: "discount_pct: a whole number from 1 to 100" };
  const cents = b.discount_cents == null ? null : intIn(b.discount_cents, 1, MAX_DISCOUNT_CENTS);
  if (b.discount_cents != null && cents === null) {
    return { ok: false, error: `discount_cents: a whole number from 1 to ${MAX_DISCOUNT_CENTS}` };
  }
  if (pct === null && cents === null) return { ok: false, error: "a code needs discount_pct or discount_cents" };

  const maxUses = intIn(b.max_uses, 1, MAX_USES);
  if (maxUses === null) return { ok: false, error: `max_uses: a whole number from 1 to ${MAX_USES}` };

  const perProduct = b.max_uses_per_product == null ? null : intIn(b.max_uses_per_product, 1, maxUses);
  if (b.max_uses_per_product != null && perProduct === null) {
    return { ok: false, error: "max_uses_per_product: a whole number from 1 to max_uses" };
  }

  const maxWords = b.max_words == null ? null : intIn(b.max_words, 1, MAX_WORDS);
  if (b.max_words != null && maxWords === null) return { ok: false, error: "max_words: a positive whole number" };

  /* Omitted or empty means every product, as in the table. A code scoped to
     nothing would buy nothing, so an empty list is not a way to say that. */
  let products: string | null = null;
  if (b.products != null) {
    if (!Array.isArray(b.products)) return { ok: false, error: "products: an array of product names" };
    const set = new Set<string>();
    for (const p of b.products) {
      if (!CLOUD_PRODUCTS.includes(p as CloudProduct)) {
        return { ok: false, error: `unknown product ${JSON.stringify(p)}; one of ${CLOUD_PRODUCTS.join(", ")}` };
      }
      set.add(p as string);
    }
    if (set.size) products = JSON.stringify([...set]);
  }

  let expiresAt: string | null = null;
  if (b.expires_at != null) {
    const d = typeof b.expires_at === "string" ? new Date(b.expires_at) : new Date(NaN);
    if (Number.isNaN(d.getTime())) return { ok: false, error: "expires_at: an ISO-8601 date and time" };
    if (d.getTime() <= now.getTime()) return { ok: false, error: "expires_at is in the past" };
    expiresAt = isoSeconds(d);
  }

  const createdAt = isoSeconds(now);
  return {
    ok: true,
    value: codes.value.map((code) => ({
      code,
      campaign,
      discount_pct: pct,
      discount_cents: cents,
      max_uses: maxUses,
      max_uses_per_product: perProduct,
      max_words: maxWords,
      products,
      created_at: createdAt,
      expires_at: expiresAt,
    })),
  };
}
