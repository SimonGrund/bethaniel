// ── Task selector — four cards, one intent ──
//
// The first three cards are the paid product (FRONT_CARD_MODES in types.ts,
// pinned against the backend allowlist by backend/test/cloudModes.test.ts);
// the fourth counts on this machine and costs nothing. Everything
// experimental lives in BetaFeatures.
//
// Cards have no inside: a card that needs a control renders it behind the
// one Settings button under the card row, never within the card element.
// Keeps all four the same shape however much configuration hangs off one of
// them, and keeps the column short. The button's mark says whether the
// manuscript answered every question the run will ask (green) or one is
// waiting on the author (orange). Clicking the active card again opens the
// same dialog; the selection stays.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import Modal from "./Modal";
import {
  FRONT_CARD_MODES,
  frontCardFor,
  styleGuideApplies,
  DEFAULT_COPY_EDIT_OPTIONS,
  DEFAULT_LINE_EDIT_OPTIONS,
} from "../types";
import type {
  FrontCard,
  TaskMode,
  CopyEditOptions,
  LineEditOptions,
} from "../types";
import type React from "react";

// A local const in this file today, and it stays one — nothing else needs it.
import FoldingPanel from "./FoldingPanel";
import StyleGuideButton from "./StyleGuideButton";

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

const CARDS: { id: FrontCard; titleKey: string; descKey?: string }[] = [
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
  // The title says it all; a line under it only made this card taller than
  // the three beside it.
  { id: "language", titleKey: "card_language_title" },
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

  /**
   * The one line a folded option group shows in place of its checkboxes.
   *
   * Untouched groups say so rather than listing their contents: "default" is
   * both shorter and more useful than five labels the author never chose. Once
   * anything is changed the summary must stop claiming default and name what
   * is actually on, or the fold would be hiding the author's own edits behind
   * a line that says nothing happened.
   */
  function summarise<K extends string>(
    keys: readonly K[],
    current: (k: K) => boolean,
    fallback: (k: K) => boolean,
  ): string {
    if (keys.every((k) => current(k) === fallback(k))) {
      return t("opt_group_default");
    }
    const on = keys.filter(current).map((k) => t(`opt_${k}`));
    return on.length ? on.join(" · ") : t("opt_group_none");
  }

  const activeCard = frontCardFor(selectedModes);
  // Every control the selected card has lives in one dialog.
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    // Re-clicking the active card opens its settings rather than deselecting
    // it: the step must always have an answer, and "nothing selected" is not
    // one.
    if (activeCard === id) {
      setSettingsOpen(true);
      return;
    }
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

  // Language, dialect and the comma conventions are the manuscript's, and
  // live on the manuscript card (ManuscriptSettings there). What is left
  // here is the task's own: which passes, which options, where to.
  function renderControls() {
    if (activeCard === "translate") {
      return (
        <>
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
    if (activeCard === "readthrough" || activeCard === "language") return null;
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

        <FoldingPanel
          title={t("mode_copy_edit")}
          summary={summarise(
            COPY_EDIT_KEYS,
            (k) => copyEditOptions[k] as boolean,
            (k) => DEFAULT_COPY_EDIT_OPTIONS[k] as boolean,
          )}
        >
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
        </FoldingPanel>

        {lineEditOn && (
        <FoldingPanel
          title={t("mode_line_edit")}
          summary={summarise(
            LINE_EDIT_KEYS,
            (k) => lineEditOptions[k],
            (k) => DEFAULT_LINE_EDIT_OPTIONS[k],
          )}
        >
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
        </FoldingPanel>
        )}
      </>
    );
  }

  return (
    <section className="mode-selector">
      {/* Doubles as this card's fold control, so every card collapses from its
          own top line rather than one of them being the exception. */}

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
            {card.descKey && (
              <span className="task-card-desc">{t(card.descKey)}</span>
            )}
          </button>
        ))}
      </div>

      {activeCard && (
        <TaskSettings
          title={t(CARDS.find((c) => c.id === activeCard)!.titleKey)}
          open={settingsOpen}
          onOpen={() => setSettingsOpen(true)}
          onClose={() => setSettingsOpen(false)}
          targetLangMissing={activeCard === "translate" && !targetLang.trim()}
          summary={
            activeCard === "translate"
              ? targetLang.trim()
                ? `${t("target_language")}: ${targetLang.trim()}`
                : ""
              : activeCard === "edit"
                ? [
                    `${t("mode_copy_edit")}: ${summarise(
                      COPY_EDIT_KEYS,
                      (k) => copyEditOptions[k] as boolean,
                      (k) => DEFAULT_COPY_EDIT_OPTIONS[k] as boolean,
                    )}`,
                    lineEditOn
                      ? `${t("mode_line_edit")}: ${summarise(
                          LINE_EDIT_KEYS,
                          (k) => lineEditOptions[k],
                          (k) => DEFAULT_LINE_EDIT_OPTIONS[k],
                        )}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : t("task_settings_nothing")
          }
        >
          {renderControls()}
          {/* With the rest of this task's settings, not beside them: the style
              sheet is one of them. Only for runs that read one — see
              styleGuideApplies. */}
          {styleGuideApplies(selectedModes) && <StyleGuideButton />}
        </TaskSettings>
      )}

    </section>
  );
}

// ── The one Settings button under the cards ──
//
// The mark is the point: it answers "do I need to look in here?" without
// opening it. Orange when something is waiting on the author — a
// translation with no target — green otherwise. The manuscript's own
// settings (language, dialect, commas) live on the manuscript card, with
// their own mark. The button stays whichever card is active — its
// contents change.
function TaskSettings({
  title,
  open,
  onOpen,
  onClose,
  targetLangMissing,
  summary,
  children,
}: {
  title: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  targetLangMissing: boolean;
  /** The one line the button shows for this task's settings. */
  summary: string;
  children: React.ReactNode;
}) {
  const lang = useStore((s) => s.lang);
  const t = useTranslation(lang);

  const mark: "clean" | "attention" = targetLangMissing ? "attention" : "clean";
  const hint = targetLangMissing ? t("ms_needs_input_one").replace("{n}", "1") : summary;

  return (
    <>
      <button
        type="button"
        className={`task-settings-cta task-settings-cta-${mark}`}
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="task-settings-mark" aria-hidden="true">
          {mark === "clean" ? "●" : mark === "attention" ? "▲" : "○"}
        </span>
        <span className="task-settings-body">
          <span className="task-settings-title">
            {t("task_settings_title")}
            <span className="task-settings-tag">{title}</span>
          </span>
          <span className="task-settings-hint">{hint}</span>
        </span>
        <span className="task-settings-chevron" aria-hidden="true">
          ›
        </span>
      </button>

      <Modal
        open={open}
        onClose={onClose}
        labelledBy="task-settings-title"
        className="task-settings-dialog"
      >
        <h2 id="task-settings-title" className="dialog-title">
          {t("task_settings_title")}
          <span className="task-settings-dialog-task">{title}</span>
        </h2>
        <div className="task-controls task-controls-dialog">{children}</div>
        <div className="step-confirm-row">
          <button type="button" className="btn-primary btn-confirm-step" onClick={onClose}>
            {t("task_settings_done")}
          </button>
        </div>
      </Modal>
    </>
  );
}
