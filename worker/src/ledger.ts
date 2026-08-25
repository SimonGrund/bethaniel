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
const RATE_LIMIT_MAX_REQUESTS = 30;

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
