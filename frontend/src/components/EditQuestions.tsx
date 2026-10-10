// ── Before Betty edits ──
//
// Shown after Run (or Run in Cloud, before the checkout) for a copy edit,
// line edit or Final readthrough, when the manuscript disagrees with itself
// or its detection could not decide a setting. No model is involved: the
// questions are counted from the text (backend/src/houseStyle.ts) and from
// the upload's own detection, so this costs nothing and takes no time.
//
// The same dark one-card room as the translation questions
// (TranslationQuestions, the `tq` styles), answered from the keyboard: 1–n
// picks, Enter goes on, ← goes back, Escape closes and starts nothing — no
// payment has been made, so closing needs no warning. The last card shows
// the style-guide lines the answers make, editable, and starts the run.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n";
import type { Lang } from "../types";
import {
  applyEditAnswers,
  editQuestionOptions,
  type EditQuestion,
  type RuleText,
} from "../houseStyleAnswers";
import type { CopyEditOptions } from "../types";

export interface EditAnswers {
  options: Partial<CopyEditOptions>;
  /** Style-guide lines, as the author left them on the last card. */
  lines: string[];
  /** The setting questions answered, to not ask them again. */
  settled: string[];
}

/** The answer pre-selected: the current setting, or the form the book uses most. */
function initialAnswer(q: EditQuestion, opts: CopyEditOptions): string {
  if (q.kind !== "setting") return q.forms[0]?.form ?? "mixed";
  if (q.setting === "dialect") return opts.englishDialect;
  if (q.setting === "oxfordComma") return opts.oxfordComma ? "yes" : "no";
  if (q.setting === "danishComma") return opts.danishComma;
  return opts.quoteStyle;
}

export default function EditQuestions({
  lang,
  questions,
  copyEditOptions,
  cloud,
  onFinish,
  onSkip,
  onClose,
}: {
  lang: Lang;
  questions: EditQuestion[];
  copyEditOptions: CopyEditOptions;
  /** A cloud run goes on to the checkout, not straight into the queue. */
  cloud: boolean;
  onFinish: (answers: EditAnswers) => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const t = useTranslation(lang);
  const rule: RuleText = (key, params = {}) =>
    t(key).replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? "");

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, initialAnswer(q, copyEditOptions)])),
  );
  // The lines are written when the author reaches the last card, then theirs
  // to edit; going back and changing an answer writes them afresh.
  const [lines, setLines] = useState<string | null>(null);

  const total = questions.length + 1;
  const onLast = step === questions.length;
  const q = onLast ? undefined : questions[step];

  const derived = useMemo(
    () => applyEditAnswers(questions, answers, rule),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [questions, answers, lang],
  );
  const linesText = lines ?? derived.lines.join("\n");

  const label = (q: EditQuestion, key: string): string => {
    if (key === "mixed") return t("hs_mixed");
    if (q.kind === "setting") return t(`hs_opt_${q.setting}_${key}`);
    if (q.kind === "numbers") return t(`hs_opt_numbers_${key}`);
    if (q.kind === "dashes") return t(`hs_opt_dash_${key.replace(/-/g, "_")}`);
    return key;
  };
  const count = (q: EditQuestion, key: string): number | undefined =>
    q.kind === "setting" ? undefined : q.forms.find((f) => f.form === key)?.count;

  const choices = q ? editQuestionOptions(q) : [];

  const choose = (key: string) => {
    if (!q) return;
    setAnswers((a) => ({ ...a, [q.id]: key }));
    setLines(null);
  };

  const finish = () =>
    onFinish({
      options: derived.options,
      lines: linesText.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean),
      settled: questions.filter((x) => x.kind === "setting").map((x) => x.id),
    });

  const forward = () => (onLast ? finish() : setStep((s) => s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const keysRef = useRef({ forward, back, choose, choices, onClose });
  keysRef.current = { forward, back, choose, choices, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inText = e.target instanceof HTMLTextAreaElement;
      const k = keysRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        k.onClose();
        return;
      }
      // In the lines, Enter is a new line; ⌘/Ctrl+Enter starts.
      if (e.key === "Enter" && inText && !(e.metaKey || e.ctrlKey)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        k.forward();
      } else if (inText) {
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
          k.choose(c);
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
  }, []);

  const progress = Math.round(((step + 1) / total) * 100);
  const lineCount = linesText.split("\n").filter((l) => l.trim()).length;

  return createPortal(
    <div className="tq" role="dialog" aria-modal="true" aria-label={t("hs_title")}>
      <button
        type="button"
        className="tq-close"
        onClick={onClose}
        title={`${t("hs_close")} — Esc`}
        aria-label={t("hs_close")}
      >
        ✕
      </button>
      <div className="tq-panel">
        <div className="tq-head">
          <span className="tq-title">{t("hs_title")}</span>
          <span className="tq-count">
            {t("tb_step").replace("{n}", String(step + 1)).replace("{total}", String(total))}
          </span>
        </div>
        <div className="tq-bar">
          <div className="tq-bar-fill" style={{ width: `${progress}%` }} />
        </div>

        {q ? (
          <div className="tq-card" key={q.id}>
            {(q.kind === "spelling" || q.kind === "compound") && (
              <div className="tq-term">{q.forms.map((f) => f.form).join(" / ")}</div>
            )}
            <p className="tq-question">{t(`hs_q_${q.kind === "setting" ? q.setting : q.kind}`)}</p>
            <div className="tq-options" role="radiogroup">
              {choices.map((c, i) => {
                const n = count(q, c);
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={answers[q.id] === c}
                    className={`tq-option${answers[q.id] === c ? " is-selected" : ""}`}
                    onClick={() => choose(c)}
                  >
                    <kbd>{i + 1}</kbd>
                    <span className="tq-option-label">{label(q, c)}</span>
                    {n !== undefined && (
                      <span className="tq-suggested">{t("hs_count").replace("{n}", String(n))}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="tq-why">{t(q.kind === "setting" ? "hs_why_setting" : "hs_why_mixed")}</p>
          </div>
        ) : (
          <div className="tq-card" key="lines">
            <p className="tq-question">{t("hs_lines_q")}</p>
            <p className="tq-why tq-why--lead">
              {t(derived.lines.length > 0 ? "hs_lines_intro" : "hs_lines_none")}
            </p>
            {derived.lines.length > 0 && (
              <textarea
                className="tq-list"
                value={linesText}
                rows={Math.max(3, lineCount + 1)}
                aria-label={t("hs_lines_q")}
                onChange={(e) => setLines(e.target.value)}
              />
            )}
          </div>
        )}

        <div className="tq-foot">
          <button type="button" className="tq-back" onClick={back} disabled={step === 0}>
            ←
          </button>
          <button type="button" className="tq-next" onClick={forward} autoFocus>
            {onLast ? t(cloud ? "hs_start_cloud" : "hs_start") : t("tb_next")}
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
          <button type="button" className="tq-skip" onClick={onSkip}>
            {t("hs_skip")}
          </button>
        </p>
      </div>
    </div>,
    document.body,
  );
}
