// ── Where to translate to ──
//
// A shortcut, not a restriction. `targetLang` is a free-text string that the
// backend interpolates straight into the prompt ("Translate the following text
// into ${targetLang}" — prompts.ts), so every language has always worked and
// still does: OTHER_LANGUAGE swaps the dropdown for the text box that used to
// be the only way in.
//
// Ten names, chosen as the languages a European novelist is most likely to be
// published in. Danish, English, German and Spanish are also the four with
// measured translation quality (docs/language-quality-roadmap.md), so the list
// cannot omit them — backend/test/translationLanguages.test.ts holds it to
// that, and to alphabetical order, since a dropdown nobody can scan is worse
// than a text box.

export const TRANSLATION_LANGUAGES = [
  "Danish",
  "Dutch",
  "English",
  "French",
  "German",
  "Italian",
  "Norwegian",
  "Portuguese",
  "Spanish",
  "Swedish",
] as const;

/**
 * The "Other…" row. A sentinel rather than a language: selecting it reveals
 * the free-text input, and it must never reach `targetLang` itself — the
 * prompt would ask for a translation into "other".
 */
export const OTHER_LANGUAGE = "__other";

/** True when a saved target is one the dropdown can show as selected. */
export function isListedLanguage(target: string): boolean {
  return (TRANSLATION_LANGUAGES as readonly string[]).includes(target.trim());
}
