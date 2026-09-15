// ── The review as a deck: one suggestion at a time ──
//
// The review used to be a column of cards per chapter, each with a checkbox,
// each carrying a "Chunk 2/12" nobody needed. Reading it meant scrolling, and
// deciding meant hunting for a small box. This is the same corrections as a
// deck: the next undecided suggestion sits at the top of the column, in the
// same place every time, with Accept and Dismiss under it, large. Answering
// zooms the card away and the next one takes its place, so the eye never
// leaves the first line. Chapters run into each other — the deck simply
// continues, and the chapter name above it changes — and Back undoes the
// last answer, wherever it was.
//
// The decisions themselves are the same acceptances as before (store.ts):
// what is exported is unchanged, and nothing is hidden. A suggestion the
// reviewer doubted arrives with its badge and starts unticked; the deck
// only says which one is up next.

import { useEffect, useMemo, useRef, useState } from "react";

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { certaintyPercent, flagKindOf, isReliable } from "../types";
import type { Correction, TaskState } from "../types";
import { inTextOrder } from "../textLocate";
import { extractSentenceContext, InlineDiff, VerdictBadge } from "./ReviewExport";

export interface DeckItem {
  taskId: string;
  taskName: string;
  correction: Correction;
  originalText: string;
}

/** The deck's order: chapters as given (manuscript order), each chapter's
 *  suggestions by position in its text, the doubted ones after the rest. */
export function buildDeck(entries: [string, TaskState][]): DeckItem[] {
  const items: DeckItem[] = [];
  for (const [taskId, task] of entries) {
    const result = task.result;
    if (!result) continue;
    const visible = inTextOrder(
      result.corrections.filter((c) => c.id && c.reason !== "dialect"),
      result.originalText,
    );
    const main = visible.filter((c) => flagKindOf(c) !== "doubted");
    const doubted = visible.filter((c) => flagKindOf(c) === "doubted");
    for (const correction of [...main, ...doubted]) {
      items.push({ taskId, taskName: task.name, correction, originalText: result.originalText });
    }
  }
  return items;
}

/** How many of a job's suggestions still want an answer. */
export function countUndecided(
  entries: [string, TaskState][],
  decisionLog: { taskId: string; correctionId: string }[],
): { left: number; total: number } {
  const deck = buildDeck(entries);
  const decided = new Set(decisionLog.map((d) => `${d.taskId}\u0000${d.correctionId}`));
  const left = deck.filter((item) => !decided.has(`${item.taskId}\u0000${item.correction.id}`)).length;
  return { left, total: deck.length };
}

const LEAVE_MS = 260;
const PEEK = 3;
/** Certainty under which the line says Betty is unsure rather than would accept. */
const UNSURE_BELOW = 70;

export default function ReviewDeck({
  entries,
  cursorTaskId,
  onChapterChange,
  onDecide,
  doneSlot,
  notice,
}: {
  /** Edit tasks of one job, in manuscript order, results hydrated. */
  entries: [string, TaskState][];
  /** The chapter the author picked from the list, if any: the deck jumps there. */
  cursorTaskId: string | null;
  /** Called when the chapter at the top of the deck changes. */
  onChapterChange: (taskId: string) => void;
  /** After a decision is recorded — the parent offers "same change elsewhere". */
  onDecide?: (action: "accept" | "dismiss", taskId: string, correction: Correction) => void;
  /** What sits under the finished-deck text: the export button, in focus. */
  doneSlot?: React.ReactNode;
  /** A line above the stack, after an answer: "do the same elsewhere?" */
  notice?: React.ReactNode;
}) {
  const lang = useStore((s) => s.lang);
  const t = useTranslation(lang);
  const decisionLog = useStore((s) => s.decisionLog);
  const decideCorrection = useStore((s) => s.decideCorrection);
  const undoDecision = useStore((s) => s.undoDecision);

  const deck = useMemo(() => buildDeck(entries), [entries]);
  const decided = useMemo(() => {
    const set = new Set<string>();
    for (const d of decisionLog) set.add(`${d.taskId}\u0000${d.correctionId}`);
    return set;
  }, [decisionLog]);
  const keyOf = (item: DeckItem) => `${item.taskId}\u0000${item.correction.id}`;

  // A card on its way out stays rendered until its animation is done; the
  // decision is recorded when it has gone, so the next card slides up under
  // a card that is visibly leaving rather than snapping into an empty slot.
  const [leaving, setLeaving] = useState<{ key: string; action: "accept" | "dismiss" | "postpone" } | null>(null);
  // Cards put off for later, in the order they were put off: they come
  // back at the very end of the deck, whatever chapter they belong to.
  // With them, what Back should undo: the last thing done, whether it was
  // an answer or a postponement.
  const [postponed, setPostponed] = useState<string[]>([]);
  const [history, setHistory] = useState<("decide" | "postpone")[]>([]);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  // The queue: undecided items from the cursor chapter onward, then the
  // ones before it — so picking a chapter starts there, and finishing the
  // book's last chapter comes back around for anything skipped.
  const remaining = useMemo(() => {
    const later = new Set(postponed);
    const undecided = deck.filter((item) => !decided.has(keyOf(item)) && !later.has(keyOf(item)));
    const byKey = new Map(deck.map((item) => [keyOf(item), item]));
    const tail = postponed.map((k) => byKey.get(k)).filter((item): item is DeckItem => !!item && !decided.has(keyOf(item)));
    let ordered = undecided;
    if (cursorTaskId) {
      const at = undecided.findIndex((item) => item.taskId === cursorTaskId);
      if (at > 0) ordered = [...undecided.slice(at), ...undecided.slice(0, at)];
    }
    return [...ordered, ...tail];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, decided, cursorTaskId, postponed]);

  const top = remaining[0] ?? null;
  const total = deck.length;
  const done = total - remaining.length;

  // Tell the parent which chapter is up, so the chapter picker follows.
  const lastTop = useRef<string | null>(null);
  useEffect(() => {
    if (top && top.taskId !== lastTop.current) {
      lastTop.current = top.taskId;
      onChapterChange(top.taskId);
    }
  }, [top, onChapterChange]);

  const decide = (item: DeckItem, action: "accept" | "dismiss") => {
    if (leaving || !item.correction.id) return;
    const key = keyOf(item);
    setLeaving({ key, action });
    leaveTimer.current = setTimeout(() => {
      decideCorrection(item.taskId, item.correction.id!, action);
      onDecide?.(action, item.taskId, item.correction);
      setHistory((h) => [...h, "decide"]);
      setLeaving(null);
    }, LEAVE_MS);
  };
  // Not now: the card goes to the end of the whole deck and comes back
  // once everything else has been answered.
  const postpone = (item: DeckItem) => {
    if (leaving || !item.correction.id) return;
    const key = keyOf(item);
    if (remaining.length === 1) return; // nothing to put it behind
    setLeaving({ key, action: "postpone" });
    leaveTimer.current = setTimeout(() => {
      setPostponed((p) => [...p.filter((k) => k !== key), key]);
      setHistory((h) => [...h, "postpone"]);
      setLeaving(null);
    }, LEAVE_MS);
  };
  const back = () => {
    if (leaving) return;
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    if (last === "postpone") setPostponed((p) => p.slice(0, -1));
    else undoDecision();
  };

  // Keys, for the author who would rather not reach for the mouse: the
  // arrows, laid out the way the buttons are — ← dismiss, → accept — and
  // the vertical pair the way the cards move: ↑ brings the last one back
  // up, ↓ sends this one down to the end of the deck. (A and D were tried
  // and sit the wrong way round on the keyboard for buttons that read
  // Dismiss | Accept.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!top) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        decide(top, "accept");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        decide(top, "dismiss");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        back();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        postpone(top);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [top, leaving, history, remaining.length]);

  if (total === 0) return null;

  const renderCard = (item: DeckItem, position: number) => {
    const key = keyOf(item);
    const isTop = position === 0;
    const isLeaving = leaving?.key === key;
    const ctx = extractSentenceContext(item.correction.original, item.originalText, 0);
    const kind = flagKindOf(item.correction);
    const cameBack = postponed.includes(key);
    // Three things the line under the buttons can say: Betty would take it
    // (a confident reviewer), she is unsure (the middle of the scale — a 3,
    // or a 4 the second check doubted), or she would leave it (a reviewer
    // who scored it low, or nothing reviewed it).
    const pct = certaintyPercent(item.correction);
    const hint = !isReliable(item.correction)
      ? t("deck_betty_would_leave")
      : pct !== null && pct < UNSURE_BELOW
        ? t("deck_betty_unsure")
        : t("deck_betty_would_accept");
    return (
      <div
        // A card is remounted when it becomes the top card, so the rise
        // animation runs on it once.
        key={isTop ? `${key} top` : key}
        className={[
          "deck-card",
          isTop ? "deck-card-top" : `deck-card-peek deck-card-peek-${position}`,
          kind ? `flagged flagged-${kind}` : "",
          isLeaving ? `deck-card-leaving deck-card-leaving-${leaving!.action}` : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden={!isTop}
      >
        {isTop && cameBack && <p className="deck-came-back small-note">{t("deck_came_back")}</p>}
        <div className="deck-card-body">
          <span className="correction-diff">
            {ctx.before && <span className="correction-context">{ctx.before} </span>}
            <InlineDiff before={item.correction.original} after={item.correction.corrected} />
            {ctx.after && <span className="correction-context"> {ctx.after}</span>}
          </span>
        </div>
        {/* What the reviewer said, in the open — it used to be a tooltip on
            the badge, and a reason worth reading is worth reading without
            hovering for it. */}
        {isTop && (item.correction.reviewReason || kind === "doubted") && (
          <p className="deck-reason">
            {item.correction.reviewReason ? `“${item.correction.reviewReason}”` : t("flag_doubted_why")}
          </p>
        )}
        {isTop && (
          <>
          <div className="deck-actions">
            <button
              type="button"
              className="deck-btn deck-btn-dismiss"
              onClick={() => decide(item, "dismiss")}
              title={`${t("deck_dismiss")} — ←`}
            >
              <span className="deck-btn-mark" aria-hidden="true">✕</span>
              {t("deck_dismiss")}
            </button>
            <span className="deck-hint">
              <span className="deck-hint-line">{hint}</span>
              <span className="deck-card-verdict">
                <VerdictBadge correction={item.correction} compact />
              </span>
            </span>
            <button
              type="button"
              className="deck-btn deck-btn-accept"
              onClick={() => decide(item, "accept")}
              title={`${t("deck_accept")} — →`}
            >
              <span className="deck-btn-mark" aria-hidden="true">✓</span>
              {t("deck_accept")}
            </button>
          </div>
          {remaining.length > 1 && (
            <button
              type="button"
              className="deck-later"
              onClick={() => postpone(item)}
              title={`${t("deck_later")} — ↓`}
            >
              <span aria-hidden="true">↓</span> {t("deck_later")}
            </button>
          )}
          </>
        )}
      </div>
    );
  };

  const shown = remaining.slice(0, PEEK + 1);
  // The chapter after the top card, when the top card is its chapter's last.
  const nextChapter =
    top && remaining.find((item) => item.taskId !== top.taskId)?.taskName;
  const chapterLeft = top ? remaining.filter((item) => item.taskId === top.taskId).length : 0;

  return (
    <section className="deck" aria-label={t("deck_title")}>
      <div className="deck-head">
        <div className="deck-head-chapter" key={top?.taskId ?? "done"}>
          {top ? (
            <>
              <span className="deck-chapter-name">{top.taskName}</span>
              <span className="deck-chapter-count">
                {t("deck_chapter_left").replace("{n}", String(chapterLeft))}
              </span>
            </>
          ) : (
            <span className="deck-chapter-name">{t("deck_all_done")}</span>
          )}
        </div>
        <div className="deck-head-right">
          <span className="deck-progress">
            {t("deck_progress").replace("{done}", String(done)).replace("{total}", String(total))}
          </span>
          <button
            type="button"
            className="deck-back"
            onClick={back}
            disabled={history.length === 0 || !!leaving}
            title={`${t("deck_back")} — ↑`}
          >
            <span aria-hidden="true">↶</span> {t("deck_back")}
          </button>
        </div>
      </div>

      {notice}

      <div className="deck-stack">
        {shown.map((item, i) => renderCard(item, i))}
        {!top && (
          <div className="deck-card deck-card-top deck-card-done">
            <p className="deck-done-text">{t("deck_done_text").replace("{n}", String(total))}</p>
            {doneSlot && <div className="deck-done-actions">{doneSlot}</div>}
          </div>
        )}
      </div>

      {top && history.length === 0 && (
        <p className="deck-keys small-note">
          <kbd>←</kbd> {t("deck_dismiss")} · <kbd>→</kbd> {t("deck_accept")} · <kbd>↑</kbd> {t("deck_back")} · <kbd>↓</kbd> {t("deck_later")}
        </p>
      )}
      {top && chapterLeft === 1 && nextChapter && (
        <p className="deck-next small-note">{t("deck_next_chapter").replace("{name}", nextChapter)}</p>
      )}
    </section>
  );
}
