// ── Minimal Stripe REST client ──
//
// Calls Stripe's HTTP API directly via fetch rather than pulling in the
// stripe npm SDK — this Worker only ever needs two calls (create a Checkout
// Session, verify a webhook signature), and Workers' fetch-based runtime
// makes a bespoke client simpler than adapting a Node-oriented SDK.

import type { Env } from "./env";

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

export async function createCheckoutSession(
  env: Env,
  opts: { quoteId: string; tokenBudget: number; amountCents: number },
): Promise<CheckoutSessionResult> {
  const successUrl = `${env.CHECKOUT_SUCCESS_URL_BASE}/v1/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${env.CHECKOUT_SUCCESS_URL_BASE}/v1/cancelled`;

  const body = formEncode({
    mode: "payment",
    "payment_method_types[0]": "card",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][product_data][name]": "Betty in the Cloud — one cloud editing job",
    "line_items[0][price_data][product_data][description]": `~${opts.tokenBudget.toLocaleString()} tokens of cloud editing capacity for this manuscript job`,
    "line_items[0][price_data][unit_amount]": String(opts.amountCents),
    "line_items[0][quantity]": "1",
    success_url: successUrl,
    cancel_url: cancelUrl,
    "metadata[quoteId]": opts.quoteId,
    "metadata[tokenBudget]": String(opts.tokenBudget),
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

export interface StripeCheckoutCompletedEvent {
  id: string;
  sessionId: string;
  customerEmail: string | null;
  quoteId: string;
  tokenBudget: number;
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
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
