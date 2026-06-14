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
  analysis: "mode-cat-amber",
  translation: "mode-cat-amber",
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
    wizardStep,
    advanceWizard,
    markStepComplete,
    editSubOptionsOpen,
    setEditSubOptionsOpen,
  } = useStore();
  const t = useTranslation(lang);
  const [openCat, setOpenCat] = useState<Category | null>(null);

  const hasEditing = selectedModes.some((m) => EDITING_MODES.includes(m));
  const hasAnalysis = selectedModes.some((m) => ANALYSIS_MODES.includes(m));
  const hasTranslation = selectedModes.includes("translate");

  function selectCategory(cat: Category) {
    if (openCat === cat || editSubOptionsOpen) {
      setOpenCat(null);
      setEditSubOptionsOpen(null);
    } else {
      setOpenCat(cat);
      if (cat === "translation") {
        // Toggle translate ON first (so we have >1 mode to satisfy min-1 guard)
        if (!selectedModes.includes("translate")) toggleMode("translate");
        // Then remove everything else
        for (const m of selectedModes) {
          if (m !== "translate") toggleMode(m);
        }
      } else if (cat === "analysis") {
        // Remove translation if present
        if (selectedModes.includes("translate")) toggleMode("translate");
        // Auto-select the first analysis mode if none active (min-1 guard)
        if (!ANALYSIS_MODES.some((m) => selectedModes.includes(m))) {
          toggleMode("character_catalog");
        }
        // Remove all editing modes
        for (const m of EDITING_MODES) {
          if (selectedModes.includes(m)) toggleMode(m);
        }
      } else {
        // editing
        if (selectedModes.includes("translate")) toggleMode("translate");
        if (!EDITING_MODES.some((m) => selectedModes.includes(m))) {
          toggleMode("copy_edit");
        }
        for (const m of ANALYSIS_MODES) {
          if (selectedModes.includes(m)) toggleMode(m);
        }
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
          disabled
          className={[
            "mode-cat-card",
            "mode-cat-disabled",
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
                      checked={copyEditOptions[key] as boolean}
                      onChange={(e) => setCopyEditOption(key, e.target.checked)}
                    />
                    {t(`opt_${key}`)}
                  </label>
                ))}
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
              </div>
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
                disabled
                className={`mode-tab${isSelected(m) ? " active" : ""} mode-tab-disabled`}
                title={t(`mode_desc_${m}`)}
              >
                {t(`mode_${m}`)}
              </button>
            ))}
          </div>
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

      {/* ── Wizard confirm buttons ── */}
      {wizardStep === "edits" && selectedModes.length > 0 && (
        <div className="wizard-confirm">
          {openCat === "translation" || openCat === "analysis" || openCat === "editing" ? (
            <button
              type="button"
              className="btn-primary btn-confirm-step"
              onClick={() => {
                markStepComplete("edits");
                setEditSubOptionsOpen(null);
                advanceWizard("edits");
              }}
            >
              {t("wizard_confirm_details")}
            </button>
          ) : !editSubOptionsOpen ? (
            <button
              type="button"
              className="btn-primary btn-confirm-step"
              onClick={() => setEditSubOptionsOpen(openCat)}
            >
              {t("wizard_confirm_edits")}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary btn-confirm-step"
              onClick={() => {
                markStepComplete("edits");
                setEditSubOptionsOpen(null);
                advanceWizard("edits");
              }}
            >
              {t("wizard_confirm_details")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
