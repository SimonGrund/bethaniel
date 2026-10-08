// ── Before Betty translates ──
//
// Shown once a paid translation's credential has been claimed and before the
// job is submitted. Betty reads the book (translationBrief.ts on the backend)
// and asks a few questions in the author's interface language; the app adds
// its own tone question. The answers become the translation brief.
//
// Drawn like the review deck in focus (ReviewFocus): the room goes dark and
// one card at a time is the only light thing in it, answered from the
// keyboard — 1–4 picks, Enter goes on, ← goes back. The tone question needs
// no model, so it comes first and is answered while Betty is still reading;
// by the time the author has chosen, her questions are usually there.
//
// It cannot be dismissed: the run is paid for. Skip starts it on Betty's
// suggestions, and if her questions could not be prepared the tone question
// alone is enough to go on.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n";
import { getTranslationQuestions } from "../api";
import { useStore } from "../store";
import type { Lang } from "../types";
import {
  defaultAnswers,
  renderTranslationBrief,
  type BriefAnswer,
  type BriefQuestion,
  type Tone,
} from "../translationBrief";

const TONES: Tone[] = ["match", "softer", "stricter"];

/** One questions call per pending run, even when React mounts this twice
 *  (StrictMode) — each call is paid for. */
let asking = false;

/** One option on a card: the tone's, or one of Betty's, or "Other…". */
interface Choice {
  key: string;
  label: string;
  suggested?: boolean;
}

export default function TranslationQuestions({
  lang,
  units,
  targetLang,
  manuscriptLang,
  onSubmit,
}: {
  lang: Lang;
  units: string[];
  targetLang: string;
  manuscriptLang: string;
  onSubmit: (brief: string) => Promise<void>;
}) {
  const t = useTranslation(lang);
  const pending = useStore((s) => s.pendingTranslationBrief);
  const setPending = useStore((s) => s.setPendingTranslationBrief);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const otherRef = useRef<HTMLInputElement>(null);

  const needsQuestions = pending !== null && pending.questions === null;
  useEffect(() => {
    if (!needsQuestions || asking) return;
    asking = true;
    void getTranslationQuestions({ units, targetLang, manuscriptLang, uiLang: lang })
      .then((r) => {
        const cur = useStore.getState().pendingTranslationBrief;
        if (!cur) return;
        setPending({
          ...cur,
          questions: r.questions,
          answers: defaultAnswers(r.questions),
          degraded: r.degraded,
        });
      })
      .finally(() => {
        asking = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsQuestions]);

  const questions: BriefQuestion[] | null = pending?.questions ?? null;
  // Step 0 is the tone; 1..n are Betty's questions. While she is still
  // reading, there is one more step: the wait.
  const total = 1 + (questions?.length ?? 0);
  const onLast = questions !== null && step === total - 1;
  const waiting = questions === null && step >= 1;
  const done = questions !== null && step >= total; // only when there are none
  const q = questions && step >= 1 ? questions[step - 1] : undefined;

  const answer: BriefAnswer | undefined = q
    ? (pending?.answers[q.id] ?? { optionId: q.suggested })
    : undefined;
  const ownAnswer = answer?.other !== undefined;

  const choices: Choice[] = waiting || done
    ? []
    : q
    ? [
        ...q.options.map((o) => ({ key: o.id, label: o.label, suggested: o.id === q.suggested })),
        { key: "__other", label: t("tb_other") },
      ]
    : TONES.map((tone) => ({ key: tone, label: t(`tb_tone_${tone}`) }));

  const selectedKey = q ? (ownAnswer ? "__other" : answer?.optionId) : pending?.tone;

  const choose = (key: string) => {
    if (!pending) return;
    if (!q) {
      setPending({ ...pending, tone: key as Tone });
      return;
    }
    const next: BriefAnswer = key === "__other" ? { other: answer?.other ?? "" } : { optionId: key };
    setPending({ ...pending, answers: { ...pending.answers, [q.id]: next } });
    if (key === "__other") setTimeout(() => otherRef.current?.focus(), 0);
  };

  const submit = async (useSuggestions: boolean) => {
    if (!pending || submitting) return;
    const qs = questions ?? [];
    const brief = useSuggestions
      ? renderTranslationBrief("match", qs, defaultAnswers(qs))
      : renderTranslationBrief(pending.tone, qs, pending.answers);
    setSubmitting(true);
    try {
      // EditTrigger clears the pending brief once the job is accepted; on a
      // failure it stays, answers and all, for another go.
      await onSubmit(brief);
    } finally {
      setSubmitting(false);
    }
  };

  const forward = () => {
    if (onLast || done) void submit(false);
    else if (!waiting) setStep((s) => s + 1);
  };
  const back = () => setStep((s) => Math.max(0, s - 1));

  // The keys, read through a ref so the listener mounts once.
  const keysRef = useRef({ forward, back, choose, choices });
  keysRef.current = { forward, back, choose, choices };
  const open = pending !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement;
      const k = keysRef.current;
      if (e.key === "Enter") {
        e.preventDefault();
        k.forward();
      } else if (typing) {
        return;
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        k.back();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        k.forward();
      } else if (/^[1-9]$/.test(e.key)) {
        const c = k.choices[Number(e.key) - 1];
        if (c) {
          e.preventDefault();
          k.choose(c.key);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!pending) return null;

  const progress = waiting || done ? 100 : Math.round(((step + 1) / (total + (questions ? 0 : 1))) * 100);

  return createPortal(
    <div className="tq" role="dialog" aria-modal="true" aria-label={t("tb_title")}>
      <div className="tq-panel">
        <div className="tq-head">
          <span className="tq-title">{t("tb_title")}</span>
          {questions !== null && !done && (
            <span className="tq-count">
              {t("tb_step").replace("{n}", String(step + 1)).replace("{total}", String(total))}
            </span>
          )}
        </div>
        <div className="tq-bar">
          <div className="tq-bar-fill" style={{ width: `${progress}%` }} />
        </div>

        {waiting || done ? (
          <div className="tq-card tq-card--quiet" key="wait" role="status">
            {waiting ? (
              <>
                <span className="tq-reading" aria-hidden="true" />
                <p className="tq-question">{t("tb_reading")}</p>
              </>
            ) : (
              <p className="tq-question">
                {t(pending.degraded ? "tb_degraded" : "tb_ready")}
              </p>
            )}
          </div>
        ) : (
          <div className="tq-card" key={q ? q.id : "tone"}>
            {q?.term && <div className="tq-term">{q.term}</div>}
            <p className="tq-question">{q ? q.question : t("tb_tone_q")}</p>
            <div className="tq-options" role="radiogroup">
              {choices.map((c, i) => (
                <button
                  key={c.key}
                  type="button"
                  role="radio"
                  aria-checked={selectedKey === c.key}
                  className={`tq-option${selectedKey === c.key ? " is-selected" : ""}`}
                  onClick={() => choose(c.key)}
                >
                  <kbd>{i + 1}</kbd>
                  <span className="tq-option-label">{c.label}</span>
                  {c.suggested && <span className="tq-suggested">{t("tb_suggested")}</span>}
                </button>
              ))}
            </div>
            {q && ownAnswer && (
              <input
                ref={otherRef}
                type="text"
                className="tq-other"
                value={answer?.other ?? ""}
                maxLength={200}
                placeholder={t("tb_other_placeholder")}
                onChange={(e) =>
                  setPending({
                    ...pending,
                    answers: { ...pending.answers, [q.id]: { other: e.target.value } },
                  })
                }
              />
            )}
            {q?.why && <p className="tq-why">{q.why}</p>}
            {!q && <p className="tq-why">{t("tb_intro")}</p>}
          </div>
        )}

        <div className="tq-foot">
          <button type="button" className="tq-back" onClick={back} disabled={step === 0}>
            ←
          </button>
          <button
            type="button"
            className="tq-next"
            onClick={forward}
            disabled={waiting || submitting}
          >
            {onLast || done ? t("tb_start") : t("tb_next")}
          </button>
        </div>
        <p className="tq-keys">
          {choices.length > 0 && (
            <>
              <kbd>1</kbd>–<kbd>{choices.length}</kbd> {t("tb_keys_choose")} ·{" "}
            </>
          )}
          <kbd>Enter</kbd> {t("tb_keys_next")} · <kbd>←</kbd> {t("tb_keys_back")}
          <span className="tq-sep">·</span>
          <button
            type="button"
            className="tq-skip"
            onClick={() => void submit(true)}
            disabled={submitting}
          >
            {t("tb_skip")}
          </button>
        </p>
      </div>
    </div>,
    document.body,
  );
}
