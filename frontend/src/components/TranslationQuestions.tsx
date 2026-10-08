// ── Before Betty translates ──
//
// Shown once a paid translation's credential has been claimed and before the
// job is submitted. Betty reads the book (translationBrief.ts on the backend)
// and asks a few questions in the author's interface language; the app adds
// its own tone question. The answers become the translation brief.
//
// It cannot be dismissed: the run is paid for. Both buttons start it — Skip
// simply takes Betty's suggestions — and if her questions could not be
// prepared, the tone question alone is enough to go on.

import { useEffect, useState } from "react";
import Modal from "./Modal";
import { useTranslation } from "../i18n";
import { getTranslationQuestions } from "../api";
import { useStore } from "../store";
import type { Lang } from "../types";
import {
  defaultAnswers,
  renderTranslationBrief,
  type BriefAnswer,
  type Tone,
} from "../translationBrief";

const TONES: Tone[] = ["match", "softer", "stricter"];

/** One questions call per pending run, even when React mounts this twice
 *  (StrictMode) — each call is paid for. */
let asking = false;

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
  const [submitting, setSubmitting] = useState(false);

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

  if (!pending) return null;
  const questions = pending.questions;

  const setTone = (tone: Tone) => setPending({ ...pending, tone });
  const setAnswer = (id: string, a: BriefAnswer) =>
    setPending({ ...pending, answers: { ...pending.answers, [id]: a } });

  const submit = async (useSuggestions: boolean) => {
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

  return (
    <Modal open labelledBy="tbTitle" className="cloud-buy translation-brief">
      <h2 id="tbTitle" className="cloud-buy__title">
        {t("tb_title")}
      </h2>
      {questions === null ? (
        <p className="cloud-buy__note" role="status">
          {t("tb_reading")}
        </p>
      ) : (
        <>
          <p className="cloud-buy__note">{t("tb_intro")}</p>
          {pending.degraded && (
            <p className="cloud-buy__note cloud-buy__note--quiet">{t("tb_degraded")}</p>
          )}

          <fieldset className="translation-brief__q">
            <legend>{t("tb_tone_q")}</legend>
            {TONES.map((tone) => (
              <label key={tone} className="translation-brief__opt">
                <input
                  type="radio"
                  name="tb-tone"
                  checked={pending.tone === tone}
                  onChange={() => setTone(tone)}
                />
                <span>{t(`tb_tone_${tone}`)}</span>
              </label>
            ))}
          </fieldset>

          {questions.map((q) => {
            const a = pending.answers[q.id] ?? { optionId: q.suggested };
            const ownAnswer = a.other !== undefined;
            return (
              <fieldset key={q.id} className="translation-brief__q">
                <legend>
                  {q.term && <span className="translation-brief__term">{q.term}</span>}
                  {q.question}
                </legend>
                {q.options.map((o) => (
                  <label key={o.id} className="translation-brief__opt">
                    <input
                      type="radio"
                      name={`tb-${q.id}`}
                      checked={!ownAnswer && a.optionId === o.id}
                      onChange={() => setAnswer(q.id, { optionId: o.id })}
                    />
                    <span>
                      {o.label}
                      {o.id === q.suggested && (
                        <em className="translation-brief__suggested"> · {t("tb_suggested")}</em>
                      )}
                    </span>
                  </label>
                ))}
                <label className="translation-brief__opt">
                  <input
                    type="radio"
                    name={`tb-${q.id}`}
                    checked={ownAnswer}
                    onChange={() => setAnswer(q.id, { other: "" })}
                  />
                  <span>{t("tb_other")}</span>
                </label>
                {ownAnswer && (
                  <input
                    type="text"
                    className="translation-brief__other"
                    value={a.other}
                    maxLength={200}
                    placeholder={t("tb_other_placeholder")}
                    onChange={(e) => setAnswer(q.id, { other: e.target.value })}
                    autoFocus
                  />
                )}
                {q.why && <p className="translation-brief__why">{q.why}</p>}
              </fieldset>
            );
          })}

          <div className="cloud-buy__actions">
            <button
              type="button"
              className="btn-secondary"
              disabled={submitting}
              onClick={() => void submit(true)}
            >
              {t("tb_skip")}
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={submitting}
              onClick={() => void submit(false)}
            >
              {t("tb_start")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
