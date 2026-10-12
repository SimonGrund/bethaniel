// ── What the author decided about Betty's reading of their style sheet ──
//
// Betty reads the free-text sheet into rules (backend/src/styleSheetRules.ts)
// and the author confirms each on a card (StyleSheetQuestions). The answers
// are kept per manuscript, keyed by the statement they are about, so a
// statement is read and asked about once: the next run sends the same rules
// without a question, and only a new or edited line is read again.
//
// Pure; tested from backend/test/styleSheetDecisions.test.ts.

export type SheetRuleKind = "replace" | "keep" | "casing" | "dialogue" | "note";

export interface CasingSample {
  original: string;
  corrected: string;
  sentence: string;
  /** The word in question, as written. */
  word?: string;
}

/** The sentence split around the word in question, for marking it. */
export function markWord(sentence: string, word?: string): [string, string, string] {
  if (!word) return [sentence, "", ""];
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, "u").exec(sentence);
  if (!m) return [sentence, "", ""];
  return [sentence.slice(0, m.index), m[0], sentence.slice(m.index + m[0].length)];
}

/** A reading as the backend returns it, with what the card shows. */
export interface SheetRuleView {
  kind: SheetRuleKind;
  source: string;
  prefer?: string;
  avoid?: string[];
  terms?: string[];
  when?: string;
  who?: string;
  /** Already the author's decision (a house-style answer): no card. */
  settled?: boolean;
  evidence?: {
    counts?: { form: string; count: number }[];
    casing?: { form: string; capitalised: number; lowercase: number }[];
    minority?: CasingSample[];
    candidates?: { name: string; count: number }[];
  };
}

/** The author's answer about one statement. */
export interface SheetDecision {
  kind: SheetRuleKind;
  source: string;
  /** Made a rule. False: the statement stays a note for the editor. */
  accepted: boolean;
  prefer?: string;
  avoid?: string[];
  terms?: string[];
  speakers?: string[];
  fixes?: { original: string; corrected: string }[];
}

/** The rule as the run carries it (backend ConfirmedSheetRule). */
export type ConfirmedSheetRule = Omit<SheetDecision, "accepted">;

/** Does this reading need the author? Notes and settled lines do not. */
export function needsCard(r: SheetRuleView): boolean {
  return r.kind !== "note" && !r.settled;
}

/** The decision a reading gets without a card. */
export function decisionWithoutCard(r: SheetRuleView): SheetDecision {
  return {
    kind: r.kind,
    source: r.source,
    accepted: !!r.settled,
    prefer: r.prefer,
    avoid: r.avoid,
    terms: r.terms,
  };
}

/** The statements already decided that the guide still contains: not
 *  read again. */
export function knownStatements(
  decisions: Record<string, SheetDecision> | undefined,
  guide: string,
): string[] {
  return Object.keys(decisions ?? {}).filter((s) => guide.includes(s));
}

/** The rules this run enforces: accepted, and still in the guide — a line
 *  the author has since deleted takes its rule with it. */
export function rulesForRun(
  decisions: Record<string, SheetDecision> | undefined,
  guide: string,
): ConfirmedSheetRule[] {
  return Object.values(decisions ?? {})
    .filter((d) => d.accepted && guide.includes(d.source))
    .map(({ accepted: _a, ...rule }) => rule);
}
