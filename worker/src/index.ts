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
  releasePromo,
  findQuote,
  insertCredential,
  findCredentialByStripeSession,
  sweepExpiredCredentials,
  insertPendingClaim,
  findPendingClaim,
  sweepExpiredPendingClaims,
  sweepExpiredQuotes,
  findUnruledExpiredCredentials,
  setRefundStatus,
  findRefundReviews,
  findCredentialById,
} from "./db";
import {
  assertPaymentsAllowed,
  createCheckoutSession,
  refundPayment,
  verifyAndParseStripeWebhook,
} from "./stripe";
import { generateCredentialToken, hashToken } from "./crypto";
import { refundVerdict } from "./refund";
import { isAdminRequest } from "./admin";
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
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * True if this request may proceed. Fails OPEN when the binding is absent,
 * because a deployment without it (local Miniflare, an older wrangler) must
 * still work — an unavailable limiter is a config gap, not an attack, and
 * refusing every request would take the paid service down to prevent abuse
 * that may not be happening.
 *
 * Keyed on CF-Connecting-IP, which Cloudflare sets at the edge and a client
 * cannot forge. Absent that (it should never be), everything shares one
 * bucket rather than each getting its own.
 */
async function rateLimitOk(request: Request, env: Env): Promise<boolean> {
  if (!env.IP_RATE_LIMITER) return true;
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  try {
    const { success } = await env.IP_RATE_LIMITER.limit({ key });
    return success;
  } catch (err) {
    console.error("[ratelimit] limiter threw, allowing:", err);
    return true;
  }
}

/**
 * Give back the money for credentials that expired without doing any work.
 *
 * Runs on the hourly cron, immediately after the expiry sweep. Each row is
 * ruled on exactly once — the refund_status write is what makes it so, and
 * it happens whatever the verdict, so a 'none' is not reconsidered forever.
 *
 * A Stripe failure marks the row 'failed' rather than leaving it NULL: a row
 * that keeps retrying every hour against a permanently-rejecting payment is
 * noise that would bury the rows a human still needs to see.
 */
async function reimburseUnusedCredentials(
  env: Env,
): Promise<{ refunded: number; flagged: number }> {
  let refunded = 0;
  let flagged = 0;
  for (const row of await findUnruledExpiredCredentials(env)) {
    const verdict = refundVerdict(row);
    if (verdict.action === "refund" && row.stripe_payment_intent) {
      try {
        await refundPayment(env, row.stripe_payment_intent);
        await setRefundStatus(env, row.id, "refunded");
        refunded++;
        console.log(`[refund] ${row.stripe_session_id}: ${verdict.reason}`);
      } catch (err) {
        await setRefundStatus(env, row.id, "failed");
        console.error(`[refund] ${row.stripe_session_id} FAILED:`, err);
      }
      continue;
    }
    if (verdict.action === "review") {
      await setRefundStatus(env, row.id, "review");
      flagged++;
      console.log(
        `[refund] ${row.stripe_session_id} needs a human: ${verdict.reason}`,
      );
      continue;
    }
    await setRefundStatus(env, row.id, "none");
  }
  return { refunded, flagged };
}

interface MaintenanceSummary {
  expiredCredentials: number;
  expiredClaims: number;
  expiredQuotes: number;
  refunded: number;
  flagged: number;
  /** Minutes the Worker-wide request ceiling was reached since the last sweep. */
  saturations: { at: string; rate: number }[];
}

/**
 * Everything the hourly cron does, in one function so that the cron and
 * POST /admin/sweep cannot drift apart. Running it twice is harmless: every
 * sweep is a conditional UPDATE or DELETE, and the refund pass rules on each
 * credential exactly once (refund_status is the guard).
 */
async function runMaintenance(env: Env): Promise<MaintenanceSummary> {
  const expiredCredentials = await sweepExpiredCredentials(env);
  const expiredClaims = await sweepExpiredPendingClaims(env);
  // Quotes were never swept — /v1/quote is unauthenticated, so the table
  // grew by one row per price check forever, paid or not.
  const expiredQuotes = await sweepExpiredQuotes(env);
  const { refunded, flagged } = await reimburseUnusedCredentials(env);
  // Minutes in which the Worker-wide rate ceiling was actually hit. Customers
  // saw a slower job and nothing else; without this nobody would learn the
  // cause. Read-and-clear, so each saturated minute is reported once.
  let saturations: { at: string; rate: number }[] = [];
  try {
    const meter = env.GLOBAL_METER.get(env.GLOBAL_METER.idFromName("global"));
    const res = await meter.fetch("https://meter/drain-saturations", {
      method: "POST",
    });
    if (res.ok) {
      saturations =
        ((await res.json()) as { saturations?: typeof saturations }).saturations ?? [];
    }
  } catch (err) {
    console.error("[cron] could not read rate saturations:", err);
  }
  return {
    expiredCredentials,
    expiredClaims,
    expiredQuotes,
    refunded,
    flagged,
    saturations,
  };
}

function describeMaintenance(s: MaintenanceSummary): string {
  return (
    `expired ${s.expiredCredentials} credential(s), swept ${s.expiredClaims} stale pending claim(s), ` +
    `${s.expiredQuotes} expired quote(s), refunded ${s.refunded}, flagged ${s.flagged} for review` +
    (s.saturations.length ? `, RATE CEILING HIT in ${s.saturations.length} minute(s)` : "")
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/v1/health") {
        return json({ status: "ok" });
      }

      // ── Operator surface ──
      //
      // Everything under /admin/* answers 404 unless the request carries the
      // operator secret — the same answer an unconfigured deployment gives,
      // so probing this public URL cannot tell the two apart, or learn that
      // the prefix means anything at all.
      if (url.pathname.startsWith("/admin/")) {
        if (!isAdminRequest(request, env))
          return json({ error: "Not found" }, 404);

        // Run the maintenance pass now. Exists because the hourly cron is a
        // scheduler we do not control: if it stops firing, credential expiry,
        // quote cleanup and refunds all stop silently with it. This is the
        // hand crank.
        if (url.pathname === "/admin/sweep" && request.method === "POST") {
          const summary = await runMaintenance(env);
          console.log(`[admin] sweep: ${describeMaintenance(summary)}`);
          return json({ ok: true, ...summary });
        }

        // The sweep's outbox. Partly-used credentials are deliberately not
        // auto-refunded — that rule is farmable — so they land here instead.
        // Until something reads this, the author it concerns is waiting on a
        // decision that exists only as a column value.
        if (url.pathname === "/admin/refunds" && request.method === "GET") {
          const rows = await findRefundReviews(env);
          return json({
            count: rows.length,
            reviews: rows.map((r) => ({
              credentialId: r.id,
              session: r.stripe_session_id,
              email: r.customer_email,
              spent: r.spent,
              budget: r.token_budget,
              // The number the decision actually turns on.
              percentUsed: r.token_budget > 0
                ? Math.round((r.spent / r.token_budget) * 100)
                : 0,
              refundable: !!r.stripe_payment_intent,
              expiredAt: r.expires_at,
            })),
          });
        }

        // Settle one. `refund` moves money and marks it refunded; `decline`
        // moves none and marks it declined. Either way the row leaves the
        // queue, because a decision that does not clear the inbox is a
        // decision that gets made again next week.
        if (url.pathname === "/admin/refund" && request.method === "POST") {
          const { credentialId, action } = (await request.json()) as {
            credentialId?: string;
            action?: string;
          };
          if (!credentialId || (action !== "refund" && action !== "decline")) {
            return json(
              { error: 'Send { credentialId, action: "refund" | "decline" }' },
              400,
            );
          }
          const row = await findCredentialById(env, credentialId);
          if (!row) return json({ error: "No such credential" }, 404);

          if (action === "decline") {
            await setRefundStatus(env, row.id, "none");
            return json({ ok: true, action: "decline", credentialId: row.id });
          }

          if (!row.stripe_payment_intent) {
            return json(
              { error: "No payment_intent recorded — nothing to reverse" },
              409,
            );
          }
          // Stripe's Idempotency-Key is on the payment intent, so a repeated
          // call cannot double-refund even if this one is retried.
          try {
            await refundPayment(env, row.stripe_payment_intent);
          } catch (err) {
            await setRefundStatus(env, row.id, "failed");
            console.error(`[admin] manual refund FAILED for ${row.id}:`, err);
            return json({ error: "Stripe refused the refund" }, 502);
          }
          await setRefundStatus(env, row.id, "refunded");
          console.log(`[admin] manual refund for ${row.stripe_session_id}`);
          return json({ ok: true, action: "refund", credentialId: row.id });
        }

        return json({ error: "Not found" }, 404);
      }

      // Everything below /v1/health is either credential-gated (the ledger
      // does its own per-credential limiting) or one of these two, which
      // anyone can call. Stripe's webhook is exempt: it is signature-gated,
      // and throttling Stripe's retries would drop paid credentials.
      if (
        (url.pathname === "/v1/quote" || url.pathname === "/v1/checkout") &&
        request.method === "POST" &&
        !(await rateLimitOk(request, env))
      ) {
        return json({ error: "Too many requests — please slow down." }, 429);
      }

      if (url.pathname === "/v1/quote" && request.method === "POST") {
        const { estimatedTokens, words, code } = (await request.json()) as {
          estimatedTokens: number;
          words?: number;
          code?: string;
        };
        if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) {
          return json(
            { error: "estimatedTokens must be a positive number" },
            400,
          );
        }
        // The price is a function of SIZE now, so the word count is what it
        // needs. An app that only sends tokens still gets a valid quote:
        // falling back to band one is the cheapest band, so a stale client is
        // never overcharged by the omission.
        if (words !== undefined && (!Number.isFinite(words) || words <= 0)) {
          return json(
            { error: "words must be a positive number when given" },
            400,
          );
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
        if (!quote)
          return json(
            { error: "Quote not found or expired — get a new price" },
            404,
          );

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
            Date.now() +
              Number(env.CREDENTIAL_EXPIRY_DAYS) * 24 * 60 * 60 * 1000,
          ).toISOString();
          // No Stripe session exists, but the column is UNIQUE and NOT NULL and
          // is what makes webhook delivery idempotent. A synthetic id keyed to
          // the quote preserves both: replaying this endpoint with the same
          // quote collides instead of minting twice.
          const syntheticSessionId = `promo_${quote.id}`;
          const already = await findCredentialByStripeSession(
            env,
            syntheticSessionId,
          );
          if (already) {
            // The use was just taken for a credential that already exists, so
            // give it back rather than charging twice for one mint.
            if (quote.promo_code) await releasePromo(env, quote.promo_code);
            return json({ error: "This quote has already been claimed" }, 409);
          }

          // From here the code is spent but the credential does not exist yet.
          // Anything that throws in between leaves a single-use code consumed
          // and the author with nothing, so every step gives the use back.
          try {
            await insertCredential(env, {
              id: crypto.randomUUID(),
              tokenHash,
              stripeSessionId: syntheticSessionId,
              tokenBudget,
              // Nothing was charged, so there is nothing to reverse. The
              // expiry sweep also skips promo_ sessions outright — see
              // refundVerdict — but the column stays honest either way.
              stripePaymentIntent: null,
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
            await insertPendingClaim(
              env,
              syntheticSessionId,
              token,
              tokenBudget,
            );
          } catch (err) {
            if (quote.promo_code) await releasePromo(env, quote.promo_code);
            throw err;
          }
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

        let session;
        try {
          session = await createCheckoutSession(env, {
            quoteId: quote.id,
            tokenBudget,
            amountCents: quote.price_eur_cents,
          });
        } catch (err) {
          // The use was taken a few lines above and bought nothing. Without
          // this, a Stripe outage permanently consumes a single-use code and
          // the author's retry is refused with "already used".
          if (quote.promo_code) await releasePromo(env, quote.promo_code);
          throw err;
        }
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
        const existing = await findCredentialByStripeSession(
          env,
          event.sessionId,
        );
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
          stripePaymentIntent: event.paymentIntent,
        });

        const ledgerId = env.CREDENTIAL_LEDGER.idFromName(tokenHash);
        const ledger = env.CREDENTIAL_LEDGER.get(ledgerId);
        await ledger.fetch("https://ledger/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ budgetTotal: event.tokenBudget, expiresAt }),
        });

        await insertPendingClaim(
          env,
          event.sessionId,
          token,
          event.tokenBudget,
        );

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

      if (
        url.pathname === "/v1/chat/completions" &&
        request.method === "POST"
      ) {
        return await handleChatCompletions(request, env, ctx);
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      console.error("[worker] unhandled error:", err);
      return json({ error: "Internal error" }, 500);
    }
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const summary = await runMaintenance(env);
        console.log(`[cron] ${describeMaintenance(summary)}`);
      })(),
    );
  },
};
