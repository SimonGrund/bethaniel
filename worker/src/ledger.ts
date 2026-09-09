// ── CredentialLedger Durable Object ──
//
// One instance per credential (keyed by `idFromName(tokenHash)`). Cloudflare
// serializes delivery of requests to a single DO instance — including across
// the `await`s in the methods below — so "check balance, then reserve" here
// is genuinely atomic with no explicit locking required. That's what makes
// it safe against the app's own concurrent editor+reviewer agent calls: the
// sum of all live reservations can never exceed the purchased budget, so
// total exposure is hard-capped regardless of how many requests race in.
//
// Reservations are sized to a request's own worst-case token cap (its
// `max_tokens`), not a guess — so this isn't "narrow the race window", it's
// "eliminate overspend entirely". `commit()` releases the unused portion of
// the hold back to the pool as soon as actual usage is known.

import type { Env } from "./env";

interface LedgerState {
  budgetTotal: number;
  reserved: number;
  spent: number;
  status: "active" | "expired" | "void";
  expiresAt: string;
  initialized: boolean;
}

interface Reservation {
  id: string;
  amount: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
// Per-credential burst ceiling, sized for a real multi-chapter job.
//
// This is NOT the spend control — `budgetTotal` is, and it is absolute: a
// credential can only ever spend what was paid for however fast it asks. This
// limit only shapes burst behaviour, which is why it can be generous.
//
// Sizing: one chapter at the Speed preset issues 3 upstream calls per chunk
// (editor + style agent + reviewer), and a chunk takes 80-240s against
// OVHcloud's measured ~38 tok/s. So P concurrent chapters produce ~3P calls
// per burst, or ~6P in the worst case where a second chunk lands inside the
// same 60s window. At the catalog's recommendedParallel of 12 that is 36-72,
// and 120 leaves real headroom above it.
//
// At 30 this was the binding constraint rather than a backstop: a routine job
// at only 3 parallel chapters tripped it, and because the Worker mapped the
// refusal to a 403 the app treated it as a dead credential and failed the
// chunk outright. Both halves of that are fixed; this is the sizing half.
//
// Raised to 400 on 9 September 2026, when the provider moved to Scaleway and
// the old ceiling became the binding constraint rather than a backstop.
//
// Measured on Scaleway, one 2,366-word chunk per request, all succeeding:
//
//     12 concurrent    352 tok/s aggregate
//     40 concurrent  1,059 tok/s aggregate
//
// It scales, in other words — throughput is bought with concurrency, not
// waited for. A 43-chapter book at one chapter each is ~129 calls per burst
// and up to ~258 if second chunks land in the same window, which 120 refused
// and 400 admits. That is the difference between ~27 minutes and ~9 for a
// full-length manuscript.
//
// Still a backstop, not the spend control: `budgetTotal` is absolute and a
// credential can only ever spend what was paid for, however fast it asks.
// This only shapes burst behaviour.
//
// The aggregate across customers is now the open question. OVHcloud's shared
// 400/min no longer applies, and Scaleway's limits are per-account and were
// not reached at 40 concurrent — but nothing here bounds calls per minute
// Worker-wide, and GlobalMeter bounds tokens per day rather than call rate.
// That guard is worth building before many customers run at once.
// 1,200 from 400 on 9 September 2026, and the number matters less than it used
// to: a 429 is now waited out by backend/src/llm.ts rather than failing the
// chunk, so this ceiling is a PACING mechanism, not a cliff. Before that change
// our own backpressure could destroy work an author had paid for — a benchmark
// run lost two tasks to exactly this.
//
// Sized from the call volume rather than a round number. At the Speed preset a
// chunk costs 3 upstream calls (editor + style agent + reviewer); a chapter is
// ~2,800 words, so ~2 chunks, ~6 calls. Chunks take 60-95s measured, so P
// concurrent chapters settle at roughly 3P calls/minute with a 3P burst on top
// as waves overlap. At the catalog's 24 that is ~72 sustained and ~144 in a
// burst; 1,200 leaves room for retries and a second job on the same credential
// without ever being reached in normal use.
//
// Still not the spend control. `budgetTotal` is, and it is absolute: a
// credential can only ever spend what was paid for, however fast it asks.
const RATE_LIMIT_MAX_REQUESTS = 1200;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class CredentialLedger {
  private state: DurableObjectState;
  private env: Env;
  private ledger: LedgerState = {
    budgetTotal: 0,
    reserved: 0,
    spent: 0,
    status: "active",
    expiresAt: "",
    initialized: false,
  };
  private reservations = new Map<string, Reservation>();
  private requestTimestamps: number[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<LedgerState>("ledger");
      if (stored) this.ledger = stored;
      const storedReservations =
        await this.state.storage.get<Record<string, number>>("reservations");
      if (storedReservations) {
        for (const [id, amount] of Object.entries(storedReservations)) {
          this.reservations.set(id, { id, amount });
        }
      }
    });
  }

  private async persist(): Promise<void> {
    await this.state.storage.put("ledger", this.ledger);
    const reservationsObj: Record<string, number> = {};
    for (const r of this.reservations.values()) reservationsObj[r.id] = r.amount;
    await this.state.storage.put("reservations", reservationsObj);
  }

  private rateLimited(): boolean {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => now - t < RATE_LIMIT_WINDOW_MS,
    );
    if (this.requestTimestamps.length >= RATE_LIMIT_MAX_REQUESTS) return true;
    this.requestTimestamps.push(now);
    return false;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      const body = (await request.json()) as { budgetTotal: number; expiresAt: string };
      this.ledger = {
        budgetTotal: body.budgetTotal,
        reserved: 0,
        spent: 0,
        status: "active",
        expiresAt: body.expiresAt,
        initialized: true,
      };
      await this.persist();
      return jsonResponse({ ok: true });
    }

    if (!this.ledger.initialized) {
      return jsonResponse({ ok: false, reason: "not_initialized" }, 404);
    }

    if (this.rateLimited()) {
      return jsonResponse({ ok: false, reason: "rate_limited" }, 429);
    }

    if (this.ledger.status !== "active" || new Date(this.ledger.expiresAt) < new Date()) {
      return jsonResponse({ ok: false, reason: "inactive_or_expired" }, 403);
    }

    if (url.pathname === "/reserve" && request.method === "POST") {
      const { holdTokens } = (await request.json()) as { holdTokens: number };
      const remaining =
        this.ledger.budgetTotal - this.ledger.reserved - this.ledger.spent;
      if (holdTokens > remaining) {
        return jsonResponse(
          { ok: false, reason: "insufficient_balance", remaining },
          402,
        );
      }
      const id = crypto.randomUUID();
      this.reservations.set(id, { id, amount: holdTokens });
      this.ledger.reserved += holdTokens;
      await this.persist();
      return jsonResponse({ ok: true, reservationId: id });
    }

    if (url.pathname === "/commit" && request.method === "POST") {
      const { reservationId, actualTokens } = (await request.json()) as {
        reservationId: string;
        actualTokens: number;
      };
      const reservation = this.reservations.get(reservationId);
      if (!reservation) {
        return jsonResponse({ ok: false, reason: "unknown_reservation" }, 404);
      }
      const spent = Math.min(actualTokens, reservation.amount);
      this.ledger.reserved -= reservation.amount;
      this.ledger.spent += spent;
      this.reservations.delete(reservationId);
      await this.persist();
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/release" && request.method === "POST") {
      const { reservationId } = (await request.json()) as { reservationId: string };
      const reservation = this.reservations.get(reservationId);
      if (reservation) {
        this.ledger.reserved -= reservation.amount;
        this.reservations.delete(reservationId);
        await this.persist();
      }
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/status" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        budgetTotal: this.ledger.budgetTotal,
        reserved: this.ledger.reserved,
        spent: this.ledger.spent,
        remaining:
          this.ledger.budgetTotal - this.ledger.reserved - this.ledger.spent,
        status: this.ledger.status,
        expiresAt: this.ledger.expiresAt,
      });
    }

    if (url.pathname === "/void" && request.method === "POST") {
      this.ledger.status = "void";
      await this.persist();
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, reason: "unknown_route" }, 404);
  }
}
