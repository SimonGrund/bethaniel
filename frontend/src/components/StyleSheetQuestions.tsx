// ── What Betty understood from the author's style sheet ──
//
// The author's own instructions, read statement by statement into rules
// (backend/src/styleSheetRules.ts) by the model that will run the job —
// Local Betty before a local run, the cloud after a cloud run is paid for —
// and put back to the author one card at a time: "I read this as a rule.
// Right?" A confirmed rule is enforced by code; a declined one stays a note
// the editor reads, which is what the whole sheet used to be. So a wrong
// reading costs one keypress, and the free text stays the author's.
//
// Asked once per statement and manuscript: the answers are kept
// (styleSheetDecisions.ts), and only a new or edited line is read again.
//
// Same dark one-card room as EditQuestions and TranslationQuestions (the
// `tq` styles), answered from the keyboard: 1–2 picks, Enter goes on,
// ← goes back, Escape closes.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n";
import { readStyleSheet } from "../api";
import { useStore } from "../store";
import type { Lang } from "../types";
import {
  decisionWithoutCard,
  knownStatements,
  markWord,
  needsCard,
  type SheetDecision,
  type SheetRuleView,
} from "../styleSheetDecisions";

const quoted = (s: string) => `“${s}”`;

export default function StyleSheetQuestions({
  lang,
  docId,
  units,
  guide,
  model,
  manuscriptLang,
  cloud,
  onDone,
  onClose,
}: {
  lang: Lang;
  docId: string;
  units: string[];
  /** The style guide as the run will send it. */
  guide: string;
  /** The model that will run the job, and so reads the sheet. */
  model: string;
  manuscriptLang: string;
  /** A paid cloud run: closing still starts it. */
  cloud: boolean;
  onDone: () => void;
  onClose: () => void;
}) {
  const t = useTranslation(lang);
  const saveSheetDecisions = useStore((s) => s.saveSheetDecisions);

  const [rules, setRules] = useState<SheetRuleView[] | null>(null);
  const cards = useMemo(() => (rules ?? []).filter(needsCard), [rules]);
  const [step, setStep] = useState(0);
  /** Per card: made a rule (true) or left a note (false). */
  const [accept, setAccept] = useState<boolean[]>([]);
  /** Per card: the characters picked (dialogue), the spellings ticked (casing). */
  const [speakers, setSpeakers] = useState<string[][]>([]);
  const [ticked, setTicked] = useState<Set<number>[]>([]);
  const [showMinority, setShowMinority] = useState(false);

  // Read once, on open.
  useEffect(() => {
    const ac = new AbortController();
    const known = knownStatements(useStore.getState().sheetDecisions[docId], guide);
    void readStyleSheet({ docId, units, styleGuide: guide, model, known, manuscriptLang }, ac.signal).then(
      (read) => {
        if (ac.signal.aborted) return;
        const withCards = read.filter(needsCard);
        if (withCards.length === 0) {
          // Nothing to ask: what was read is kept, and the run goes on.
          saveSheetDecisions(docId, read.map(decisionWithoutCard));
          onDone();
          return;
        }
        setRules(read);
        setAccept(withCards.map(() => true));
        setSpeakers(withCards.map(() => []));
        setTicked(withCards.map(() => new Set<number>()));
      },
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const card = cards[step];
  const onLast = step === cards.length - 1;
  // A dialogue rule needs someone to apply to.
  const canAccept = !card || card.kind !== "dialogue" || (speakers[step]?.length ?? 0) > 0;
  const accepted = !!accept[step] && canAccept;

  const finish = () => {
    if (!rules) return;
    const decided: SheetDecision[] = rules.filter((r) => !needsCard(r)).map(decisionWithoutCard);
    cards.forEach((r, i) => {
      const yes = !!accept[i] && (r.kind !== "dialogue" || (speakers[i]?.length ?? 0) > 0);
      const minority = r.evidence?.minority ?? [];
      decided.push({
        kind: r.kind,
        source: r.source,
        accepted: yes,
        prefer: r.prefer,
        avoid: r.avoid,
        terms: r.terms,
        speakers: r.kind === "dialogue" ? speakers[i] : undefined,
        fixes:
          r.kind === "casing"
            ? [...(ticked[i] ?? [])].map((k) => minority[k]).filter(Boolean).map(({ original, corrected }) => ({ original, corrected }))
            : undefined,
      });
    });
    saveSheetDecisions(docId, decided);
    onDone();
  };

  const forward = () => {
    if (!rules) return;
    if (onLast) finish();
    else {
      setStep((s) => s + 1);
      setShowMinority(false);
    }
  };
  const back = () => {
    setStep((s) => Math.max(0, s - 1));
    setShowMinority(false);
  };
  const choose = (yes: boolean) => setAccept((a) => a.map((v, i) => (i === step ? yes : v)));

  const keysRef = useRef({ forward, back, choose, onClose });
  keysRef.current = { forward, back, choose, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keysRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        k.onClose();
        return;
      }
      if (e.target instanceof HTMLInputElement && e.key !== "Enter") return;
      if (e.key === "Enter") {
        e.preventDefault();
        k.forward();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        k.back();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        k.forward();
      } else if (e.key === "1") {
        e.preventDefault();
        k.choose(true);
      } else if (e.key === "2") {
        e.preventDefault();
        k.choose(false);
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, []);

  const question = (r: SheetRuleView): string => {
    if (r.kind === "replace")
      return t("ss_replace_q")
        .replace("{prefer}", quoted(r.prefer ?? ""))
        .replace("{avoid}", (r.avoid ?? []).map(quoted).join(", "));
    if (r.kind === "keep") return t("ss_keep_q");
    if (r.kind === "casing") return t("ss_casing_q");
    return t("ss_dialogue_q").replace("{who}", quoted(r.who ?? ""));
  };

  const body = (r: SheetRuleView) => {
    const ev = r.evidence ?? {};
    if (r.kind === "replace" || r.kind === "keep") {
      return (
        <p className="tq-why tq-why--lead">
          {(ev.counts ?? [])
            .map((c) => t("ss_count").replace("{form}", quoted(c.form)).replace("{n}", String(c.count)))
            .join(" · ")}
        </p>
      );
    }
    if (r.kind === "casing") {
      const minority = ev.minority ?? [];
      const mine = ticked[step] ?? new Set<number>();
      return (
        <>
          {r.when && <p className="tq-why tq-why--lead">{t("ss_casing_when").replace("{when}", r.when)}</p>}
          <ul className="ss-casing">
            {(ev.casing ?? []).map((c) => (
              <li key={c.form}>
                <span className="ss-form">{c.form}</span>{" "}
                {t("ss_casing_row")
                  .replace("{cap}", String(c.capitalised))
                  .replace("{low}", String(c.lowercase))}
              </li>
            ))}
          </ul>
          {minority.length > 0 && (
            <>
              <button type="button" className="tq-add" onClick={() => setShowMinority((v) => !v)}>
                {t(showMinority ? "ss_casing_hide" : "ss_casing_check").replace("{n}", String(minority.length))}
              </button>
              {showMinority && (
                <>
                  <p className="tq-why">{t("ss_casing_check_intro")}</p>
                  <ul className="ss-minority">
                    {minority.map((m, i) => (
                      <li key={i}>
                        <label>
                          <input
                            type="checkbox"
                            checked={mine.has(i)}
                            onChange={() =>
                              setTicked((all) =>
                                all.map((set, j) => {
                                  if (j !== step) return set;
                                  const next = new Set(set);
                                  if (next.has(i)) next.delete(i);
                                  else next.add(i);
                                  return next;
                                }),
                              )
                            }
                          />
                          <span>
                            {(() => {
                              const [a, w, b] = markWord(m.sentence, m.word);
                              return (
                                <>
                                  {a}
                                  {w && <mark className="ss-word">{w}</mark>}
                                  {b}
                                </>
                              );
                            })()}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </>
      );
    }
    // dialogue
    const picked = speakers[step] ?? [];
    const candidates = ev.candidates ?? [];
    return (
      <>
        <p className="tq-why tq-why--lead">{t("ss_dialogue_pick")}</p>
        {candidates.length === 0 ? (
          <p className="tq-why">{t("ss_dialogue_none")}</p>
        ) : (
          <div className="ss-names">
            {candidates.map((c) => {
              const on = picked.includes(c.name);
              return (
                <button
                  key={c.name}
                  type="button"
                  className={`ss-name${on ? " is-selected" : ""}`}
                  aria-pressed={on}
                  onClick={() =>
                    setSpeakers((all) =>
                      all.map((list, j) =>
                        j !== step ? list : on ? list.filter((n) => n !== c.name) : [...list, c.name],
                      ),
                    )
                  }
                >
                  {c.name}
                </button>
              );
            })}
          </div>
        )}
      </>
    );
  };

  const total = cards.length;
  const progress = total ? Math.round(((step + 1) / total) * 100) : 0;

  return createPortal(
    <div className="tq" role="dialog" aria-modal="true" aria-label={t("ss_title")}>
      <button
        type="button"
        className="tq-close"
        onClick={onClose}
        title={`${t(cloud ? "ss_close_cloud" : "hs_close")} — Esc`}
        aria-label={t(cloud ? "ss_close_cloud" : "hs_close")}
      >
        ✕
      </button>
      <div className="tq-panel">
        <div className="tq-head">
          <span className="tq-title">{t("ss_title")}</span>
          {rules && (
            <span className="tq-count">
              {t("tb_step").replace("{n}", String(step + 1)).replace("{total}", String(total))}
            </span>
          )}
        </div>
        <div className="tq-bar">
          <div className="tq-bar-fill" style={{ width: `${progress}%` }} />
        </div>

        {!rules || !card ? (
          <div className="tq-card tq-card--quiet" key="wait" role="status">
            <span className="tq-reading" aria-hidden="true" />
            <p className="tq-question">{t("ss_reading")}</p>
          </div>
        ) : (
          <div className="tq-card" key={card.source}>
            <p className="tq-why tq-why--lead ss-source">
              {t("ss_source")} <q>{card.source}</q>
            </p>
            {card.terms && card.kind !== "dialogue" && (
              <div className="tq-term">{card.terms.join(" · ")}</div>
            )}
            <p className="tq-question">{question(card)}</p>
            {body(card)}
            <div className="tq-options" role="radiogroup">
              {[true, false].map((yes, i) => (
                <button
                  key={String(yes)}
                  type="button"
                  role="radio"
                  aria-checked={accepted === yes}
                  className={`tq-option${accepted === yes ? " is-selected" : ""}`}
                  disabled={yes && !canAccept}
                  onClick={() => choose(yes)}
                >
                  <kbd>{i + 1}</kbd>
                  <span className="tq-option-label">{t(yes ? "ss_rule" : "ss_note")}</span>
                </button>
              ))}
            </div>
            <p className="tq-why">{t(accepted ? "ss_rule_why" : "ss_note_why")}</p>
          </div>
        )}

        <div className="tq-foot">
          <button type="button" className="tq-back" onClick={back} disabled={step === 0 || !rules}>
            ←
          </button>
          <button type="button" className="tq-next" onClick={forward} disabled={!rules} autoFocus>
            {onLast ? t(cloud ? "ss_start_cloud" : "ss_start") : t("tb_next")}
          </button>
        </div>
        <p className="tq-keys">
          <kbd>1</kbd>–<kbd>2</kbd> {t("tb_keys_choose")} · <kbd>Enter</kbd> {t("tb_keys_next")} ·{" "}
          <kbd>←</kbd> {t("tb_keys_back")}
        </p>
      </div>
    </div>,
    document.body,
  );
}
