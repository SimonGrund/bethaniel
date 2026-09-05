// ── GlobalMeter Durable Object ──
//
// A single instance for the whole Worker (`idFromName("global")`), holding a
// rolling-day ceiling on tokens sent upstream.
//
// This exists because the provider will not do it for us. OVHcloud AI
// Endpoints offers budget *alerts* (an email once forecast usage crosses a
// threshold) but no hard cap that stops the meter, and an authenticated key
// is allowed 400 requests/minute per project per model. At a representative
// Bethaniel chunk that is roughly EUR 187/hour — so a leaked PROVIDER_API_KEY
// or a runaway retry loop is a four-figure day on a company card.
//
// CredentialLedger caps what any one *paying user* can spend, which is a
// different question: ten thousand credentials means ten thousand independent
// budgets and no aggregate limit at all. This is the aggregate limit.
//
// Same concurrency guarantee as CredentialLedger: Cloudflare serializes
// delivery to a single DO instance across awaits, so check-then-reserve is
// atomic here without explicit locking.

import type { Env } from "./env";

interface MeterState {
  /** UTC day this window covers, "YYYY-MM-DD". Rolls on first use of a new day. */
  day: string;
  reserved: number;
  spent: number;
}

interface Hold {
  id: string;
  amount: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** UTC calendar day. Deliberately not local time: the Worker runs in whatever
 *  colo the request lands in, so anything else would roll at different moments
 *  for different requests. */
function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class GlobalMeter {
  private state: DurableObjectState;
  private env: Env;
  private meter: MeterState = { day: "", reserved: 0, spent: 0 };
  private holds = new Map<string, Hold>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<MeterState>("meter");
      if (stored) this.meter = stored;
    });
  }

  private async persist(): Promise<void> {
    await this.state.storage.put("meter", this.meter);
  }

  /** Start a fresh window when the UTC day turns over. In-flight holds from
   *  the previous day are intentionally dropped from the new day's counters:
   *  they were charged against the day they started, and carrying them over
   *  would double-count them. */
  private rollIfNeeded(now: number): void {
    const today = utcDay(now);
    if (this.meter.day === today) return;
    this.meter = { day: today, reserved: 0, spent: 0 };
    this.holds.clear();
  }

  private ceiling(): number {
    const raw = Number(this.env.DAILY_TOKEN_CEILING);
    // A missing or malformed ceiling must fail closed, not open — an
    // unparseable value here would otherwise silently disable the cap.
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    this.rollIfNeeded(now);

    if (url.pathname === "/reserve" && request.method === "POST") {
      const { holdTokens } = (await request.json()) as { holdTokens: number };
      const ceiling = this.ceiling();
      if (ceiling <= 0) {
        return jsonResponse(
          { ok: false, reason: "ceiling_unset", day: this.meter.day },
          503,
        );
      }
      const projected = this.meter.reserved + this.meter.spent + holdTokens;
      if (projected > ceiling) {
        return jsonResponse(
          {
            ok: false,
            reason: "daily_ceiling_reached",
            day: this.meter.day,
            ceiling,
            used: this.meter.reserved + this.meter.spent,
          },
          503,
        );
      }
      const id = crypto.randomUUID();
      this.holds.set(id, { id, amount: holdTokens });
      this.meter.reserved += holdTokens;
      await this.persist();
      return jsonResponse({ ok: true, holdId: id });
    }

    if (url.pathname === "/commit" && request.method === "POST") {
      const { holdId, actualTokens } = (await request.json()) as {
        holdId: string;
        actualTokens: number;
      };
      const hold = this.holds.get(holdId);
      // An unknown hold means the day rolled under us. The tokens were still
      // really spent, so record them against today rather than losing them.
      const held = hold?.amount ?? 0;
      if (hold) this.holds.delete(holdId);
      this.meter.reserved = Math.max(0, this.meter.reserved - held);
      this.meter.spent += Math.max(0, actualTokens);
      await this.persist();
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/release" && request.method === "POST") {
      const { holdId } = (await request.json()) as { holdId: string };
      const hold = this.holds.get(holdId);
      if (hold) {
        this.holds.delete(holdId);
        this.meter.reserved = Math.max(0, this.meter.reserved - hold.amount);
        await this.persist();
      }
      return jsonResponse({ ok: true });
    }

    if (url.pathname === "/status") {
      const ceiling = this.ceiling();
      const used = this.meter.reserved + this.meter.spent;
      return jsonResponse({
        day: this.meter.day,
        ceiling,
        reserved: this.meter.reserved,
        spent: this.meter.spent,
        used,
        remaining: Math.max(0, ceiling - used),
        liveHolds: this.holds.size,
      });
    }

    return jsonResponse({ ok: false, reason: "unknown_route" }, 404);
  }
}
