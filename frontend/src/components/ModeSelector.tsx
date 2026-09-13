// ── Task selector — four cards, one intent ──
//
// The first three cards are the paid product (FRONT_CARD_MODES in types.ts,
// pinned against the backend allowlist by backend/test/cloudModes.test.ts);
// the fourth counts on this machine and costs nothing. Everything
// experimental lives in BetaFeatures.
//
// Cards have no inside: a card that needs a control renders it below the card
// row, never within the card element. Keeps all four the same shape however
// much configuration hangs off one of them. Clicking the active card again
// folds its controls away; the selection stays.

import { useEffect, useState } from "react";
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
import ManuscriptSettings from "./ManuscriptSettings";

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
  {
    id: "language",
    titleKey: "card_language_title",
    descKey: "card_language_desc",
  },
];

export default function ModeSelector({
  onCollapse,
}: {
  /** Supplied when this sits in a foldable setup card. */
  onCollapse?: () => void;
} = {}) {
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
    markStepComplete,
    advanceWizard,
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
  // The controls under the cards fold on a second click of the active card,
  // so a card that has been set up once is not stuck open for the session.
  const [controlsOpen, setControlsOpen] = useState(true);
  // Truth for the current selection. `lineEditEnabled` is the remembered
  // preference used when the Edit card is re-selected; while the card is
  // active the selection itself is authoritative.
  const lineEditOn = selectedModes.includes("line_edit");

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
    // Re-clicking the active card folds or unfolds its controls rather than
    // deselecting it: the step must always have an answer, and "nothing
    // selected" is not one.
    if (activeCard === id) {
      setControlsOpen((o) => !o);
      return;
    }
    setControlsOpen(true);
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

  // Language, dialect and the comma conventions now live in one collapsible
  // panel that reports what Betty read off the manuscript. Which rows it shows
  // depends on the card — see CARD_SETTINGS in ManuscriptSettings.tsx.
  const manuscriptSettings = activeCard ? (
    <ManuscriptSettings card={activeCard} />
  ) : null;

  // Controls for the selected card, rendered BELOW the card row so every card
  // stays the same shape.
  function renderControls() {
    if (activeCard === "translate") {
      return (
        <>
          {manuscriptSettings}
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
    if (activeCard === "readthrough" || activeCard === "language")
      return manuscriptSettings;
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

        {manuscriptSettings}

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
          </div>
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
      {/* Doubles as this card's fold control, so every card collapses from its
          own top line rather than one of them being the exception. */}
      <h2
        className={`tasks-heading${onCollapse ? " tasks-heading-toggle" : ""}`}
        role={onCollapse ? "button" : undefined}
        tabIndex={onCollapse ? 0 : undefined}
        title={onCollapse ? t("minimise_step", "Minimise") : undefined}
        onClick={onCollapse}
        onKeyDown={(e) => {
          if (!onCollapse) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onCollapse();
          }
        }}
      >
        {t("tasks_heading")}
      </h2>

      <div className="task-cards">
        {CARDS.map((card) => (
          <button
            key={card.id}
            type="button"
            className={`task-card${activeCard === card.id ? " task-card-active" : ""}`}
            aria-pressed={activeCard === card.id}
            aria-expanded={activeCard === card.id ? controlsOpen : undefined}
            onClick={() => selectCard(card.id)}
          >
            <span className="task-card-title">{t(card.titleKey)}</span>
            <span className="task-card-desc">{t(card.descKey)}</span>
          </button>
        ))}
      </div>

      {activeCard && controlsOpen && (
        <div className="task-controls">{renderControls()}</div>
      )}

    </section>
  );
}
