// ── Minimal Stripe REST client ──
//
// Calls Stripe's HTTP API directly via fetch rather than pulling in the
// stripe npm SDK — this Worker only ever needs two calls (create a Checkout
// Session, verify a webhook signature), and Workers' fetch-based runtime
// makes a bespoke client simpler than adapting a Node-oriented SDK.

import type { Env } from "./env";
import { PRODUCT_NAMES, type CloudProduct, type PriceCurrency } from "./quote";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export interface CheckoutSessionResult {
  id: string;
  url: string;
}

/**
 * Refuse to charge a real card unless the deployment says so out loud.
 *
 * Test and live Stripe keys differ by four characters, both mint sessions
 * that look alike, and this repo is public — so the natural mistake is to
 * paste the key sitting at the top of the dashboard (which is the live one)
 * while walking the flow, and only notice at the payment page. The cost of
 * that mistake is somebody's actual money.
 *
 * The check is deliberately a fail-closed default rather than a warning:
 * going live is a decision worth writing down in wrangler.toml.
 *
 * Matched on the `_live_` segment rather than on `sk_live_`, because Stripe
 * has more than one kind of live key. A RESTRICTED key — the kind you should
 * be using here, scoped to Checkout Sessions and Refunds — is `rk_live_…`,
 * so a `sk_live_` test would have waved through the safer of the two
 * choices and taken real money with the switch still off.
 */
const LIVE_KEY = /^[a-z]+_live_/;

export function assertPaymentsAllowed(env: Env): void {
  if (!LIVE_KEY.test(env.STRIPE_SECRET_KEY ?? "")) return;
  if (env.ALLOW_LIVE_PAYMENTS === "true") return;
  throw new Error(
    "STRIPE_SECRET_KEY is a live key but ALLOW_LIVE_PAYMENTS is not \"true\" — " +
      "refusing to create a Checkout Session that would charge a real card. " +
      "Set ALLOW_LIVE_PAYMENTS = \"true\" in wrangler.toml when that is intended.",
  );
}

export async function createCheckoutSession(
  env: Env,
  opts: {
    quoteId: string;
    tokenBudget: number;
    /** In the minor unit of `currency`: cents, or øre for the krone. */
    amountCents: number;
    currency?: PriceCurrency;
    product?: CloudProduct;
    promoCode?: string | null;
  },
): Promise<CheckoutSessionResult> {
  // Backstop: every call site is covered even if one forgets the early check.
  assertPaymentsAllowed(env);

  const successUrl = `${env.CHECKOUT_SUCCESS_URL_BASE}/v1/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${env.CHECKOUT_SUCCESS_URL_BASE}/v1/cancelled`;

  const body = formEncode({
    mode: "payment",
    "payment_method_types[0]": "card",
    "line_items[0][price_data][currency]": opts.currency ?? "eur",
    "line_items[0][price_data][product_data][name]":
      PRODUCT_NAMES[opts.product ?? "edit"],
    "line_items[0][price_data][product_data][description]":
      opts.product === "enhance"
        ? `Passages of this manuscript read in the cloud for the language report — ~${opts.tokenBudget.toLocaleString()} tokens of capacity`
        : `~${opts.tokenBudget.toLocaleString()} tokens of cloud editing capacity for this manuscript job`,
    "line_items[0][price_data][unit_amount]": String(opts.amountCents),
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    "metadata[quoteId]": opts.quoteId,
    "metadata[tokenBudget]": String(opts.tokenBudget),
    // Read back by the webhook, so the credential records what was sold:
    // the quote itself is deleted once it expires.
    "metadata[product]": opts.product ?? "edit",
    ...(opts.promoCode ? { "metadata[promoCode]": opts.promoCode } : {}),
  });

  const res = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stripe checkout session creation failed: ${res.status} ${text}`);
  }

  const session = (await res.json()) as { id: string; url: string | null };
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { id: session.id, url: session.url };
}

/**
 * The receipt Stripe keeps for a paid Checkout session, as a link the buyer
 * can open, save or print. Read from the session with its payment's charge
 * expanded; null when there is none (an unpaid or free session). Pure.
 */
export function receiptUrlOf(session: unknown): string | null {
  const s = session as { payment_intent?: { latest_charge?: { receipt_url?: unknown } | string | null } | string | null };
  const pi = s?.payment_intent;
  const charge = pi && typeof pi === "object" ? pi.latest_charge : null;
  const url = charge && typeof charge === "object" ? charge.receipt_url : null;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/**
 * The receipt link for a Checkout session. Needs the restricted key to read
 * Checkout Sessions, PaymentIntents and Charges; without that, or for any
 * other failure, null — the page then says the receipt is in their email.
 */
export async function fetchReceiptUrl(env: Env, sessionId: string): Promise<string | null> {
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return null;
  try {
    const res = await fetch(
      `${STRIPE_API_BASE}/checkout/sessions/${sessionId}?expand[]=payment_intent.latest_charge`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
    );
    if (!res.ok) return null;
    return receiptUrlOf(await res.json());
  } catch {
    return null;
  }
}

/**
 * Reverse a payment in full.
 *
 * Idempotency-Key is keyed on the payment intent, so the same refund can
 * never be issued twice however many times the cron retries — which matters
 * because the sweep marks the row only after Stripe answers, and a timeout
 * in between would otherwise refund again on the next run.
 */
export async function refundPayment(
  env: Env,
  paymentIntentId: string,
  opts: { by?: string } = {},
): Promise<void> {
  /* A refund decided by a person carries who decided it, in Stripe's own
     record of the refund. It takes its own idempotency key: Stripe refuses
     a key reused with different parameters, so sharing the sweep's would
     make a manual refund fail after a failed automatic one. A second full
     refund of the same payment is refused by Stripe either way. */
  const manual = typeof opts.by === "string" && opts.by.length > 0;
  const res = await fetch(`${STRIPE_API_BASE}/refunds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": manual ? `refund_manual_${paymentIntentId}` : `refund_${paymentIntentId}`,
    },
    body: formEncode({
      payment_intent: paymentIntentId,
      reason: "requested_by_customer",
      ...(manual ? { "metadata[refunded_by]": opts.by!.slice(0, 200) } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Stripe refund failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

export interface StripeCheckoutCompletedEvent {
  id: string;
  sessionId: string;
  customerEmail: string | null;
  quoteId: string;
  tokenBudget: number;
  paymentIntent: string | null;
  /** What Stripe charged, in the minor unit of `currency`. */
  amountTotal: number | null;
  currency: string | null;
  /** From the session metadata; absent on sessions created before 2026-09-30. */
  product: string | null;
  promoCode: string | null;
}

/** Verify the Stripe-Signature header and, if valid and the event is a
 *  completed checkout, return its parsed essentials. Returns null for any
 *  other (still valid) event type. Throws on a bad/missing signature. */
export async function verifyAndParseStripeWebhook(
  env: Env,
  payload: string,
  signatureHeader: string | null,
): Promise<StripeCheckoutCompletedEvent | null> {
  if (!signatureHeader) throw new Error("Missing Stripe-Signature header");

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    }),
  );
  const timestamp = parts.t;
  const expectedSig = parts.v1;
  if (!timestamp || !expectedSig) throw new Error("Malformed Stripe-Signature header");

  // Reject anything older than 5 minutes — standard Stripe replay-attack guard.
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
    throw new Error("Stripe webhook timestamp outside tolerance");
  }

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computedSig = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (!timingSafeEqual(computedSig, expectedSig)) {
    throw new Error("Stripe webhook signature mismatch");
  }

  const event = JSON.parse(payload) as {
    id: string;
    type: string;
    data: {
      object: {
        id: string;
        customer_details?: { email?: string | null };
        metadata?: Record<string, string>;
        payment_status?: string;
        payment_intent?: string | null;
        amount_total?: number | null;
        currency?: string | null;
      };
    };
  };

  if (event.type !== "checkout.session.completed") return null;
  const session = event.data.object;
  if (session.payment_status !== "paid") return null;

  const quoteId = session.metadata?.quoteId;
  const tokenBudget = Number(session.metadata?.tokenBudget);
  if (!quoteId || !Number.isFinite(tokenBudget)) {
    throw new Error("Checkout session is missing quoteId/tokenBudget metadata");
  }

  return {
    id: event.id,
    sessionId: session.id,
    customerEmail: session.customer_details?.email ?? null,
    quoteId,
    tokenBudget,
    paymentIntent: session.payment_intent ?? null,
    amountTotal: typeof session.amount_total === "number" ? session.amount_total : null,
    currency: session.currency ?? null,
    product: session.metadata?.product ?? null,
    promoCode: session.metadata?.promoCode ?? null,
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
