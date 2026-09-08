// ── Betty in the Cloud — Worker entrypoint ──
//
// From the Bethaniel app's point of view this Worker is just another
// OpenAI-compatible `source: "api"` base URL — see backend/src/llm.ts's
// `chatStream`. Everything provider-specific (Stripe, the credential ledger,
// the upstream inference provider) is hidden behind that one contract — the
// provider is three env vars, so switching one is a config change, not a
// rewrite.

import type { Env } from "./env";
import { priceJob } from "./quote";
import {
  insertQuote,
  findPromo,
  redeemPromo,
  findQuote,
  insertCredential,
  findCredentialByStripeSession,
  sweepExpiredCredentials,
  insertPendingClaim,
  findPendingClaim,
  sweepExpiredPendingClaims,
  sweepExpiredQuotes,
} from "./db";
import {
  assertPaymentsAllowed,
  createCheckoutSession,
  verifyAndParseStripeWebhook,
} from "./stripe";
import { generateCredentialToken, hashToken } from "./crypto";
import { renderSuccessPage, renderCancelledPage } from "./successPage";
import { handleChatCompletions } from "./proxy";

export { CredentialLedger } from "./ledger";
export { GlobalMeter } from "./globalMeter";

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
        const { estimatedTokens, words, code } = (await request.json()) as {
          estimatedTokens: number;
          words?: number;
          code?: string;
        };
        if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
          return json({ error: "estimatedTokens must be a positive number" }, 400);
        }
        // The price is a function of SIZE now, so the word count is what it
        // needs. An app that only sends tokens still gets a valid quote:
        // falling back to band one is the cheapest band, so a stale client is
        // never overcharged by the omission.
        if (words !== undefined && (!Number.isFinite(words) || words <= 0)) {
          return json({ error: "words must be a positive number when given" }, 400);
        }
        // /v1/quote is unauthenticated by necessity — the app asks for a price
        // before anyone has paid. Bound it so a bad (or hostile) caller cannot
        // mint a Checkout Session for an absurd sum, or size a credential
        // budget larger than the daily ceiling could ever serve.
        // Never quote a job the daily ceiling could not serve: taking money
        // for work we would then refuse with a 503 is worse than declining it
        // up front. Enforced here rather than left to a comment on the config,
        // so a careless edit to either var cannot produce an unservable sale.
        const dailyCeiling = Number(env.DAILY_TOKEN_CEILING) || 0;
        const configuredMax = Number(env.MAX_QUOTE_TOKENS) || 0;
        const maxQuote =
          dailyCeiling > 0 && configuredMax > 0
            ? Math.min(configuredMax, dailyCeiling)
            : Math.max(configuredMax, dailyCeiling);
        if (maxQuote > 0 && estimatedTokens > maxQuote) {
          return json(
            {
              error:
                "This job is larger than Betty in the Cloud will price in one go — split it into fewer chapters per run.",
              maxTokens: maxQuote,
            },
            413,
          );
        }
        // A code is looked up but NOT consumed here: quoting a price must not
        // spend a single-use code, or an author who asks twice loses it. The
        // use is taken at /v1/checkout, atomically.
        const promoRow = code ? await findPromo(env, code) : null;
        const quote = priceJob(
          env,
          { estimatedTokens, words: words ?? 1 },
          promoRow
            ? {
                code: promoRow.code,
                discountPct: promoRow.discount_pct,
                discountCents: promoRow.discount_cents,
                maxWords: promoRow.max_words,
              }
            : null,
        );
        const quoteId = crypto.randomUUID();
        await insertQuote(
          env,
          quoteId,
          quote.tokens,
          quote.priceEurCents,
          quote.appliedCode ?? null,
        );
        return json({
          quoteId,
          tokens: quote.tokens,
          words: quote.words,
          tiers: quote.tiers,
          priceEurCents: quote.priceEurCents,
          fullPriceEurCents: quote.fullPriceEurCents,
          appliedCode: quote.appliedCode,
          // Set when a code was offered and does not cover a job this size.
          // The author still gets a price; this says why it is not discounted.
          codeRejectedReason: quote.codeRejectedReason,
          // A code that was sent but matched nothing at all.
          codeUnknown: code && !promoRow ? true : undefined,
        });
      }

      if (url.pathname === "/v1/checkout" && request.method === "POST") {
        const { quoteId } = (await request.json()) as { quoteId: string };
        const quote = await findQuote(env, quoteId);
        if (!quote) return json({ error: "Quote not found or expired — get a new price" }, 404);

        // The ceiling, computed once and shared by both paths below.
        const tokenBudget = Math.ceil(
          quote.estimated_tokens * (Number(env.TOKEN_BUDGET_HEADROOM) || 1.5),
        );

        // A code that brings the price to zero skips Stripe entirely: there is
        // no payment to take, and Stripe will not create a session for zero.
        // The credential is minted here instead of in the webhook, which is the
        // only place these two paths differ.
        if (quote.price_eur_cents === 0) {
          // Redeem FIRST. The UPDATE carries its own guard, so two requests
          // racing on the last use of a code cannot both mint: the loser
          // matches no rows and is told the code is spent.
          const redeemed = quote.promo_code
            ? await redeemPromo(env, quote.promo_code)
            : false;
          if (!redeemed) {
            return json(
              {
                error:
                  "That code has already been used, or expired while you were deciding. Ask for a new price.",
              },
              409,
            );
          }

          const token = generateCredentialToken();
          const tokenHash = await hashToken(token);
          const expiresAt = new Date(
            Date.now() + Number(env.CREDENTIAL_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
          ).toISOString();
          // No Stripe session exists, but the column is UNIQUE and NOT NULL and
          // is what makes webhook delivery idempotent. A synthetic id keyed to
          // the quote preserves both: replaying this endpoint with the same
          // quote collides instead of minting twice.
          const syntheticSessionId = `promo_${quote.id}`;
          const already = await findCredentialByStripeSession(env, syntheticSessionId);
          if (already) {
            return json({ error: "This quote has already been claimed" }, 409);
          }
          await insertCredential(env, {
            id: crypto.randomUUID(),
            tokenHash,
            stripeSessionId: syntheticSessionId,
            tokenBudget,
            expiresAt,
            customerEmail: null,
          });
          const ledgerId = env.CREDENTIAL_LEDGER.idFromName(tokenHash);
          const ledger = env.CREDENTIAL_LEDGER.get(ledgerId);
          await ledger.fetch("https://ledger/init", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ budgetTotal: tokenBudget, expiresAt }),
          });
          await insertPendingClaim(env, syntheticSessionId, token, tokenBudget);
          // Same shape the app already handles after a paid checkout.
          return json({
            checkoutUrl: `${env.CHECKOUT_SUCCESS_URL_BASE}/v1/success?session_id=${syntheticSessionId}`,
            free: true,
          });
        }

        // Before spending a promo use, not after: a live-key refusal must not
        // burn the author's code on a request that was never going to reach
        // Stripe. createCheckoutSession re-checks as a backstop.
        assertPaymentsAllowed(env);

        // A partial discount still goes through Stripe at the reduced amount,
        // and the code is spent only once that session is created.
        if (quote.promo_code) {
          const redeemed = await redeemPromo(env, quote.promo_code);
          if (!redeemed) {
            return json(
              {
                error:
                  "That code has already been used, or expired while you were deciding. Ask for a new price.",
              },
              409,
            );
          }
        }

        const session = await createCheckoutSession(env, {
          quoteId: quote.id,
          tokenBudget,
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
          model: env.PROVIDER_MODEL,
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
        // Quotes were never swept — /v1/quote is unauthenticated, so the table
        // grew by one row per price check forever, paid or not.
        const expiredQuotes = await sweepExpiredQuotes(env);
        console.log(
          `[cron] expired ${expiredCredentials} credential(s), swept ${expiredClaims} stale pending claim(s), ${expiredQuotes} expired quote(s)`,
        );
      })(),
    );
  },
};
