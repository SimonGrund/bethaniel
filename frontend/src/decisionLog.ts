// ── The deck's record of answers ──
//
// The deck counts a card as answered — in its progress line and in the queue
// it deals from — only when the answer is in the decision log. Accepting a
// correction without logging it changes the export but leaves the card
// unanswered: the count stands still and the card comes round again. That is
// what "the same change elsewhere → accept all" did, so every answer, one or
// many, goes through recordDecisions.
//
// Pure, and tested from backend/test/decisionLog.test.ts because the frontend
// has no test runner.

export type Decision = { taskId: string; correctionId: string; wasAccepted: boolean };
/** One step Back can undo. `count` is how many log entries it covers: an
 *  answer given to N cards at once is one step, not N presses of Back. */
export type DeckStep = { kind: "decide" | "postpone"; taskId: string; count?: number };

const keyOf = (taskId: string, correctionId: string) => `${taskId}\u0000${correctionId}`;

/** Whether a correction is on — whole, or any of its occurrences. */
export function isAccepted(set: Set<string> | undefined, correctionId: string): boolean {
  if (!set) return false;
  return set.has(correctionId) || [...set].some((k) => k.startsWith(`${correctionId}:`));
}

/**
 * The log, history and put-off list after answering `items` together. Call it
 * BEFORE the acceptances change: each entry keeps whether its correction was
 * on, which is what Back puts back.
 */
export function recordDecisions(
  state: {
    acceptedCorrections: Record<string, Set<string>>;
    decisionLog: Decision[];
    deckHistory: DeckStep[];
    deckPostponed: string[];
  },
  items: { taskId: string; correctionId: string }[],
): { decisionLog: Decision[]; deckHistory: DeckStep[]; deckPostponed: string[] } {
  if (items.length === 0) {
    return {
      decisionLog: state.decisionLog,
      deckHistory: state.deckHistory,
      deckPostponed: state.deckPostponed,
    };
  }
  const keys = new Set(items.map((i) => keyOf(i.taskId, i.correctionId)));
  const entries = items.map(({ taskId, correctionId }) => ({
    taskId,
    correctionId,
    wasAccepted: isAccepted(state.acceptedCorrections[taskId], correctionId),
  }));
  const step: DeckStep =
    items.length === 1
      ? { kind: "decide", taskId: items[0].taskId }
      : { kind: "decide", taskId: items[0].taskId, count: items.length };
  return {
    // A card answered again keeps only its latest answer.
    decisionLog: [
      ...state.decisionLog.filter((d) => !keys.has(keyOf(d.taskId, d.correctionId))),
      ...entries,
    ],
    deckHistory: [...state.deckHistory, step],
    // A card answered is no longer put off.
    deckPostponed: state.deckPostponed.filter((k) => !keys.has(k)),
  };
}
