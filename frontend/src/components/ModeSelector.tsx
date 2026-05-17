// ── Mode selector — three category cards with expandable sub-options ──

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import type { TaskMode, CopyEditOptions, LineEditOptions } from "../types";

type Category = "editing" | "analysis" | "translation";

const EDITING_MODES: TaskMode[] = ["copy_edit", "line_edit"];
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

const CATEGORY_COLOR: Record<Category, string> = {
  editing: "mode-cat-amber",
  analysis: "mode-cat-teal",
  translation: "mode-cat-rose",
};

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
  const [openCat, setOpenCat] = useState<Category | null>(null);

  const hasEditing = selectedModes.some((m) => EDITING_MODES.includes(m));
  const hasAnalysis = selectedModes.some((m) => ANALYSIS_MODES.includes(m));
  const hasTranslation = selectedModes.includes("translate");

  function selectCategory(cat: Category) {
    if (openCat === cat) {
      setOpenCat(null);
    } else {
      setOpenCat(cat);
      // Auto-enable translate when opening the translation panel
      if (cat === "translation" && !selectedModes.includes("translate")) {
        toggleMode("translate");
      }
    }
  }

  const isSelected = (m: TaskMode) => selectedModes.includes(m);

  return (
    <section className="mode-selector">
      <div className="section-label">
        <span className="num">II.</span>
        {t("sec_mode")}
        <span className="info-tooltip" data-tip={t("tooltip_mode")}>
          ⓘ
        </span>
      </div>

      <div className="mode-cat-cards">
        {/* Editing */}
        <button
          type="button"
          className={[
            "mode-cat-card",
            CATEGORY_COLOR.editing,
            openCat === "editing" ? "mode-cat-open" : "",
            hasEditing ? "mode-cat-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => selectCategory("editing")}
        >
          <span className="mode-cat-name">{t("group_editing")}</span>
          <span className="mode-cat-desc">{t("mode_desc_copy_edit")}</span>
          {hasEditing && (
            <span className="mode-cat-badge">
              {selectedModes
                .filter((m) => EDITING_MODES.includes(m))
                .map((m) => t(`mode_${m}`))
                .join(", ")}
            </span>
          )}
        </button>

        {/* Analysis */}
        <button
          type="button"
          className={[
            "mode-cat-card",
            CATEGORY_COLOR.analysis,
            openCat === "analysis" ? "mode-cat-open" : "",
            hasAnalysis ? "mode-cat-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => selectCategory("analysis")}
        >
          <span className="mode-cat-name">{t("group_analysis")}</span>
          <span className="mode-cat-desc">
            {t("mode_desc_character_catalog")}
          </span>
          {hasAnalysis && (
            <span className="mode-cat-badge">
              {selectedModes
                .filter((m) => ANALYSIS_MODES.includes(m))
                .map((m) => t(`mode_${m}`))
                .join(", ")}
            </span>
          )}
        </button>

        {/* Translation */}
        <button
          type="button"
          className={[
            "mode-cat-card",
            CATEGORY_COLOR.translation,
            openCat === "translation" ? "mode-cat-open" : "",
            hasTranslation ? "mode-cat-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => selectCategory("translation")}
        >
          <span className="mode-cat-name">{t("group_translate")}</span>
          <span className="mode-cat-desc">{t("mode_desc_translate")}</span>
          {hasTranslation && (
            <span className="mode-cat-badge">{t("mode_translate")}</span>
          )}
        </button>
      </div>

      {/* ── Expanded sub-options ── */}
      {openCat === "editing" && (
        <div className="mode-sub-panel mode-cat-amber">
          <div className="mode-sub-modes">
            {EDITING_MODES.map((m) => (
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
        </div>
      )}

      {openCat === "analysis" && (
        <div className="mode-sub-panel mode-cat-teal">
          <div className="mode-sub-modes">
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
      )}

      {openCat === "translation" && (
        <div className="mode-sub-panel mode-cat-rose">
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
        </div>
      )}
    </section>
  );
}
