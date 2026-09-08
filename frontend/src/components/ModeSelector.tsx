// ── Task selector — three cards, one intent ──
//
// The three cards here are the paid product (FRONT_CARD_MODES in types.ts,
// pinned against the backend allowlist by backend/test/cloudModes.test.ts).
// Everything experimental lives in BetaFeatures.
//
// Cards have no inside: a card that needs a control renders it below the card
// row, never within the card element. Keeps all three the same shape however
// much configuration hangs off one of them.

import { useEffect } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { FRONT_CARD_MODES, frontCardFor } from "../types";
import type {
  FrontCard,
  TaskMode,
  CopyEditOptions,
  LineEditOptions,
} from "../types";

// A local const in this file today, and it stays one — nothing else needs it.
const KNOWN_MANUSCRIPT_LANGS = ["en", "da", "de", "es"];

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

const CARDS: { id: FrontCard; titleKey: string; descKey: string }[] = [
  { id: "edit", titleKey: "card_edit_title", descKey: "card_edit_desc" },
  {
    id: "readthrough",
    titleKey: "card_readthrough_title",
    descKey: "card_readthrough_desc",
  },
  {
    id: "translate",
    titleKey: "card_translate_title",
    descKey: "card_translate_desc",
  },
];

export default function ModeSelector() {
  const {
    lang,
    selectedModes,
    setSelectedModes,
    copyEditOptions,
    setCopyEditOption,
    lineEditOptions,
    setLineEditOption,
    targetLang,
    setTargetLang,
    manuscriptLang,
    setManuscriptLang,
    markStepComplete,
    lineEditEnabled,
    setLineEditEnabled,
  } = useStore();
  const t = useTranslation(lang);

  // Dropped from the destructure deliberately: `advanceWizard`,
  // `editSubOptionsOpen`, `setEditSubOptionsOpen`, `wizardStep`, `model` and
  // `toggleMode` are all unused once the five-category panels are gone.
  // `advanceWizard` was already dead in the previous version — destructured
  // and never called.

  const activeCard = frontCardFor(selectedModes);
  // Truth for the current selection. `lineEditEnabled` is the remembered
  // preference used when the Edit card is re-selected; while the card is
  // active the selection itself is authoritative.
  const lineEditOn = selectedModes.includes("line_edit");
  // `isEnglishManuscript` is declared with the manuscript-language row below,
  // which is where it came from and what it is used with.

  // Reconcile a selection saved before `lineEditEnabled` existed: if the Edit
  // card is showing copy-only, the remembered preference must say so too, or
  // the next visit to this card silently turns the line pass back on. Runs
  // once; the two agree from then on.
  useEffect(() => {
    if (activeCard === "edit" && lineEditOn !== lineEditEnabled) {
      setLineEditEnabled(lineEditOn);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectCard(id: FrontCard) {
    // Re-clicking the active card is a no-op rather than a deselect: the step
    // must always have an answer, and "nothing selected" is not one.
    if (activeCard === id) return;
    // The Edit card restores the remembered line-edit preference, so turning
    // the line pass off survives a trip to another card and back.
    const modes: TaskMode[] =
      id === "edit" && !lineEditEnabled
        ? ["copy_edit"]
        : [...FRONT_CARD_MODES[id]];
    setSelectedModes(modes);
    markStepComplete("edits");
  }

  function toggleLineEdit(on: boolean) {
    setSelectedModes(on ? ["copy_edit", "line_edit"] : ["copy_edit"]);
    setLineEditEnabled(on);
    markStepComplete("edits");
  }

  const isKnownManuscriptLang = KNOWN_MANUSCRIPT_LANGS.includes(manuscriptLang);
  const isEnglishManuscript = manuscriptLang === "en";
  // Danish sanctions two comma systems and the author picks one — see the
  // danishComma note in types.ts. Only Danish manuscripts see this.
  const isDanishManuscript = manuscriptLang === "da";

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

  // Controls for the selected card, rendered BELOW the card row so every card
  // stays the same shape.
  function renderControls() {
    if (activeCard === "translate") {
      return (
        <>
          {manuscriptLangRow}
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
        </>
      );
    }
    if (activeCard === "readthrough") return manuscriptLangRow;
    return (
      <>
        <label className="line-edit-toggle">
          <input
            type="checkbox"
            checked={lineEditOn}
            onChange={(e) => toggleLineEdit(e.target.checked)}
          />
          <span className="line-edit-toggle-label">
            {t("opt_also_line_edit")}
          </span>
          <span className="line-edit-toggle-hint">
            {t("opt_also_line_edit_hint")}
          </span>
        </label>

        {manuscriptLangRow}

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
          {isDanishManuscript && (
            <div className="option-toggle-row">
              <span className="option-toggle-label">
                {t("opt_danishComma")}
              </span>
              <div className="option-toggle-group">
                <button
                  type="button"
                  className={`toggle-btn${copyEditOptions.danishComma === "grammatisk" ? " active" : ""}`}
                  onClick={() =>
                    setCopyEditOption("danishComma", "grammatisk")
                  }
                >
                  {t("opt_grammatiskKomma")}
                </button>
                <button
                  type="button"
                  className={`toggle-btn${copyEditOptions.danishComma === "nyt" ? " active" : ""}`}
                  onClick={() => setCopyEditOption("danishComma", "nyt")}
                >
                  {t("opt_nytKomma")}
                </button>
              </div>
            </div>
          )}
        </div>

        {lineEditOn && (
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
      </>
    );
  }

  return (
    <section className="mode-selector">
      <h2 className="tasks-heading">{t("tasks_heading")}</h2>

      <div className="task-cards">
        {CARDS.map((card) => (
          <button
            key={card.id}
            type="button"
            className={`task-card${activeCard === card.id ? " task-card-active" : ""}`}
            aria-pressed={activeCard === card.id}
            onClick={() => selectCard(card.id)}
          >
            <span className="task-card-title">{t(card.titleKey)}</span>
            <span className="task-card-desc">{t(card.descKey)}</span>
          </button>
        ))}
      </div>

      {activeCard && <div className="task-controls">{renderControls()}</div>}
    </section>
  );
}
