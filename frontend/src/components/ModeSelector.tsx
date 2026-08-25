// ── Mode selector — three category cards with expandable sub-options ──

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { FINAL_READTHROUGH_MODES, modeLabelKeys } from "../types";
import type { TaskMode, CopyEditOptions, LineEditOptions } from "../types";

type Category = "editing" | "analysis" | "translation" | "feedback" | "readthrough";

type EditingChoice = "developmental_edit" | "line_edit" | "copy_edit";

const EDITING_CHOICE_MODES: Record<EditingChoice, TaskMode[]> = {
  developmental_edit: ["developmental_edit"],
  line_edit: ["line_edit"],
  copy_edit: ["copy_edit"],
};

// Ordered as a full-manuscript development workflow would run: big-picture
// developmental pass first, tightening down to line/copy edits. Publication
// Scan (proofread + publication_scan) is its own top-level card, not part of
// this panel — see the "readthrough" category below.
const EDITING_CHOICES: EditingChoice[] = [
  "developmental_edit",
  "line_edit",
  "copy_edit",
];

// A whole-manuscript pass of its own — it makes no sense to pair it with
// anything else in the panel. Copy and line edits stay combinable.
const EXCLUSIVE_CHOICES: EditingChoice[] = ["developmental_edit"];

const EDITING_MODES: TaskMode[] = EDITING_CHOICES.flatMap(
  (c) => EDITING_CHOICE_MODES[c],
);
const ANALYSIS_MODES: TaskMode[] = [
  "character_catalog",
  "location_catalog",
  "timeline",
];
const FEEDBACK_MODES: TaskMode[] = ["text_evaluator"];

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
  readthrough: "mode-cat-amber",
};

export default function ModeSelector() {
  const {
    lang,
    model,
    selectedModes,
    toggleMode,
    setSelectedModes,
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
  const hasFeedback = selectedModes.some((m) => FEEDBACK_MODES.includes(m));
  const hasReadthrough = selectedModes.some((m) =>
    FINAL_READTHROUGH_MODES.includes(m),
  );

  // Categories are mutually exclusive: opening one replaces the whole
  // selection with whatever of its own modes was already picked, or its
  // default if none was.
  function selectCategory(cat: Category) {
    if (openCat === cat || editSubOptionsOpen) {
      setOpenCat(null);
      setEditSubOptionsOpen(null);
      return;
    }
    setOpenCat(cat);
    // Publication Scan has no per-mode UI of its own — it's always both
    // modes together, never a user-chosen subset — so opening it always
    // resets the selection to both rather than preserving a partial one.
    if (cat === "readthrough") {
      setSelectedModes(FINAL_READTHROUGH_MODES);
      markStepComplete("edits");
      return;
    }
    const [catModes, fallback]: [TaskMode[], TaskMode] =
      cat === "translation"
        ? [["translate"], "translate"]
        : cat === "feedback"
          ? [FEEDBACK_MODES, "text_evaluator"]
          : cat === "analysis"
            ? [ANALYSIS_MODES, "character_catalog"]
            : [EDITING_MODES, "copy_edit"];
    const kept = selectedModes.filter((m) => catModes.includes(m));
    setSelectedModes(kept.length > 0 ? kept : [fallback]);
    markStepComplete("edits");
  }

  const isSelected = (m: TaskMode) => selectedModes.includes(m);

  // "Any", not "all": a selection persisted before the two modes were paired
  // (proofread alone) still lights the chip up, and the first click on it
  // normalizes the selection to both modes.
  const isChoiceSelected = (c: EditingChoice) =>
    EDITING_CHOICE_MODES[c].some((m) => selectedModes.includes(m));

  function toggleEditingChoice(choice: EditingChoice) {
    const others = selectedModes.filter((m) => !EDITING_MODES.includes(m));
    const active = EDITING_CHOICES.filter(isChoiceSelected);

    let next: EditingChoice[];
    if (isChoiceSelected(choice)) {
      // Never leave the panel with nothing selected — mirrors toggleMode.
      if (active.length <= 1) return;
      next = active.filter((c) => c !== choice);
    } else if (EXCLUSIVE_CHOICES.includes(choice)) {
      next = [choice];
    } else {
      // Copy and line edits combine with each other, but not with an
      // exclusive choice — adding one drops whatever exclusive pass was on.
      next = [...active.filter((c) => !EXCLUSIVE_CHOICES.includes(c)), choice];
    }
    // Keep workflow order regardless of the order they were clicked in.
    const ordered = EDITING_CHOICES.filter((c) => next.includes(c));
    setSelectedModes([
      ...others,
      ...ordered.flatMap((c) => EDITING_CHOICE_MODES[c]),
    ]);
  }

  const isKnownManuscriptLang = KNOWN_MANUSCRIPT_LANGS.includes(manuscriptLang);
  const isEnglishManuscript = manuscriptLang === "en";

  // Shared by every panel whose output depends on the manuscript's language:
  // edits stay in it, and the reports (developmental, writing, story overview)
  // are written in it.
  const manuscriptLangRow = (
    <div className="translate-lang manuscript-lang-row">
      <label>
        {t("manuscript_language")}:{" "}
        <select
          value={isKnownManuscriptLang ? manuscriptLang : "other"}
          onChange={(e) =>
            setManuscriptLang(e.target.value === "other" ? "" : e.target.value)
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
  );

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
          <span className="mode-cat-desc">{t("group_desc_editing")}</span>
          {hasEditing && (
            <span className="mode-cat-badge">
              {modeLabelKeys(
                selectedModes.filter((m) => EDITING_MODES.includes(m)),
              )
                .map((k) => t(k))
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

        {/* Publication Scan */}
        <button
          type="button"
          className={[
            "mode-cat-card",
            CATEGORY_COLOR.readthrough,
            openCat === "readthrough" ? "mode-cat-open" : "",
            hasReadthrough ? "mode-cat-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => selectCategory("readthrough")}
        >
          <span className="mode-cat-name">{t("group_readthrough")}</span>
          <span className="mode-cat-desc">{t("group_desc_readthrough")}</span>
          {hasReadthrough && (
            <span className="mode-cat-badge">{t("group_readthrough")}</span>
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
          <span className="mode-cat-desc">{t("mode_desc_feedback_group")}</span>
          {hasFeedback && (
            <span className="mode-cat-badge">
              {FEEDBACK_MODES.filter((m) => selectedModes.includes(m))
                .map((m) => t(`mode_${m}`))
                .join(", ")}
            </span>
          )}
        </button>

        {/* Story Elements (analysis) */}
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
            {EDITING_CHOICES.map((c) => (
              <button
                key={c}
                className={`mode-tab${isChoiceSelected(c) ? " active" : ""}`}
                onClick={() => toggleEditingChoice(c)}
              >
                {t(`mode_${c}`)}
                <span
                  className="mode-tab-info info-tooltip"
                  data-tip={t(`mode_tip_${c}`)}
                  onClick={(e) => e.stopPropagation()}
                  role="img"
                  aria-label={t(`mode_tip_${c}`)}
                >
                  ⓘ
                </span>
              </button>
            ))}
          </div>

          {manuscriptLangRow}

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
              {isEnglishManuscript && (
                <div className="option-toggle-row">
                  <span className="option-toggle-label">
                    {t("opt_introductoryComma")}
                  </span>
                  <div className="option-toggle-group">
                    <button
                      type="button"
                      className={`toggle-btn${copyEditOptions.introductoryComma ? " active" : ""}`}
                      onClick={() =>
                        setCopyEditOption("introductoryComma", true)
                      }
                    >
                      {t("opt_yes")}
                    </button>
                    <button
                      type="button"
                      className={`toggle-btn${!copyEditOptions.introductoryComma ? " active" : ""}`}
                      onClick={() =>
                        setCopyEditOption("introductoryComma", false)
                      }
                    >
                      {t("opt_no")}
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

          {isSelected("developmental_edit") && (
            <div className="option-panel">
              <span className="option-panel-label">
                {t("mode_developmental_edit")}
              </span>
              <p className="option-panel-desc">
                {t("mode_desc_developmental_hint")}
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
          {manuscriptLangRow}
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
          <div className="mode-sub-modes">
            {FEEDBACK_MODES.map((m) => (
              <button
                key={m}
                className={`mode-tab${isSelected(m) ? " active" : ""}`}
                onClick={() => toggleMode(m)}
              >
                {t(`mode_${m}`)}
              </button>
            ))}
          </div>
          {manuscriptLangRow}
          {isSelected("text_evaluator") && (
            <p className="mode-analysis-hint">{t("mode_desc_feedback_hint")}</p>
          )}
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

      {(openCat === "readthrough" || (wizardStep === "edits" && editSubOptionsOpen === "readthrough")) && (
        <div className="mode-sub-panel mode-cat-amber">
          <button
            type="button"
            className="mode-sub-close"
            onClick={() => { setOpenCat(null); setEditSubOptionsOpen(null); }}
            title={t("btn_cancel")}
          >
            −
          </button>
          <div className="option-panel">
            <span className="option-panel-label">{t("group_readthrough")}</span>
            <p className="option-panel-desc">
              {t("mode_desc_final_readthrough")}
            </p>
          </div>
        </div>
      )}

    </section>
  );
}
