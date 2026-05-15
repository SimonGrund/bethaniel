// ── Mode selector — multi-select task modes + option checkboxes ──

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import type { TaskMode, CopyEditOptions, LineEditOptions } from "../types";

const EDIT_MODES: TaskMode[] = ["copy_edit", "line_edit"];
const ANALYSIS_MODES: TaskMode[] = [
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
    selectedModes,
    toggleMode,
    copyEditOptions,
    setCopyEditOption,
    lineEditOptions,
    setLineEditOption,
    targetLang,
    setTargetLang,
  } = useStore();
  const t = useTranslation(lang);

  const isSelected = (m: TaskMode) => selectedModes.includes(m);

  return (
    <section className="stage">
      <div className="section-label">
        <span className="num">III.</span>
        {t("sec_mode")}
      </div>

      {/* ── Editing modes (co-selectable) ── */}
      <div className="mode-group">
        <span className="mode-group-label">{t("group_editing")}</span>
        <div className="mode-tabs">
          {EDIT_MODES.map((m) => (
            <button
              key={m}
              className={`mode-tab${isSelected(m) ? " active" : ""}`}
              onClick={() => toggleMode(m)}
              title={t(`mode_desc_${m}`)}
            >
              {t(`mode_${m}`)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Analysis modes (co-selectable) ── */}
      <div className="mode-group">
        <span className="mode-group-label">{t("group_analysis")}</span>
        <div className="mode-tabs">
          {ANALYSIS_MODES.map((m) => (
            <button
              key={m}
              className={`mode-tab${isSelected(m) ? " active" : ""}`}
              onClick={() => toggleMode(m)}
              title={t(`mode_desc_${m}`)}
            >
              {t(`mode_${m}`)}
            </button>
          ))}
        </div>
      </div>

      {/* ── Translation ── */}
      <div className="mode-group">
        <span className="mode-group-label">{t("group_translate")}</span>
        <div className="mode-tabs">
          <button
            className={`mode-tab${isSelected("translate") ? " active" : ""}`}
            onClick={() => toggleMode("translate")}
            title={t("mode_desc_translate")}
          >
            {t("mode_translate")}
          </button>
        </div>
      </div>

      {/* Summary of active modes */}
      <p className="mode-description">
        {selectedModes.map((m) => t(`mode_${m}`)).join(" + ")}
      </p>

      {/* ── Copy edit sub-panel ── */}
      {isSelected("copy_edit") && (
        <div className="option-panel">
          <span className="option-panel-label">{t("mode_copy_edit")}</span>
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
        </div>
      )}

      {/* ── Line edit sub-panel ── */}
      {isSelected("line_edit") && (
        <div className="option-panel">
          <span className="option-panel-label">{t("mode_line_edit")}</span>
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
        </div>
      )}

      {/* ── Translate language ── */}
      {isSelected("translate") && (
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
