// ── What a task card says about the author's promo code ──
//
// A code can carry several uses, and since max_uses_per_product a different
// number of them per product. The card is where that becomes legible: "2 free
// runs left on this task, up to 200,000 words", on the cards the code can
// actually pay for and nowhere else.
//
// Pure on purpose. The frontend has no test runner, so the rule lives here
// and backend/test/codeBalanceNote.test.ts pins it — the same arrangement as
// textLocate.ts.

import type { FrontCard } from "./types";

export type CloudProduct = "edit" | "readthrough" | "translate" | "enhance";

/** The card an author clicks, and the product Bethaniel sells for it. Only
 *  the language card differs: its cloud run is the enhanced analysis. */
export const PRODUCT_FOR_CARD: Record<FrontCard, CloudProduct> = {
  edit: "edit",
  readthrough: "readthrough",
  translate: "translate",
  language: "enhance",
};

/** The Worker's answer — see codeBalance() in worker/src/quote.ts. */
export interface CodeBalance {
  code: string;
  maxWords: number | null;
  /** Only a code that takes the price to zero. A partial discount is not one. */
  free: boolean;
  /** One pool spent across every card, rather than a count per card. */
  shared: boolean;
  runsLeft: Record<CloudProduct, number>;
}

/**
 * Every line a card can carry. A list rather than a bare union so a test can
 * walk it against i18n.ts: a missing string renders the raw key to the
 * author, exactly as scan_check_dialect once did.
 */
export const BALANCE_NOTE_KEYS = [
  "cloud_code_runs_shared",
  "cloud_code_runs_shared_one",
  "cloud_code_runs_card",
  "cloud_code_runs_card_one",
] as const;

/** The clause appended when the code caps the manuscript size. */
export const BALANCE_CAP_KEY = "cloud_code_upto";

export interface BalanceNote {
  key: (typeof BALANCE_NOTE_KEYS)[number];
  runs: number;
  /** null when the code caps nothing — the clause is dropped, not printed. */
  maxWords: number | null;
}

/**
 * The note for one card, or null when the card should stay exactly as it is.
 *
 * Silent for: no code, a balance that never arrived, a Worker too old to
 * answer, a code that only discounts, and every card with nothing left on it.
 * Silence is the designed outcome, not a failure — the price beside it is
 * still correct, and the quote still explains a code that does not apply.
 *
 * `shared` picks the wording and it is the one thing that must not be got
 * wrong: with one pool across four cards, a per-card phrasing invites the
 * author to read four cards and add them up.
 */
export function noteFor(
  balance: CodeBalance | null | undefined,
  card: FrontCard,
): BalanceNote | null {
  if (!balance || !balance.free) return null;
  // A response from an older Worker, or anything else unexpected: the app
  // must never depend on a field a deployed Worker may not have.
  if (!balance.runsLeft || typeof balance.runsLeft !== "object") return null;
  const runs = balance.runsLeft[PRODUCT_FOR_CARD[card]];
  if (typeof runs !== "number" || runs < 1) return null;
  const key = balance.shared
    ? runs === 1
      ? "cloud_code_runs_shared_one"
      : "cloud_code_runs_shared"
    : runs === 1
      ? "cloud_code_runs_card_one"
      : "cloud_code_runs_card";
  return { key, runs, maxWords: balance.maxWords ?? null };
}
