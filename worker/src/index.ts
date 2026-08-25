// ── Betty in the Cloud — Worker entrypoint ──
//
// From the Bethaniel app's point of view this Worker is just another
// OpenAI-compatible `source: "api"` base URL — see backend/src/llm.ts's
// `chatStream`. Everything provider-specific (Stripe, the credential ledger,
// Mistral) is hidden behind that one contract.

import type { Env } from "./env";
import { priceTokens } from "./quote";
import {
  insertQuote,
  findQuote,
  insertCredential,
  findCredentialByStripeSession,
  sweepExpiredCredentials,
  insertPendingClaim,
  findPendingClaim,
  sweepExpiredPendingClaims,
} from "./db";
import { createCheckoutSession, verifyAndParseStripeWebhook } from "./stripe";
import { generateCredentialToken, hashToken } from "./crypto";
import { renderSuccessPage, renderCancelledPage } from "./successPage";
import { handleChatCompletions } from "./proxy";

export { CredentialLedger } from "./ledger";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/v1/health") {
        return json({ status: "ok" });
      }

      if (url.pathname === "/v1/quote" && request.method === "POST") {
        const { estimatedTokens } = (await request.json()) as { estimatedTokens: number };
        if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
          return json({ error: "estimatedTokens must be a positive number" }, 400);
        }
        const quote = priceTokens(env, estimatedTokens);
        const quoteId = crypto.randomUUID();
        await insertQuote(env, quoteId, quote.tokens, quote.priceEurCents);
        return json({ quoteId, tokens: quote.tokens, priceEurCents: quote.priceEurCents });
      }

      if (url.pathname === "/v1/checkout" && request.method === "POST") {
        const { quoteId } = (await request.json()) as { quoteId: string };
        const quote = await findQuote(env, quoteId);
        if (!quote) return json({ error: "Quote not found or expired — get a new price" }, 404);
        const session = await createCheckoutSession(env, {
          quoteId: quote.id,
          tokenBudget: quote.estimated_tokens,
          amountCents: quote.price_eur_cents,
        });
        return json({ checkoutUrl: session.url });
      }

      if (url.pathname === "/webhooks/stripe" && request.method === "POST") {
        const payload = await request.text();
        const signature = request.headers.get("Stripe-Signature");
        let event;
        try {
          event = await verifyAndParseStripeWebhook(env, payload, signature);
        } catch (err) {
          console.error("[webhook] signature verification failed:", err);
          return json({ error: "Invalid signature" }, 400);
        }
        if (!event) return json({ received: true }); // some other event type — ignore

        // Idempotent on stripe_session_id: Stripe retries webhooks, and a
        // duplicate delivery must not mint a second credential for one payment.
        const existing = await findCredentialByStripeSession(env, event.sessionId);
        if (existing) return json({ received: true, alreadyProcessed: true });

        const token = generateCredentialToken();
        const tokenHash = await hashToken(token);
        const expiresAt = new Date(
          Date.now() + Number(env.CREDENTIAL_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
        ).toISOString();

        await insertCredential(env, {
          id: crypto.randomUUID(),
          tokenHash,
          stripeSessionId: event.sessionId,
          tokenBudget: event.tokenBudget,
          expiresAt,
          customerEmail: event.customerEmail,
        });

        const ledgerId = env.CREDENTIAL_LEDGER.idFromName(tokenHash);
        const ledger = env.CREDENTIAL_LEDGER.get(ledgerId);
        await ledger.fetch("https://ledger/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ budgetTotal: event.tokenBudget, expiresAt }),
        });

        await insertPendingClaim(env, event.sessionId, token, event.tokenBudget);

        return json({ received: true });
      }

      if (url.pathname === "/v1/success" && request.method === "GET") {
        const sessionId = url.searchParams.get("session_id") ?? "";
        return html(renderSuccessPage(sessionId));
      }

      if (url.pathname === "/v1/cancelled" && request.method === "GET") {
        return html(renderCancelledPage());
      }

      if (url.pathname === "/v1/credential" && request.method === "GET") {
        const sessionId = url.searchParams.get("session_id") ?? "";
        const claim = await findPendingClaim(env, sessionId);
        if (!claim) return json({ status: "pending" });
        return json({
          status: "issued",
          token: claim.token,
          tokenBudget: claim.tokenBudget,
          model: env.MISTRAL_MODEL,
        });
      }

      if (url.pathname === "/v1/chat/completions" && request.method === "POST") {
        return await handleChatCompletions(request, env, ctx);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error("[worker] unhandled error:", err);
      return json({ error: "Internal error" }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const expiredCredentials = await sweepExpiredCredentials(env);
        const expiredClaims = await sweepExpiredPendingClaims(env);
        console.log(
          `[cron] expired ${expiredCredentials} credential(s), swept ${expiredClaims} stale pending claim(s)`,
        );
      })(),
    );
  },
};
