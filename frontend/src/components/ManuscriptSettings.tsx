// ── The manuscript settings, folded down to one line when Betty already knows ──
//
// These four questions — language, dialect, and the comma conventions — used
// to sit open on the Edit card as a wall of controls the author had to read
// before starting. Now that the manuscript answers them itself, the common
// case deserves one quiet line, and the author's attention should be spent
// only on what Betty genuinely could not tell.
//
// Hence the two states (the folding shell itself is FoldingPanel.tsx). A
// green check means every question that applies was
// answered from the text; the panel stays shut and the summary line says what
// was found. An amber triangle means at least one came back "unsure", and the
// panel opens itself — a warning the user must click to understand is a
// warning they learn to ignore.
//
// A third state carries no icon at all: no detection ran (a document stored
// before detection existed, or a manuscript Betty could not place). Betty
// makes no claim there, and an icon either way would be a lie — green would
// say "checked" when nothing was, amber would nag every older document.
//
// An "unsure" stops being one the moment the author answers it — picks a
// value, or confirms the one shown, or says the lot is right. The panel is
// then green: every question was settled, by the manuscript or by the
// author, and there is nothing left to look at.
//
// Which rows appear is decided per card by what the run actually READS. A
// translation never consults the Oxford-comma setting, so asking for one is
// asking the author to make a decision that changes nothing.

import { useStore } from "../store";
import { useTranslation } from "../i18n";
import type { DetectedSettings, FrontCard, Lang } from "../types";
import DetectionBadge from "./DetectionBadge";
import FoldingPanel from "./FoldingPanel";

/** The settings this panel owns — exactly the ones detectSettings.ts reads. */
export type SettingKey = keyof DetectedSettings;

export type SettingsStatus = "clean" | "attention" | "neutral";

/**
 * Which settings each card's run actually consults.
 *
 *  edit        — converts dialect and applies every comma convention.
 *  readthrough — the publication scan measures dialect consistency against
 *                the declared value; its proofread half deliberately ignores
 *                dialect and commas ("zero-config surface pass").
 *  translate   — source language only; the target has its own field.
 *  language    — the counts report is written in the manuscript's language.
 */
export const CARD_SETTINGS: Record<FrontCard, SettingKey[]> = {
  edit: [
    "manuscriptLang",
    "englishDialect",
    "oxfordComma",
    "introductoryComma",
    "danishComma",
  ],
  readthrough: ["manuscriptLang", "englishDialect"],
  translate: ["manuscriptLang"],
  language: ["manuscriptLang"],
};

/**
 * The panel's headline state. Pure, so the rule stays readable: anything
 * unsure wins, otherwise at least one confident answer earns the check, and
 * "nothing was detected" is neither.
 */
export function settingsStatus(
  keys: SettingKey[],
  detected: DetectedSettings | null | undefined,
  settled: SettingKey[] = [],
): SettingsStatus {
  if (!detected) return "neutral";
  let anyDetected = false;
  for (const key of keys) {
    const d = detected[key];
    if (!d) continue;
    if (d.status === "unsure" && !settled.includes(key)) return "attention";
    anyDetected = true;
  }
  return anyDetected ? "clean" : "neutral";
}

/** The shown settings still waiting on the author. */
export function waitingKeys(
  keys: SettingKey[],
  detected: DetectedSettings | null | undefined,
  settled: SettingKey[] = [],
): SettingKey[] {
  if (!detected) return [];
  return keys.filter((k) => detected[k]?.status === "unsure" && !settled.includes(k));
}

/** How many of the shown settings are waiting on the author. */
export function attentionCount(
  keys: SettingKey[],
  detected: DetectedSettings | null | undefined,
  settled: SettingKey[] = [],
): number {
  return waitingKeys(keys, detected, settled).length;
}

const KNOWN_MANUSCRIPT_LANGS = ["en", "da", "de", "es"];

/**
 * The state of a card's manuscript settings, for anything that reports it:
 * this panel's fold line, and the Settings button under the cards. One
 * computation, so the two never disagree about what is settled.
 */
export function useManuscriptSettingsState(card: FrontCard) {
  const { lang, manuscriptLang, copyEditOptions, detectedSettings, settledSettings } = useStore();
  const t = useTranslation(lang);

  const isKnownLang = KNOWN_MANUSCRIPT_LANGS.includes(manuscriptLang);
  const isEnglish = manuscriptLang === "en";
  const isDanish = manuscriptLang === "da";

  // The card says which questions are relevant to the run; the manuscript's
  // language says which of those are answerable at all.
  const keys = CARD_SETTINGS[card].filter((key) => {
    if (key === "danishComma") return isDanish;
    if (key === "manuscriptLang") return true;
    return isEnglish;
  });

  const status = settingsStatus(keys, detectedSettings, settledSettings);
  const unanswered = waitingKeys(keys, detectedSettings, settledSettings);
  const waiting = unanswered.length;

  // What the collapsed line says Betty settled on.
  const summary = keys
    .map((key) => {
      if (key === "manuscriptLang")
        return isKnownLang ? t(`lang_${manuscriptLang}`) : manuscriptLang;
      if (key === "englishDialect")
        return t(
          copyEditOptions.englishDialect === "british"
            ? "opt_british"
            : "opt_american",
        );
      if (key === "oxfordComma")
        return copyEditOptions.oxfordComma ? t("opt_oxfordComma") : null;
      if (key === "introductoryComma")
        return copyEditOptions.introductoryComma
          ? t("opt_introductoryComma")
          : null;
      if (key === "danishComma")
        return t(
          copyEditOptions.danishComma === "nyt"
            ? "opt_nytKomma"
            : "opt_grammatiskKomma",
        );
      return null;
    })
    .filter(Boolean)
    .join(" · ");

  return { keys, status, waiting, unanswered, summary, isKnownLang };
}

export default function ManuscriptSettings({ card }: { card: FrontCard }) {
  const {
    lang,
    manuscriptLang,
    setManuscriptLang,
    copyEditOptions,
    setCopyEditOption,
    detectedSettings,
    settledSettings,
    settleSettings,
  } = useStore();
  const t = useTranslation(lang);
  const { keys, status, waiting, unanswered, summary, isKnownLang } =
    useManuscriptSettingsState(card);

  const badgeFor = (key: SettingKey, current: unknown) => (
    <DetectionBadge
      detection={detectedSettings?.[key]}
      current={current}
      settled={settledSettings.includes(key)}
      lang={lang as Lang}
    />
  );
  // Touching a control answers its question — the same value again is a
  // confirmation, which is what the author opened the panel to give.
  const answer = (key: SettingKey) => settleSettings([key]);

  return (
    <FoldingPanel
      title={t("ms_settings_title")}
      summary={
        status === "attention"
          ? t(waiting === 1 ? "ms_needs_input_one" : "ms_needs_input").replace(
              "{n}",
              String(waiting),
            )
          : summary
      }
      status={status}
      demandsAttention={status === "attention"}
      resetKey={detectedSettings}
    >
      {keys.includes("manuscriptLang") && (
        <div className="fold-row">
          <span className="fold-label">{t("manuscript_language")}</span>
          <span className="fold-control">
            <select
              value={isKnownLang ? manuscriptLang : "other"}
              onChange={(e) => {
                setManuscriptLang(
                  e.target.value === "other" ? "" : e.target.value,
                );
                answer("manuscriptLang");
              }}
              className="lang-input"
            >
              {KNOWN_MANUSCRIPT_LANGS.map((l) => (
                <option key={l} value={l}>
                  {t(`lang_${l}`)}
                </option>
              ))}
              <option value="other">{t("lang_other")}</option>
            </select>
            {!isKnownLang && (
              <input
                type="text"
                value={manuscriptLang}
                onChange={(e) => setManuscriptLang(e.target.value)}
                placeholder={t("lang_other_placeholder")}
                className="lang-input"
              />
            )}
            {badgeFor("manuscriptLang", manuscriptLang)}
          </span>
        </div>
      )}

      {keys.includes("englishDialect") && (
        <div className="fold-row">
          <span className="fold-label">{t("opt_englishDialect")}</span>
          <span className="fold-control">
            <span className="option-toggle-group">
              <button
                type="button"
                className={`toggle-btn${copyEditOptions.englishDialect === "american" ? " active" : ""}`}
                onClick={() => {
                  setCopyEditOption("englishDialect", "american");
                  answer("englishDialect");
                }}
              >
                {t("opt_american")}
              </button>
              <button
                type="button"
                className={`toggle-btn${copyEditOptions.englishDialect === "british" ? " active" : ""}`}
                onClick={() => {
                  setCopyEditOption("englishDialect", "british");
                  answer("englishDialect");
                }}
              >
                {t("opt_british")}
              </button>
            </span>
            {badgeFor("englishDialect", copyEditOptions.englishDialect)}
          </span>
        </div>
      )}

      {keys.includes("oxfordComma") && (
        <div className="fold-row">
          <span className="fold-label">{t("opt_oxfordComma")}</span>
          <span className="fold-control">
            <span className="option-toggle-group">
              <button
                type="button"
                className={`toggle-btn${copyEditOptions.oxfordComma ? " active" : ""}`}
                onClick={() => {
                  setCopyEditOption("oxfordComma", true);
                  answer("oxfordComma");
                }}
              >
                {t("opt_yes")}
              </button>
              <button
                type="button"
                className={`toggle-btn${!copyEditOptions.oxfordComma ? " active" : ""}`}
                onClick={() => {
                  setCopyEditOption("oxfordComma", false);
                  answer("oxfordComma");
                }}
              >
                {t("opt_no")}
              </button>
            </span>
            {badgeFor("oxfordComma", copyEditOptions.oxfordComma)}
          </span>
        </div>
      )}

      {keys.includes("introductoryComma") && (
        <div className="fold-row">
          <span className="fold-label">{t("opt_introductoryComma")}</span>
          <span className="fold-control">
            <span className="option-toggle-group">
              <button
                type="button"
                className={`toggle-btn${copyEditOptions.introductoryComma ? " active" : ""}`}
                onClick={() => {
                  setCopyEditOption("introductoryComma", true);
                  answer("introductoryComma");
                }}
              >
                {t("opt_yes")}
              </button>
              <button
                type="button"
                className={`toggle-btn${!copyEditOptions.introductoryComma ? " active" : ""}`}
                onClick={() => {
                  setCopyEditOption("introductoryComma", false);
                  answer("introductoryComma");
                }}
              >
                {t("opt_no")}
              </button>
            </span>
            {badgeFor("introductoryComma", copyEditOptions.introductoryComma)}
          </span>
        </div>
      )}

      {keys.includes("danishComma") && (
        <div className="fold-row">
          <span className="fold-label">{t("opt_danishComma")}</span>
          <span className="fold-control">
            <span className="option-toggle-group">
              <button
                type="button"
                className={`toggle-btn${copyEditOptions.danishComma === "grammatisk" ? " active" : ""}`}
                onClick={() => {
                  setCopyEditOption("danishComma", "grammatisk");
                  answer("danishComma");
                }}
              >
                {t("opt_grammatiskKomma")}
              </button>
              <button
                type="button"
                className={`toggle-btn${copyEditOptions.danishComma === "nyt" ? " active" : ""}`}
                onClick={() => {
                  setCopyEditOption("danishComma", "nyt");
                  answer("danishComma");
                }}
              >
                {t("opt_nytKomma")}
              </button>
            </span>
            {badgeFor("danishComma", copyEditOptions.danishComma)}
          </span>
        </div>
      )}

      {waiting > 0 && (
        <div className="fold-confirm-row">
          <span className="small-note">{t("ms_confirm_hint")}</span>
          <button
            type="button"
            className="btn-secondary btn-small"
            onClick={() => settleSettings(unanswered)}
          >
            {t("ms_confirm_all")}
          </button>
        </div>
      )}
    </FoldingPanel>
  );
}
