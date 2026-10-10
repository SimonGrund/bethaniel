// ── Before Betty edits ──
//
// Shown after Run (or Run in Cloud, before the checkout) for a copy edit,
// line edit or Final readthrough. It is where the author's style guide is
// set up, start to finish — the manuscript card no longer carries a link to
// it:
//
//   1. Names & terms: what Betty read off the manuscript and will leave
//      alone (LexiconPanel). Skim, untick or add, and go on.
//   2. Where the manuscript disagrees with itself, and the settings its
//      detection could not decide (backend/src/houseStyle.ts and the upload's
//      detection). Counted, no model: free and instant.
//   3. The author's own instructions: the style guide as free text (or an
//      uploaded sheet), with the lines the answers make shown above it.
//
// The same dark one-card room as the translation questions
// (TranslationQuestions, the `tq` styles), answered from the keyboard: 1–n
// picks, Enter goes on, ← goes back, Escape closes and starts nothing — no
// payment has been made, so closing needs no warning.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n";
import { uploadStyleGuide } from "../api";
import { useStore } from "../store";
import type { CopyEditOptions, Lang } from "../types";
import {
  applyEditAnswers,
  editQuestionOptions,
  type EditQuestion,
  type RuleText,
} from "../houseStyleAnswers";
import LexiconPanel from "./LexiconPanel";

export interface EditAnswers {
  options: Partial<CopyEditOptions>;
  /** Lines from the answers, as the author left them. */
  lines: string[];
  /** The author's own instructions: the style guide's free text. */
  guide: string;
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
  names,
  questions,
  guide,
  copyEditOptions,
  cloud,
  onFinish,
  onSkip,
  onClose,
}: {
  lang: Lang;
  /** Open on the names & terms card: the manuscript has a harvested list. */
  names: boolean;
  questions: EditQuestion[];
  /** The style guide as it stands. */
  guide: string;
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
  const markLexiconReviewed = useStore((s) => s.markLexiconReviewed);

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((q) => [q.id, initialAnswer(q, copyEditOptions)])),
  );
  // The lines are written from the answers until the author edits them;
  // changing an answer afterwards writes them afresh.
  const [lines, setLines] = useState<string | null>(null);
  const [own, setOwn] = useState(guide);
  const [reading, setReading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Cards: [names] questions… instructions.
  const first = names ? 1 : 0;
  const total = first + questions.length + 1;
  const onNames = names && step === 0;
  const onLast = step === total - 1;
  const q = !onNames && !onLast ? questions[step - first] : undefined;

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

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setUploadError(null);
    try {
      const text = (await uploadStyleGuide(file)).trim();
      setOwn((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${text}` : text));
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const finish = () =>
    onFinish({
      options: derived.options,
      lines: linesText.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean),
      guide: own,
      settled: questions.filter((x) => x.kind === "setting").map((x) => x.id),
    });

  const forward = () => {
    // Going on from the list is accepting it.
    if (onNames) markLexiconReviewed();
    if (onLast) finish();
    else setStep((s) => s + 1);
  };
  const back = () => setStep((s) => Math.max(0, s - 1));

  const keysRef = useRef({ forward, back, choose, choices, onClose });
  keysRef.current = { forward, back, choose, choices, onClose };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inText = e.target instanceof HTMLTextAreaElement;
      const typing = inText || e.target instanceof HTMLInputElement;
      const k = keysRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        k.onClose();
        return;
      }
      // In a text field, Enter is its own (a new line, adding a term);
      // ⌘/Ctrl+Enter goes on.
      if (e.key === "Enter" && typing && !(e.metaKey || e.ctrlKey)) return;
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
  const rows = (text: string, min: number) => Math.max(min, text.split("\n").length + 1);

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
      <div className={`tq-panel${onNames ? " tq-panel--wide" : ""}`}>
        <div className="tq-head">
          <span className="tq-title">{t("hs_title")}</span>
          <span className="tq-count">
            {t("tb_step").replace("{n}", String(step + 1)).replace("{total}", String(total))}
          </span>
        </div>
        <div className="tq-bar">
          <div className="tq-bar-fill" style={{ width: `${progress}%` }} />
        </div>

        {onNames ? (
          <div className="tq-card" key="names">
            <p className="tq-question">{t("hs_names_q")}</p>
            <p className="tq-why tq-why--lead">{t("hs_names_intro")}</p>
            <LexiconPanel bare />
          </div>
        ) : q ? (
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
          <div className="tq-card" key="instructions">
            {derived.lines.length > 0 && (
              <>
                <p className="tq-question">{t("hs_lines_q")}</p>
                <p className="tq-why tq-why--lead">{t("hs_lines_intro")}</p>
                <textarea
                  className="tq-list tq-list--short"
                  value={linesText}
                  rows={rows(linesText, 3)}
                  aria-label={t("hs_lines_q")}
                  onChange={(e) => setLines(e.target.value)}
                />
              </>
            )}
            <p className="tq-question">{t("hs_own_q")}</p>
            <p className="tq-why tq-why--lead">{t("hs_own_intro")}</p>
            <textarea
              className="tq-list"
              value={own}
              rows={rows(own, 6)}
              maxLength={200_000}
              placeholder={t("style_guide_tip")}
              aria-label={t("hs_own_q")}
              onChange={(e) => setOwn(e.target.value)}
              autoFocus={derived.lines.length === 0}
            />
            <div className="tq-list-tools">
              <button
                type="button"
                className="tq-add"
                disabled={reading}
                onClick={() => fileRef.current?.click()}
              >
                {reading ? t("tb_list_reading") : `↑ ${t("hs_own_upload")}`}
              </button>
              <span className="tq-list-formats">.docx · .md · .txt</span>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept=".md,.txt,.docx"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
            </div>
            {uploadError && <p className="tq-why tq-error">{uploadError}</p>}
          </div>
        )}

        <div className="tq-foot">
          <button type="button" className="tq-back" onClick={back} disabled={step === 0}>
            ←
          </button>
          <button type="button" className="tq-next" onClick={forward} autoFocus>
            {onLast
              ? t(cloud ? "hs_start_cloud" : "hs_start")
              : onNames
                ? t("hs_names_ok")
                : t("tb_next")}
          </button>
        </div>
        <p className="tq-keys">
          {choices.length > 0 && (
            <>
              <kbd>1</kbd>–<kbd>{choices.length}</kbd> {t("tb_keys_choose")} ·{" "}
            </>
          )}
          {onLast ? (
            <>
              <kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> {t("tb_keys_next")}
            </>
          ) : (
            <>
              <kbd>Enter</kbd> {t("tb_keys_next")} · <kbd>←</kbd> {t("tb_keys_back")}
            </>
          )}
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
