// ── Mode selector — three category cards with expandable sub-options ──

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import type { TaskMode, CopyEditOptions, LineEditOptions } from "../types";

type Category = "editing" | "analysis" | "translation" | "feedback";

const EDITING_MODES: TaskMode[] = ["copy_edit", "line_edit", "publication_scan"];
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

// Languages with a bundled spell-check dictionary; anything else is passed
// to the LLM as free text (spell-check is skipped server-side).
const KNOWN_MANUSCRIPT_LANGS = ["en", "da", "de", "es"];

const CATEGORY_COLOR: Record<Category, string> = {
  editing: "mode-cat-amber",
  analysis: "mode-cat-amber",
  translation: "mode-cat-amber",
  feedback: "mode-cat-amber",
};

export default function ModeSelector() {
  const {
    lang,
    model,
    selectedModes,
    toggleMode,
    copyEditOptions,
    setCopyEditOption,
    lineEditOptions,
    setLineEditOption,
    targetLang,
    setTargetLang,
    manuscriptLang,
    setManuscriptLang,
    wizardStep,
    advanceWizard,
    markStepComplete,
    editSubOptionsOpen,
    setEditSubOptionsOpen,
  } = useStore();
  const t = useTranslation(lang);
  const [openCat, setOpenCat] = useState<Category | null>(null);
  // Mirrors ModelSelector's API-model detection: External-Betty style models
  // are "custom:<provider>" entries; "custom:gguf" is a local file.
  const isApiModelSelected =
    model.startsWith("custom:") && model !== "custom:gguf";

  const hasEditing = selectedModes.some((m) => EDITING_MODES.includes(m));
  const hasAnalysis = selectedModes.some((m) => ANALYSIS_MODES.includes(m));
  const hasTranslation = selectedModes.includes("translate");
  const hasFeedback = selectedModes.includes("text_evaluator");

  function selectCategory(cat: Category) {
    if (openCat === cat || editSubOptionsOpen) {
      setOpenCat(null);
      setEditSubOptionsOpen(null);
    } else {
      setOpenCat(cat);
      if (cat === "translation") {
        if (!selectedModes.includes("translate")) toggleMode("translate");
        for (const m of selectedModes) {
          if (m !== "translate") toggleMode(m);
        }
      } else if (cat === "feedback") {
        if (!selectedModes.includes("text_evaluator"))
          toggleMode("text_evaluator");
        for (const m of selectedModes) {
          if (m !== "text_evaluator") toggleMode(m);
        }
      } else if (cat === "analysis") {
        if (selectedModes.includes("translate")) toggleMode("translate");
        if (selectedModes.includes("text_evaluator"))
          toggleMode("text_evaluator");
        if (!ANALYSIS_MODES.some((m) => selectedModes.includes(m))) {
          toggleMode("character_catalog");
        }
        for (const m of EDITING_MODES) {
          if (selectedModes.includes(m)) toggleMode(m);
        }
      } else {
        if (selectedModes.includes("translate")) toggleMode("translate");
        if (selectedModes.includes("text_evaluator"))
          toggleMode("text_evaluator");
        if (!EDITING_MODES.some((m) => selectedModes.includes(m))) {
          toggleMode("copy_edit");
        }
        for (const m of ANALYSIS_MODES) {
          if (selectedModes.includes(m)) toggleMode(m);
        }
      }
      markStepComplete("edits");
    }
  }

  const isSelected = (m: TaskMode) => selectedModes.includes(m);

  const isKnownManuscriptLang = KNOWN_MANUSCRIPT_LANGS.includes(manuscriptLang);
  const isEnglishManuscript = manuscriptLang === "en";

  return (
    <section className="mode-selector">

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

        {/* Writing feedback */}
        <button
          type="button"
          className={[
            "mode-cat-card",
            CATEGORY_COLOR.feedback,
            openCat === "feedback" ? "mode-cat-open" : "",
            hasFeedback ? "mode-cat-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => selectCategory("feedback")}
        >
          <span className="mode-cat-name">{t("group_feedback")}</span>
          <span className="mode-cat-desc">
            {t("mode_desc_text_evaluator")}
          </span>
          {hasFeedback && (
            <span className="mode-cat-badge">{t("mode_text_evaluator")}</span>
          )}
        </button>
      </div>

      {/* ── Expanded sub-options ── */}
      {(openCat === "editing" || (wizardStep === "edits" && editSubOptionsOpen === "editing")) && (
        <div className="mode-sub-panel mode-cat-amber">
          <button
            type="button"
            className="mode-sub-close"
            onClick={() => { setOpenCat(null); setEditSubOptionsOpen(null); }}
            title={t("btn_cancel")}
          >
            −
          </button>
          <div className="mode-sub-modes">
            {EDITING_MODES.map((m) => (
              <button
                key={m}
                className={`mode-tab${isSelected(m) ? " active" : ""}`}
                onClick={() => toggleMode(m)}
              >
                {t(`mode_${m}`)}
              </button>
            ))}
          </div>

          <div className="translate-lang">
            <label>
              {t("manuscript_language")}:{" "}
              <select
                value={isKnownManuscriptLang ? manuscriptLang : "other"}
                onChange={(e) =>
                  setManuscriptLang(
                    e.target.value === "other" ? "" : e.target.value,
                  )
                }
                className="lang-input"
              >
                {KNOWN_MANUSCRIPT_LANGS.map((l) => (
                  <option key={l} value={l}>
                    {t(`lang_${l}`)}
                  </option>
                ))}
                <option value="other">{t("lang_other")}</option>
              </select>
            </label>
            {!isKnownManuscriptLang && (
              <input
                type="text"
                value={manuscriptLang}
                onChange={(e) => setManuscriptLang(e.target.value)}
                placeholder={t("lang_other_placeholder")}
                className="lang-input"
              />
            )}
          </div>

          {isSelected("copy_edit") && (
            <div className="option-panel">
              <span className="option-panel-label">{t("mode_copy_edit")}</span>
              <div className="option-grid">
                {COPY_EDIT_KEYS.map((key) => (
                  <label key={key} className="option-check">
                    <input
                      type="checkbox"
                      checked={copyEditOptions[key] as boolean}
                      onChange={(e) => setCopyEditOption(key, e.target.checked)}
                    />
                    {t(`opt_${key}`)}
                  </label>
                ))}
                {isEnglishManuscript && (
                  <label className="option-check">
                    <input
                      type="checkbox"
                      checked={copyEditOptions.oxfordComma}
                      onChange={(e) =>
                        setCopyEditOption("oxfordComma", e.target.checked)
                      }
                    />
                    {t("opt_oxfordComma")}
                  </label>
                )}
                {isEnglishManuscript && (
                  <label className="option-check">
                    <input
                      type="checkbox"
                      checked={copyEditOptions.introductoryComma}
                      onChange={(e) =>
                        setCopyEditOption("introductoryComma", e.target.checked)
                      }
                    />
                    {t("opt_introductoryComma")}
                  </label>
                )}
              </div>
              {isEnglishManuscript && (
                <div className="option-toggle-row">
                  <span className="option-toggle-label">
                    {t("opt_englishDialect")}
                  </span>
                  <div className="option-toggle-group">
                    <button
                      type="button"
                      className={`toggle-btn${copyEditOptions.englishDialect === "american" ? " active" : ""}`}
                      onClick={() =>
                        setCopyEditOption("englishDialect", "american")
                      }
                    >
                      {t("opt_american")}
                    </button>
                    <button
                      type="button"
                      className={`toggle-btn${copyEditOptions.englishDialect === "british" ? " active" : ""}`}
                      onClick={() =>
                        setCopyEditOption("englishDialect", "british")
                      }
                    >
                      {t("opt_british")}
                    </button>
                  </div>
                </div>
              )}
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

          {isSelected("publication_scan") && (
            <div className="option-panel">
              <span className="option-panel-label">
                {t("mode_publication_scan")}
              </span>
              <p className="option-panel-desc">
                {t("mode_desc_publication_scan")}
              </p>
            </div>
          )}
        </div>
      )}

      {(openCat === "analysis" || (wizardStep === "edits" && editSubOptionsOpen === "analysis")) && (
        <div className="mode-sub-panel mode-cat-amber">
          <button
            type="button"
            className="mode-sub-close"
            onClick={() => { setOpenCat(null); setEditSubOptionsOpen(null); }}
            title={t("btn_cancel")}
          >
            −
          </button>
          <div className="mode-sub-modes">
            {ANALYSIS_MODES.map((m) => (
              <button
                key={m}
                className={`mode-tab${isSelected(m) ? " active" : ""}`}
                onClick={() => toggleMode(m)}
              >
                {t(`mode_${m}`)}
              </button>
            ))}
          </div>
          <p className="mode-analysis-hint">{t("mode_desc_analysis_hint")}</p>
          {!isApiModelSelected && (
            <p className="mode-analysis-warning">
              ⚠ {t("analysis_local_warning")}
            </p>
          )}
        </div>
      )}

      {(openCat === "feedback" || (wizardStep === "edits" && editSubOptionsOpen === "feedback")) && (
        <div className="mode-sub-panel mode-cat-amber">
          <button
            type="button"
            className="mode-sub-close"
            onClick={() => { setOpenCat(null); setEditSubOptionsOpen(null); }}
            title={t("btn_cancel")}
          >
            −
          </button>
          <p className="mode-analysis-hint">{t("mode_desc_feedback_hint")}</p>
          {!isApiModelSelected && (
            <p className="mode-analysis-warning">
              ⚠ {t("feedback_local_warning")}
            </p>
          )}
        </div>
      )}

      {(openCat === "translation" || (wizardStep === "edits" && editSubOptionsOpen === "translation")) && (
        <div className="mode-sub-panel mode-cat-amber">
          <button
            type="button"
            className="mode-sub-close"
            onClick={() => { setOpenCat(null); setEditSubOptionsOpen(null); }}
            title={t("btn_cancel")}
          >
            −
          </button>
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
