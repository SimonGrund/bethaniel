// ── Mode selector — task mode + option checkboxes ──

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import type { TaskMode, CopyEditOptions, LineEditOptions } from "../types";

const ALL_MODES: TaskMode[] = [
  "copy_edit",
  "line_edit",
  "translate",
  "character_catalog",
  "location_catalog",
  "timeline",
];

const COPY_EDIT_KEYS: (keyof CopyEditOptions)[] = [
  "spelling",
  "punctuation",
  "capitalization",
  "duplicateWords",
  "britishToAmerican",
  "oxfordComma",
  "dialogueTags",
];

const LINE_EDIT_KEYS: (keyof LineEditOptions)[] = [
  "awkwardPhrasing",
  "redundancy",
  "weakVerbs",
  "cliches",
  "showDontTell",
  "sentenceRhythm",
  "dialogueNaturalness",
  "tightenProse",
];

export default function ModeSelector() {
  const {
    lang,
    taskMode,
    setTaskMode,
    copyEditOptions,
    setCopyEditOption,
    lineEditOptions,
    setLineEditOption,
    targetLang,
    setTargetLang,
  } = useStore();
  const t = useTranslation(lang);

  return (
    <section className="stage">
      <div className="section-label">
        <span className="num">III.</span>
        {t("sec_mode")}
      </div>

      <div className="mode-tabs">
        {ALL_MODES.map((m) => (
          <button
            key={m}
            className={`mode-tab${taskMode === m ? " active" : ""}`}
            onClick={() => setTaskMode(m)}
            title={t(`mode_desc_${m}`)}
          >
            {t(`mode_${m}`)}
          </button>
        ))}
      </div>

      <p className="mode-description">{t(`mode_desc_${taskMode}`)}</p>

      {taskMode === "copy_edit" && (
        <div className="option-grid">
          {COPY_EDIT_KEYS.map((key) => (
            <label key={key} className="option-check">
              <input
                type="checkbox"
                checked={copyEditOptions[key]}
                onChange={(e) => setCopyEditOption(key, e.target.checked)}
              />
              {t(`opt_${key}`)}
            </label>
          ))}
        </div>
      )}

      {taskMode === "line_edit" && (
        <div className="option-grid">
          {LINE_EDIT_KEYS.map((key) => (
            <label key={key} className="option-check">
              <input
                type="checkbox"
                checked={lineEditOptions[key]}
                onChange={(e) => setLineEditOption(key, e.target.checked)}
              />
              {t(`opt_${key}`)}
            </label>
          ))}
        </div>
      )}

      {taskMode === "translate" && (
        <div className="translate-lang">
          <label>
            {t("target_language")}:{" "}
            <input
              type="text"
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              placeholder="English"
              className="lang-input"
            />
          </label>
        </div>
      )}
    </section>
  );
}
