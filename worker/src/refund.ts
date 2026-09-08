// ── Automatic reimbursement for jobs that never happened ──
//
// The failure this exists for: an author pays, and then the run dies — the
// app crashes, the credential never reaches it, the machine goes to sleep
// mid-manuscript. They are out EUR 5 with nothing to show, and the only
// recourse the success page offers is "contact support".
//
// What this can and cannot do honestly:
//
// The Worker sees inference calls, not jobs. It has no idea what a chapter is,
// when a manuscript finished, or whether the app crashed — only how many
// tokens a credential spent before it expired. So "refund a crashed job"
// cannot be decided here in general.
//
// What CAN be decided safely is the unambiguous end of that range: a paid
// credential that expired having spent essentially nothing bought nothing, and
// refunding it in full is both fair and unexploitable — there is no free
// editing to walk away with.
//
// Everything in between (spent something, but far less than it paid for) is
// deliberately NOT automatic. A rule like "refund if under half used" is
// trivially farmed: buy a band, edit three chapters, wait out the expiry,
// collect the refund, repeat. Those are flagged for a human instead.

/** The mirror row the sweep reasons about. */
export interface RefundCandidate {
  stripe_session_id: string;
  stripe_payment_intent: string | null;
  token_budget: number;
  spent: number;
}

export type RefundVerdict =
  | { action: "refund"; reason: string }
  | { action: "review"; reason: string }
  | { action: "none"; reason: string };

/**
 * Spend at or below this is "never really started". One copy-edit chunk costs
 * roughly 3,000 prompt tokens on its own, so this sits below the cost of a
 * single unit of real work — a probe or a handshake, not a manuscript.
 */
export const UNUSED_TOKEN_TOLERANCE = 2_000;

/**
 * Below this fraction of the budget, a human is asked to look. Above it, the
 * author got substantially what they paid for and nothing happens.
 */
export const REVIEW_SPEND_FRACTION = 0.5;

export function refundVerdict(c: RefundCandidate): RefundVerdict {
  // Promo credentials are minted without a Stripe session at all. There is no
  // payment to reverse, and treating one as unpaid-and-unused would try.
  if (c.stripe_session_id.startsWith("promo_")) {
    return { action: "none", reason: "free credential — nothing was charged" };
  }
  if (!c.stripe_payment_intent) {
    // Credentials minted before payment_intent was captured. Refundable by
    // hand from the session id, but not automatically.
    return { action: "review", reason: "paid, but no payment_intent recorded" };
  }
  if (c.spent <= UNUSED_TOKEN_TOLERANCE) {
    return {
      action: "refund",
      reason: `expired having spent ${c.spent} tokens — the job never ran`,
    };
  }
  if (c.token_budget > 0 && c.spent < c.token_budget * REVIEW_SPEND_FRACTION) {
    return {
      action: "review",
      reason: `expired at ${Math.round((c.spent / c.token_budget) * 100)}% used — possibly interrupted`,
    };
  }
  return { action: "none", reason: "substantially used" };
}
