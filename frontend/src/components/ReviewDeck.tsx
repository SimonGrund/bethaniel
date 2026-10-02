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
import { countRejected, progressOf, reviewerRejected } from "../deckProgress";
import { putLexicon } from "../api";
import { dropCoveredFindings } from "../coveredFindings";
import { InlineDiff } from "./ReviewExport";
import { compactContext, extendedContext } from "../deckContext";

export interface DeckItem {
  taskId: string;
  taskName: string;
  correction: Correction;
  originalText: string;
}

/** The deck's order: chapters as given (manuscript order), each chapter's
 *  suggestions by position in its text, the doubted ones after the rest.
 *
 *  `showAll` includes the ones the reviewer rejected outright, which are held
 *  back by default. They were 61% of the deck on two real books and right
 *  about one time in twenty — see deckProgress.ts for the count and the
 *  reason the neighbouring bucket is NOT held back with them. */
export function buildDeck(
  entries: [string, TaskState][],
  showAll = false,
): DeckItem[] {
  const items: DeckItem[] = [];
  for (const [taskId, task] of entries) {
    const result = task.result;
    if (!result) continue;
    // A no-fix finding on a word another suggestion already fixes is the
    // same question twice; results saved before the backend dropped these
    // still carry them.
    const answerable = dropCoveredFindings(
      result.originalText,
      result.corrections.filter((c) => c.id && c.reason !== "dialect"),
    );
    const visible = inTextOrder(
      answerable.filter((c) => showAll || !reviewerRejected(c)),
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

/** How many suggestions this job holds back, across every chapter. */
export function countHeldBack(entries: [string, TaskState][]): number {
  let n = 0;
  for (const [, task] of entries) {
    const cs = task.result?.corrections ?? [];
    n += countRejected(cs.filter((c) => c.id && c.reason !== "dialect"));
  }
  return n;
}

/** How many of a job's suggestions still want an answer. */
export function countUndecided(
  entries: [string, TaskState][],
  decisionLog: { taskId: string; correctionId: string }[],
  showAll = false,
): { left: number; total: number } {
  const deck = buildDeck(entries, showAll);
  const decided = new Set(decisionLog.map((d) => `${d.taskId}\u0000${d.correctionId}`));
  const left = deck.filter((item) => !decided.has(`${item.taskId}\u0000${item.correction.id}`)).length;
  return { left, total: deck.length };
}

const LEAVE_MS = 260;
/** Certainty under which the line says Betty is unsure rather than would accept. */
const UNSURE_BELOW = 70;
/** The settings menu's "always show the explanation", remembered across
 *  sessions. Off by default: most cards are decided on the sentence alone. */
const AUTO_WHY_KEY = "bethaniel.deck.autoWhy";

function readAutoWhy(): boolean {
  try {
    return localStorage.getItem(AUTO_WHY_KEY) === "1";
  } catch {
    return false;
  }
}

export default function ReviewDeck({
  entries,
  cursorTaskId,
  onChapterChange,
  onDecide,
  doneSlot,
  notice,
  restartToken = 0,
  jumpControl,
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
  /** Bump to start over from the first card, answered ones included. */
  restartToken?: number;
  /** The jump-to control, offered in the settings menu. */
  jumpControl?: React.ReactNode;
}) {
  const lang = useStore((s) => s.lang);
  const t = useTranslation(lang);
  const decisionLog = useStore((s) => s.decisionLog);
  const decideCorrection = useStore((s) => s.decideCorrection);
  const amendCorrection = useStore((s) => s.amendCorrection);
  const dismissFindingsForWord = useStore((s) => s.dismissFindingsForWord);
  const addLexiconTerm = useStore((s) => s.addLexiconTerm);
  /** What the author has typed into the "correct to" field of the top card.
   *  Keyed by correction id so moving through the deck does not carry it. */
  const [typedFix, setTypedFix] = useState<Record<string, string>>({});
  /** The card showing a paragraph either side. Per card: the wider view is
   *  for the one suggestion that needs it, not the next forty. */
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  /** Show the reviewer's reason on every card without asking (settings). */
  const [autoWhy, setAutoWhyState] = useState<boolean>(readAutoWhy);
  /** The card whose "Why?" was clicked, flipping the default for it alone. */
  const [whyToggledKey, setWhyToggledKey] = useState<string | null>(null);
  const setAutoWhy = (on: boolean) => {
    setAutoWhyState(on);
    setWhyToggledKey(null);
    try {
      localStorage.setItem(AUTO_WHY_KEY, on ? "1" : "0");
    } catch {
      /* private window: the choice lasts the session */
    }
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [settingsOpen]);
  const acceptedCorrections = useStore((s) => s.acceptedCorrections);
  // What was put off and what Back undoes live in the store, so the deck
  // comes back as it was left.
  const postponed = useStore((s) => s.deckPostponed);
  const allHistory = useStore((s) => s.deckHistory);
  const jobTaskIds = useMemo(() => entries.map(([tid]) => tid), [entries]);
  const history = useMemo(() => {
    const mine = new Set(jobTaskIds);
    return allHistory.filter((h) => mine.has(h.taskId));
  }, [allHistory, jobTaskIds]);
  const postponeCard = useStore((s) => s.postponeCard);
  const deckBack = useStore((s) => s.deckBack);

  const showAllSuggestions = useStore((s) => s.showAllSuggestions);
  const setShowAllSuggestions = useStore((s) => s.setShowAllSuggestions);
  const deck = useMemo(
    () => buildDeck(entries, showAllSuggestions),
    [entries, showAllSuggestions],
  );
  const heldBack = useMemo(() => countHeldBack(entries), [entries]);
  /**
   * The author typed a replacement.
   *
   * Amend the correction, then answer the card with it. Without the second
   * half the card stayed on top of the deck and turned back into an ordinary
   * Accept/Dismiss suggestion — so supplying a fix meant answering the same
   * finding twice. Typing a correction IS the answer.
   */
  const applyTypedFix = (item: DeckItem) => {
    const id = item.correction.id;
    if (!id || leaving) return;
    const value = (typedFix[id] ?? "").trim();
    if (!value || value === item.correction.original.trim()) return;
    amendCorrection(item.taskId, id, value);
    setTypedFix((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    const key = keyOf(item);
    setLeaving({ key, action: "accept" });
    leaveTimer.current = setTimeout(() => {
      decideCorrection(item.taskId, id, "accept");
      onDecide?.("accept", item.taskId, item.correction);
      setLeaving(null);
    }, LEAVE_MS);
  };

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
  // Starting over: every card comes round again, the answered ones with
  // their earlier answer on them, until each has a fresh one. "Fresh" is
  // anything logged after the restart — the log is in order, so its length
  // at that moment is the mark.
  const [revisit, setRevisit] = useState<{ logLen: number } | null>(null);
  useEffect(() => {
    if (restartToken > 0) setRevisit({ logLen: useStore.getState().decisionLog.length });
  }, [restartToken]);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
  }, []);

  // Answered since a restart — the only answers that retire a card then.
  const fresh = useMemo(() => {
    if (!revisit) return decided;
    const set = new Set<string>();
    for (const d of decisionLog.slice(revisit.logLen)) set.add(`${d.taskId}\u0000${d.correctionId}`);
    return set;
  }, [revisit, decided, decisionLog]);

  // The queue: unanswered items from the cursor chapter onward, then the
  // ones before it — so picking a chapter starts there, and finishing the
  // book's last chapter comes back around for anything skipped — and the
  // cards put off for later at the very end.
  const remaining = useMemo(() => {
    const later = new Set(postponed);
    const open = deck.filter((item) => !fresh.has(keyOf(item)) && !later.has(keyOf(item)));
    const byKey = new Map(deck.map((item) => [keyOf(item), item]));
    const tail = postponed.map((k) => byKey.get(k)).filter((item): item is DeckItem => !!item && !fresh.has(keyOf(item)));
    let ordered = open;
    if (cursorTaskId) {
      const at = open.findIndex((item) => item.taskId === cursorTaskId);
      if (at > 0) ordered = [...open.slice(at), ...open.slice(0, at)];
    }
    return [...ordered, ...tail];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deck, fresh, cursorTaskId, postponed]);

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
      postponeCard(key);
      setLeaving(null);
    }, LEAVE_MS);
  };
  const back = () => {
    if (leaving) return;
    deckBack(jobTaskIds);
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
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!top) return;
      // A finding that proposes nothing has no verdict to give: accepting it
      // would change the text not at all and dismissing it would throw the
      // finding away. The card offers a dictionary entry or a typed fix
      // instead, so the arrows that mean those two things do nothing here.
      // Later (↓) and Back (↑) still work — they are about the deck, not the
      // correction.
      const topUnfixable = top.correction.corrected === top.correction.original;
      if (topUnfixable && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        return;
      }
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
    const expanded = isTop && expandedKey === key;
    const whyOpen = isTop && autoWhy !== (whyToggledKey === key);
    // Compact by default: the change's own sentence, inside its paragraph,
    // line breaks flattened — so the buttons never leave the screen. See
    // deckContext.ts for why the old sentence reading ran on.
    const ctx = (expanded ? extendedContext : compactContext)(
      item.correction.original,
      item.originalText,
    );
    const kind = flagKindOf(item.correction);
    const cameBack = postponed.includes(key);
    // Starting over: what the author said last time, on the card.
    const earlier =
      revisit && decided.has(key) && !fresh.has(key)
        ? (() => {
            const set = acceptedCorrections[item.taskId] ?? new Set<string>();
            const id = item.correction.id ?? "";
            return set.has(id) || [...set].some((k) => k.startsWith(`${id}:`)) ? "accept" : "dismiss";
          })()
        : null;
    // Three things the line under the buttons can say: Betty would take it
    // (a confident reviewer), she is unsure (the middle of the scale — a 3,
    // or, on older results, a 4 the precision pass doubted), or she would
    // leave it (a reviewer
    // who scored it low, or nothing reviewed it).
    // A finding that proposes nothing. Accept would change the text not at
    // all; dismiss would throw away a real finding.
    const unfixable = item.correction.corrected === item.correction.original;
    const pct = certaintyPercent(item.correction);
    const hint = !isReliable(item.correction)
      ? t("deck_betty_would_leave")
      : pct !== null && pct < UNSURE_BELOW
        ? t("deck_betty_unsure")
        : t("deck_betty_would_accept");
    const tone = pct === null ? "none" : pct >= UNSURE_BELOW ? "sure" : pct >= 45 ? "mid" : "low";
    const reason = item.correction.reviewReason
      ? `“${item.correction.reviewReason}”`
      : kind === "doubted"
        ? t("flag_doubted_why")
        : "";
    // Only offer the wider view when it shows something the compact one
    // does not.
    const hasMore =
      isTop &&
      (() => {
        const wide = extendedContext(item.correction.original, item.originalText);
        const narrow = expanded ? compactContext(item.correction.original, item.originalText) : ctx;
        return wide.before !== narrow.before || wide.after !== narrow.after;
      })();
    return (
      <div
        // A card is remounted when it becomes the top card, so the rise
        // animation runs on it once.
        key={isTop ? `${key}\u0000top` : key}
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
        {isTop && earlier && (
          <p className={`deck-earlier deck-earlier-${earlier} small-note`}>
            {t(earlier === "accept" ? "deck_earlier_accept" : "deck_earlier_dismiss")}
          </p>
        )}
        {/* One line saying what this is and how sure Betty is, with the two
            things most cards do not need — more of the text, and the
            reviewer's reason — one click away instead of always open. */}
        <div className="deck-card-head">
          <span className="deck-suggests" title={hint}>
            <span className={`deck-dot deck-dot-${tone}`} aria-hidden="true" />
            {pct === null
              ? `${t("deck_suggests")} · ${t(kind === "unreviewed" ? "flag_unreviewed" : "flag_unchecked")}`
              : t("deck_suggests_pct").replace("{pct}", String(pct))}
          </span>
          {isTop && (
            <span className="deck-card-toggles">
              {hasMore && (
                <button
                  type="button"
                  className="deck-toggle"
                  aria-expanded={expanded}
                  onClick={() => setExpandedKey(expanded ? null : key)}
                >
                  {t(expanded ? "deck_less_context" : "deck_more_context")}
                </button>
              )}
              {reason && (
                <button
                  type="button"
                  className="deck-toggle"
                  aria-expanded={whyOpen}
                  onClick={() => setWhyToggledKey(whyToggledKey === key ? null : key)}
                >
                  {t(whyOpen ? "deck_hide_why" : "deck_why")}
                </button>
              )}
            </span>
          )}
        </div>
        <div className={`deck-card-body${expanded ? " deck-card-body-expanded" : ""}`}>
          <span className="correction-diff">
            {ctx.before && (
              <span className="correction-context">
                {ctx.before}
                {ctx.before.endsWith("\n") ? "" : " "}
              </span>
            )}
            {unfixable ? (
              // Nothing is proposed, so there is nothing to diff. The word
              // itself is the finding.
              <mark className="deck-unfixable-word">{item.correction.original}</mark>
            ) : (
              <InlineDiff before={item.correction.original} after={item.correction.corrected} />
            )}
            {ctx.after && (
              <span className="correction-context">
                {ctx.after.startsWith("\n") ? "" : " "}
                {ctx.after}
              </span>
            )}
          </span>
        </div>
        {whyOpen && reason && <p className="deck-reason">{reason}</p>}
        {isTop && unfixable && (
          // Accept and dismiss are both wrong here: accepting changes nothing
          // and dismissing throws away a real finding. What the author wants
          // is to vouch for the word or to supply the fix themselves.
          <div className="deck-unfixable-actions">
            <button
              type="button"
              className="deck-btn deck-btn-dictionary"
              onClick={() => {
                const word = item.correction.original.trim();
                addLexiconTerm(word);
                const lex = useStore.getState().lexicon;
                const docId = useStore.getState().document?.id;
                if (lex && docId) void putLexicon(docId, lex).catch(() => {});
                dismissFindingsForWord(word);
              }}
              title={t("unfixable_add_hint")}
            >
              {t("unfixable_add_to_dictionary")}
            </button>
            <span className="deck-unfixable-correct">
              <label>
                {t("unfixable_correct_to")}
                <input
                  type="text"
                  value={typedFix[item.correction.id ?? ""] ?? ""}
                  placeholder={item.correction.original.trim()}
                  onChange={(e) =>
                    setTypedFix((m) => ({
                      ...m,
                      [item.correction.id ?? ""]: e.target.value,
                    }))
                  }
                  // The deck answers ← → ↑ ↓ globally; while a field has focus
                  // those are cursor keys, not verdicts.
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyTypedFix(item);
                    }
                  }}
                />
              </label>
              <button
                type="button"
                className="deck-btn deck-btn-accept"
                disabled={
                  !(typedFix[item.correction.id ?? ""] ?? "").trim() ||
                  (typedFix[item.correction.id ?? ""] ?? "").trim() ===
                    item.correction.original.trim()
                }
                onClick={() => applyTypedFix(item)}
              >
                {t("unfixable_apply")}
              </button>
            </span>
          </div>
        )}
        {isTop && !unfixable && (
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

  // The card in front of the author and nothing else: the ones behind it
  // used to peek out underneath, and were only something more to look at.
  const shown = remaining.slice(0, 1);
  // The chapter after the top card, when the top card is its chapter's last.
  const nextChapter =
    top && remaining.find((item) => item.taskId !== top.taskId)?.taskName;
  // Two numbers, because "18 left in this chapter" says nothing about how
  // much book is behind it: an author twenty cards into four hundred and an
  // author twenty from the end both read the same line. The chapter's is the
  // one in front of them; the book's is the one they are actually asking
  // about when they wonder whether to keep going.
  const chapterLeft = top ? remaining.filter((item) => item.taskId === top.taskId).length : 0;
  const chapterTotal = top ? deck.filter((item) => item.taskId === top.taskId).length : 0;
  const chapterProgress = progressOf(chapterTotal - chapterLeft, chapterTotal);
  const bookProgress = progressOf(done, total);

  return (
    <section className="deck" aria-label={t("deck_title")}>
      <div className="deck-head">
        <div className="deck-head-chapter" key={top?.taskId ?? "done"}>
          {top ? (
            <>
              <span className="deck-chapter-name">{top.taskName}</span>
              <span className="deck-chapter-count">
                {t("deck_chapter_progress")
                  .replace("{done}", String(chapterProgress.decided))
                  .replace("{total}", String(chapterProgress.total))
                  .replace("{pct}", String(chapterProgress.percent))}
              </span>
            </>
          ) : (
            <span className="deck-chapter-name">{t("deck_all_done")}</span>
          )}
        </div>
        <div className="deck-head-right">
          <span className="deck-progress">
            {t("deck_progress")
              .replace("{done}", String(bookProgress.decided))
              .replace("{total}", String(bookProgress.total))
              .replace("{pct}", String(bookProgress.percent))}
          </span>
          {/* Everything that is not the card: where to jump, the held-back
              suggestions, whether the explanation opens by itself. */}
          <div className="deck-settings" ref={settingsRef}>
            <button
              type="button"
              className="deck-settings-btn"
              aria-haspopup="true"
              aria-expanded={settingsOpen}
              aria-label={t("deck_settings")}
              title={t("deck_settings")}
              onClick={() => setSettingsOpen((o) => !o)}
            >
              ⚙
            </button>
            {settingsOpen && (
              <div
                className="deck-settings-menu"
                role="dialog"
                aria-label={t("deck_settings")}
                onKeyDown={(e) => {
                  // Escape closes the menu, not the whole review.
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setSettingsOpen(false);
                  }
                }}
              >
                {jumpControl && <div className="deck-settings-row">{jumpControl}</div>}
                <label className="deck-settings-row deck-settings-check">
                  <input
                    type="checkbox"
                    checked={autoWhy}
                    onChange={(e) => setAutoWhy(e.target.checked)}
                  />
                  <span>{t("deck_setting_auto_why")}</span>
                </label>
                {/* Held back by default, and said out loud rather than
                    silently dropped: an author who cannot find a suggestion
                    they remember seeing needs to know where it went. */}
                {heldBack > 0 && (
                  <label className="deck-settings-row deck-settings-check">
                    <input
                      type="checkbox"
                      checked={showAllSuggestions}
                      onChange={(e) => setShowAllSuggestions(e.target.checked)}
                    />
                    <span>
                      {t("deck_setting_show_heldback").replace("{n}", String(heldBack))}
                      <span className="deck-settings-note">
                        {t(showAllSuggestions ? "deck_heldback_shown" : "deck_heldback").replace(
                          "{n}",
                          String(heldBack),
                        )}
                      </span>
                    </span>
                  </label>
                )}
              </div>
            )}
          </div>
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

      {/* The book's progress as a bar. A percentage is a number to read; a
          bar is the same fact at a glance, and this is the one thing an
          author checks repeatedly while working through four hundred cards. */}
      <div
        className="deck-bar"
        role="progressbar"
        aria-valuenow={bookProgress.percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t("deck_progress_aria")}
      >
        <div className="deck-bar-fill" style={{ width: `${bookProgress.percent}%` }} />
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
        // A card with no fix to accept advertises only the keys that work on
        // it. Listing Dismiss and Accept there would promise two answers it
        // does not take — see the ArrowLeft/ArrowRight guard above.
        <p className="deck-keys small-note">
          {top.correction.corrected === top.correction.original ? (
            <>
              <kbd>↑</kbd> {t("deck_back")} · <kbd>↓</kbd> {t("deck_later")}
            </>
          ) : (
            <>
              <kbd>←</kbd> {t("deck_dismiss")} · <kbd>→</kbd> {t("deck_accept")} ·{" "}
              <kbd>↑</kbd> {t("deck_back")} · <kbd>↓</kbd> {t("deck_later")}
            </>
          )}
        </p>
      )}
      {top && chapterLeft === 1 && nextChapter && (
        <p className="deck-next small-note">{t("deck_next_chapter").replace("{name}", nextChapter)}</p>
      )}
    </section>
  );
}
