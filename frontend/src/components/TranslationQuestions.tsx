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
// It opens on the author's own term list — pasted, uploaded, or none — so
// Betty reads it with the book: what it settles she never asks about, what
// it leaves out she fills in and asks about. Her call starts when that card
// is done, and the tone card covers the wait.
//
// Then the glossary: every term Betty found, with her rendering in an
// editable field, always shown — a professional text has dozens of terms and
// five questions cover five. It is saved per language pair when the run
// starts, so the next book begins with these decided. Then her questions,
// for the few real dilemmas.
//
// The run is paid for, so closing is never one click: the ✕ (or Escape)
// first says plainly that the payment is spent without a translation, with
// "keep going" as the default. Skip starts the run on Betty's suggestions,
// and if her questions could not be prepared the tone question alone is
// enough to go on.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../i18n";
import { extractTermList, getTranslationQuestions, saveTranslationGlossary } from "../api";
import { useStore } from "../store";
import type { Lang } from "../types";
import {
  answeredTermsToSave,
  defaultAnswers,
  glossaryToSave,
  renderTranslationBrief,
  type BriefAnswer,
  type BriefQuestion,
  type GlossaryRow,
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
  styleGuide,
  onSubmit,
}: {
  lang: Lang;
  units: string[];
  targetLang: string;
  manuscriptLang: string;
  /** The author's style sheet: a glossary in it counts as decided. */
  styleGuide?: string;
  onSubmit: (brief: string) => Promise<void>;
}) {
  const t = useTranslation(lang);
  const pending = useStore((s) => s.pendingTranslationBrief);
  const setPending = useStore((s) => s.setPendingTranslationBrief);
  // A run saved before the list card existed already has its questions.
  const listDone = pending?.listDone ?? pending?.questions != null;
  // The card lives in the store with the answers (see `step` on
  // PendingTranslationBrief): a submission unmounts this component, and a
  // failed one used to bring the author back on the tone card.
  const step = pending?.step ?? (listDone ? 1 : 0);
  const setStep = (next: number | ((s: number) => number)) => {
    const cur = useStore.getState().pendingTranslationBrief;
    if (!cur) return;
    const now = cur.step ?? ((cur.listDone ?? cur.questions != null) ? 1 : 0);
    setPending({ ...cur, step: typeof next === "function" ? next(now) : next });
  };
  const [submitting, setSubmitting] = useState(false);
  const [reading, setReading] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const needsQuestions = pending !== null && listDone && pending.questions === null;
  useEffect(() => {
    if (!needsQuestions || asking) return;
    asking = true;
    const cur0 = useStore.getState().pendingTranslationBrief;
    void getTranslationQuestions({
      units,
      targetLang,
      manuscriptLang,
      uiLang: lang,
      termList: cur0?.termList ?? "",
      styleGuide: styleGuide ?? "",
    })
      .then((r) => {
        const cur = useStore.getState().pendingTranslationBrief;
        if (!cur) return;
        setPending({
          ...cur,
          questions: r.questions,
          answers: defaultAnswers(r.questions),
          glossary: r.glossary,
          authorNotes: r.authorNotes,
          listRows: r.listRows,
          degraded: r.degraded,
        });
      })
      .finally(() => {
        asking = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsQuestions]);

  const questions: BriefQuestion[] | null = pending?.questions ?? null;
  const glossary: GlossaryRow[] = pending?.glossary ?? [];
  // Step 0 is the author's list, 1 the tone, 2 the glossary, 3.. Betty's
  // questions. While she is still reading, every step after the tone is the
  // wait.
  const total = 3 + (questions?.length ?? 0);
  const onList = step === 0;
  const onLast = questions !== null && step === total - 1;
  const waiting = questions === null && step >= 2;
  const done = questions !== null && step >= total;
  const onTable = questions !== null && step === 2;
  const q = questions && step >= 3 ? questions[step - 3] : undefined;
  const listText = pending?.termList ?? "";

  const answer: BriefAnswer | undefined = q
    ? (pending?.answers[q.id] ?? { optionId: q.suggested })
    : undefined;
  const ownAnswer = answer?.other !== undefined;

  const choices: Choice[] = waiting || done || onTable || onList
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

  const setRow = (i: number, row: GlossaryRow) => {
    if (!pending) return;
    const rows = [...glossary];
    rows[i] = row;
    setPending({ ...pending, glossary: rows });
  };
  const addRow = () => {
    if (!pending) return;
    setPending({ ...pending, glossary: [...glossary, { term: "", rendering: "", keep: false, added: true }] });
    setTimeout(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>(".tq-cell-term");
      inputs[inputs.length - 1]?.focus();
    }, 0);
  };

  const onFile = async (file: File | undefined) => {
    if (!file || !pending) return;
    setReading(true);
    setListError(null);
    try {
      const text = (await extractTermList(file, manuscriptLang, targetLang)).trim();
      const cur = useStore.getState().pendingTranslationBrief;
      if (cur) {
        const before = (cur.termList ?? "").trim();
        setPending({ ...cur, termList: before ? `${before}\n${text}` : text });
      }
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const submit = async (useSuggestions: boolean) => {
    if (!pending || submitting) return;
    const qs = questions ?? [];
    // Before Betty has read the list, the list itself is the notes.
    const notes = pending.authorNotes ?? pending.termList ?? "";
    const brief = useSuggestions
      ? renderTranslationBrief("match", qs, defaultAnswers(qs), glossary, notes)
      : renderTranslationBrief(pending.tone, qs, pending.answers, glossary, notes);
    // Only a table the author went through is theirs to keep; Skip takes
    // Betty's for this run and leaves the saved glossary as it was.
    if (!useSuggestions) {
      void saveTranslationGlossary({
        sourceLang: manuscriptLang,
        targetLang,
        // The table first, so the author's edits win; then their answers;
        // then the rest of their list, terms this book lacks included.
        rows: [
          ...glossaryToSave(glossary),
          ...answeredTermsToSave(qs, pending.answers),
          ...(pending.listRows ?? []),
        ],
      });
    }
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
    if (onList) {
      // Betty starts reading now, list in hand; the tone card covers it.
      if (pending && !listDone) setPending({ ...pending, listDone: true });
      setStep(1);
    } else if (onLast || done) void submit(false);
    else if (!waiting) setStep((s) => s + 1);
  };
  // Once Betty has the list, it is not changed under her.
  const back = () => setStep((s) => Math.max(listDone ? 1 : 0, s - 1));

  // Closing gives up a run that is already paid for. Nothing else to undo:
  // the model only switches to the cloud when the job is submitted.
  const closeForGood = () => {
    setConfirmClose(false);
    setPending(null);
  };

  // The keys, read through a ref so the listener mounts once.
  const keysRef = useRef({ forward, back, choose, choices, confirmClose, setConfirmClose });
  keysRef.current = { forward, back, choose, choices, confirmClose, setConfirmClose };
  const open = pending !== null;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const inText = e.target instanceof HTMLTextAreaElement;
      const typing = e.target instanceof HTMLInputElement || inText;
      const k = keysRef.current;
      // The close question owns the keys while it is up: Escape and Enter
      // both mean "keep going", the default.
      if (k.confirmClose) {
        if (e.key === "Escape" || e.key === "Enter") {
          e.preventDefault();
          k.setConfirmClose(false);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        k.setConfirmClose(true);
        return;
      }
      // In the list, Enter is a new line; ⌘/Ctrl+Enter goes on.
      if (e.key === "Enter" && inText && !(e.metaKey || e.ctrlKey)) return;
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
      <button
        type="button"
        className="tq-close"
        onClick={() => setConfirmClose(true)}
        title={`${t("tb_close")} — Esc`}
        aria-label={t("tb_close")}
      >
        ✕
      </button>
      {confirmClose ? (
        <div className="tq-panel">
          <div className="tq-card tq-card--warn" role="alertdialog" aria-labelledby="tqCloseQ" aria-describedby="tqCloseBody">
            <p className="tq-question" id="tqCloseQ">{t("tb_close_q")}</p>
            <p className="tq-why tq-why--lead" id="tqCloseBody">{t("tb_close_body")}</p>
          </div>
          <div className="tq-foot">
            <button type="button" className="tq-danger" onClick={closeForGood}>
              {t("tb_close_confirm")}
            </button>
            <button type="button" className="tq-next" onClick={() => setConfirmClose(false)} autoFocus>
              {t("tb_close_keep")}
            </button>
          </div>
        </div>
      ) : (
      <div className={`tq-panel${onTable ? " tq-panel--wide" : ""}`}>
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

        {onList ? (
          <div className="tq-card" key="list">
            <p className="tq-question">{t("tb_list_q")}</p>
            <p className="tq-why tq-why--lead">{t("tb_list_intro")}</p>
            <textarea
              className="tq-list"
              value={listText}
              rows={7}
              maxLength={200_000}
              placeholder={t("tb_list_placeholder")}
              aria-label={t("tb_list_q")}
              onChange={(e) => setPending({ ...pending, termList: e.target.value })}
              autoFocus
            />
            <div className="tq-list-tools">
              <button
                type="button"
                className="tq-add"
                disabled={reading}
                onClick={() => fileRef.current?.click()}
              >
                {reading ? t("tb_list_reading") : `↑ ${t("tb_list_upload")}`}
              </button>
              <span className="tq-list-formats">{t("tb_list_formats")}</span>
              <input
                ref={fileRef}
                type="file"
                hidden
                accept=".csv,.tsv,.txt,.md,.xlsx,.docx,.tbx,.xml"
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
            </div>
            {listError && <p className="tq-why tq-error">{listError}</p>}
          </div>
        ) : waiting || done ? (
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
        ) : onTable ? (
          <div className="tq-card" key="glossary">
            <p className="tq-question">{t("tb_glossary_q")}</p>
            <p className="tq-why tq-why--lead">
              {t(glossary.length > 0 ? "tb_glossary_intro" : "tb_glossary_empty")}
            </p>
            {glossary.length > 0 && (
              <div className="tq-table" role="table" aria-label={t("tb_glossary_q")}>
                <div className="tq-row tq-row--head" role="row">
                  <span role="columnheader">{t("tb_glossary_term")}</span>
                  <span role="columnheader">{t("tb_glossary_rendering")}</span>
                  <span role="columnheader" />
                </div>
                {glossary.map((r, i) => (
                  <div className={`tq-row${r.keep ? " is-kept" : ""}`} role="row" key={i}>
                    {r.added ? (
                      <input
                        type="text"
                        className="tq-cell-input tq-cell-term"
                        value={r.term}
                        maxLength={200}
                        placeholder={t("tb_glossary_new_term")}
                        aria-label={t("tb_glossary_term")}
                        onChange={(e) => setRow(i, { ...r, term: e.target.value })}
                      />
                    ) : (
                      <span className="tq-term-cell" role="cell">
                        {r.term}
                        {r.author ? (
                          <span className="tq-saved tq-saved--yours">{t("tb_glossary_yours")}</span>
                        ) : (
                          r.saved && <span className="tq-saved">{t("tb_glossary_saved")}</span>
                        )}
                      </span>
                    )}
                    <input
                      type="text"
                      className="tq-cell-input"
                      value={r.keep ? r.term : r.rendering}
                      disabled={r.keep}
                      maxLength={200}
                      aria-label={`${t("tb_glossary_rendering")}: ${r.term}`}
                      onChange={(e) => setRow(i, { ...r, rendering: e.target.value })}
                    />
                    <button
                      type="button"
                      className={`tq-keep${r.keep ? " is-on" : ""}`}
                      aria-pressed={r.keep}
                      onClick={() => setRow(i, { ...r, keep: !r.keep })}
                    >
                      {t("tb_glossary_keep")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="tq-add" onClick={addRow}>
              + {t("tb_glossary_add")}
            </button>
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
          <button
            type="button"
            className="tq-back"
            onClick={back}
            disabled={step === 0 || (listDone && step === 1)}
          >
            ←
          </button>
          <button
            type="button"
            className="tq-next"
            onClick={forward}
            disabled={waiting || submitting}
          >
            {onList
              ? listText.trim()
                ? t("tb_next")
                : t("tb_list_none")
              : onLast || done
                ? t("tb_start")
                : t("tb_next")}
          </button>
        </div>
        <p className="tq-keys">
          {choices.length > 0 && (
            <>
              <kbd>1</kbd>–<kbd>{choices.length}</kbd> {t("tb_keys_choose")} ·{" "}
            </>
          )}
          {onList ? (
            <>
              <kbd>⌘/Ctrl</kbd> + <kbd>Enter</kbd> {t("tb_keys_next")}
            </>
          ) : (
            <>
              <kbd>Enter</kbd> {t("tb_keys_next")} · <kbd>←</kbd> {t("tb_keys_back")}
            </>
          )}
          {/* Not on the list card: skipping there would drop a list the
              author is still typing. */}
          {!onList && (
            <>
              <span className="tq-sep">·</span>
              <button
                type="button"
                className="tq-skip"
                onClick={() => void submit(true)}
                disabled={submitting}
              >
                {t("tb_skip")}
              </button>
            </>
          )}
        </p>
      </div>
      )}
    </div>,
    document.body,
  );
}
