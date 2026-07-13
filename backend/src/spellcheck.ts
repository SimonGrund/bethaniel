// ── Deterministic spell-checker (Hunspell via nspell) ──
// Runs alongside the LLM editor. Can either feed suspect words as hints
// or directly generate Correction[] objects using Hunspell suggestions.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

import type { Correction } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const DICT_DIR = path.resolve(
  process.env.DICTIONARIES_DIR ?? path.resolve(__dirname, "../dictionaries"),
);

// ── Language → file-prefix mapping ──
const LANG_MAP: Record<string, string> = {
  american: "en_US",
  british: "en_GB",
  us: "en_US",
  gb: "en_GB",
  da: "da_DK",
  de: "de_DE",
  es: "es_ES",
};

// We expect the LLM UI language to match the text language. If the user
// edits a Danish manuscript they must have `lang: "da"` in the store,
// and we map that to `da_DK`. For English manuscripts the copy-edit
// dialect (american / british) drives which dictionary we load.
function langToDictName(lang: string, englishDialect?: string): string | null {
  if (lang === "en" || lang === "en_US" || lang === "en_GB") {
    const d = englishDialect ?? "american";
    return LANG_MAP[d] ?? LANG_MAP.american;
  }
  return LANG_MAP[lang] ?? null;
}

// ── Lazy-loaded, per-language cache ──
interface SpellDict {
  correct: (word: string) => boolean;
  suggest: (word: string) => string[];
}

const cache = new Map<string, SpellDict>();

function loadDict(dictName: string): SpellDict | null {
  const cached = cache.get(dictName);
  if (cached) return cached;

  const affPath = path.join(DICT_DIR, `${dictName}.aff`);
  const dicPath = path.join(DICT_DIR, `${dictName}.dic`);

  try {
    const aff = fs.readFileSync(affPath, "utf-8");
    const dic = fs.readFileSync(dicPath, "utf-8");
    // Dynamic import of nspell — avoids requiring it at import time
    // (keeps startup fast when spell-check is disabled).
    const nspell = _require("nspell") as (
      aff: string,
      dic: string,
    ) => SpellDict;
    const instance = nspell(aff, dic);
    cache.set(dictName, instance);
    return instance;
  } catch (err) {
    console.warn(`[spellcheck] Failed to load dictionary ${dictName}:`, err);
    return null;
  }
}

// ── Tokenization helpers ──

// Word tokens include typographic apostrophes (’ U+2019, ʼ U+02BC) so a
// contraction like "hadn’t" is one token, not the stem "hadn" — the stem
// isn't a dictionary word, and Hunspell's suggestion for it ("hadj" in
// en_GB) turns into a corrupting correction.
const WORD_RE = /\p{L}[\p{L}'’ʼ-]*[\p{L}]/gu;

/** Dictionaries and SKIP_WORDS use the straight apostrophe; manuscripts
 *  usually use ’. Normalize before any lookup. */
function normalizeApostrophes(word: string): string {
  return word.replace(/[’ʼ]/g, "'");
}

/**
 * Words we never flag. Many of these are legitimate words that aren't in
 * the base Hunspell dictionary but are common in fiction (dialogue tags,
 * interjections, informal contractions). We also skip single letters
 * (possessives like "s'" ) and purely numeric tokens.
 */
const SKIP_WORDS = new Set([
  "ain't", "couldn't", "didn't", "doesn't", "don't", "hadn't",
  "hasn't", "haven't", "isn't", "mightn't", "mustn't", "needn't",
  "oughtn't", "shan't", "shouldn't", "wasn't", "weren't",
  "won't", "wouldn't", "y'all", "ain'tcha", "whatcha", "gonna",
  "wanna", "gotta", "lemme", "gimme", "kinda", "sorta", "outta",
  "'twas", "'tis", "'tweren't", "ma'am", "o'clock", "y'know",
  "ok", "okay", "yeah", "nah", "uh", "um", "hmm", "er",
  "aye", "nay", "whoa", "ow", "ouch", "ooh", "aah",
]);

function isLikelyProperNoun(word: string): boolean {
  // Single capital letter + rest lowercase → probably a proper noun
  return /^[A-Z][a-z]+$/.test(word);
}

function isSkipWord(word: string): boolean {
  if (word.length < 3) return true;
  if (/^\d+/.test(word)) return true;
  if (SKIP_WORDS.has(normalizeApostrophes(word).toLowerCase())) return true;
  return false;
}

// ── Public API ──

export interface SpellCheckResult {
  lang: string;
  dictName: string;
  suspectWords: string[];
}

/**
 * Scan `text` for words that aren't in the Hunspell dictionary for
 * `lang`. Returns a deduplicated list (at most `maxHints` entries)
 * of suspect words, skipping proper nouns, style-guide character names,
 * and common informal words.
 *
 * If the dictionary can't be loaded (missing file, bad lang), returns
 * an empty suspect list and logs a warning — the editor just runs
 * without spell hints.
 */
export function findSuspectWords(
  text: string,
  lang: string,
  opts?: {
    englishDialect?: string;
    styleGuideNames?: string[];
    maxHints?: number;
  },
): SpellCheckResult {
  const dictName = langToDictName(lang, opts?.englishDialect);
  const result: SpellCheckResult = {
    lang,
    dictName: dictName ?? "none",
    suspectWords: [],
  };

  if (!dictName) {
    console.warn(`[spellcheck] No dictionary for lang="${lang}"`);
    return result;
  }

  const dict = loadDict(dictName);
  if (!dict) return result;

  const maxHints = opts?.maxHints ?? 75;
  const styleNames = new Set(
    (opts?.styleGuideNames ?? []).flatMap((n) =>
      n
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  const seen = new Set<string>();
  const suspects: string[] = [];

  // Reset lastIndex (global regex state) before using exec
  WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_RE.exec(text)) !== null) {
    const word = match[0];
    const lower = normalizeApostrophes(word).toLowerCase();

    if (isSkipWord(word)) continue;
    if (seen.has(lower)) continue;
    if (styleNames.has(lower)) continue;
    if (isLikelyProperNoun(word)) continue;

    seen.add(lower);

    if (!dict.correct(normalizeApostrophes(word))) {
      suspects.push(word);
      if (suspects.length >= maxHints) break;
    }
  }

  result.suspectWords = suspects;
  return result;
}

/**
 * Build a predicate that returns `true` when a word is acceptable — i.e. present
 * in the Hunspell dictionary for `lang`, a known skip-word (common contractions
 * and interjections), or a style-guide name. Returns `null` when no dictionary
 * is available for the language, in which case callers should skip spell-vetting
 * entirely (no behavior change).
 *
 * Unlike {@link findSuspectWords} this deliberately does NOT treat a leading
 * capital as a proper noun. The gate that consumes this validator vets the
 * `corrected` side of LLM corrections, and a sentence-initial real word that the
 * model corrupted into a non-word ("Apparently" → "Appwrently") is still
 * capitalized — honoring the proper-noun heuristic here would let exactly that
 * corruption through. Genuine names are instead covered by `styleGuideNames` and
 * by the gate only rejecting words newly introduced by a correction.
 */
export function getWordValidator(
  lang: string,
  opts?: { englishDialect?: string; styleGuideNames?: string[] },
): ((word: string) => boolean) | null {
  const dictName = langToDictName(lang, opts?.englishDialect);
  if (!dictName) return null;

  const dict = loadDict(dictName);
  if (!dict) return null;

  const styleNames = new Set(
    (opts?.styleGuideNames ?? []).flatMap((n) =>
      n
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  return (word: string): boolean => {
    if (isSkipWord(word)) return true;
    const norm = normalizeApostrophes(word);
    if (styleNames.has(norm.toLowerCase())) return true;
    return dict.correct(norm);
  };
}

/**
 * Words present in `after` but absent from `before` that the dictionary
 * rejects — i.e. misspellings *introduced* by whatever transformed `before`
 * into `after`. Used as a post-apply safety net on edited text.
 *
 * Like {@link getWordValidator} (and unlike {@link findSuspectWords}) this
 * does NOT skip capitalized words: a corrupted sentence-initial word is
 * capitalized, and genuine proper nouns already occur in `before` so they
 * can never be reported as introduced.
 *
 * Returns `null` when no dictionary is available — callers skip verification.
 */
export function findNewSuspectWords(
  before: string,
  after: string,
  lang: string,
  opts?: { englishDialect?: string; styleGuideNames?: string[] },
): string[] | null {
  const dictName = langToDictName(lang, opts?.englishDialect);
  if (!dictName) return null;

  const dict = loadDict(dictName);
  if (!dict) return null;

  const styleNames = new Set(
    (opts?.styleGuideNames ?? []).flatMap((n) =>
      n
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  const beforeWords = new Set<string>();
  WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_RE.exec(before)) !== null) {
    beforeWords.add(normalizeApostrophes(match[0]).toLowerCase());
  }

  const seen = new Set<string>();
  const introduced: string[] = [];
  WORD_RE.lastIndex = 0;
  while ((match = WORD_RE.exec(after)) !== null) {
    const word = match[0];
    const lower = normalizeApostrophes(word).toLowerCase();
    if (beforeWords.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    if (isSkipWord(word)) continue;
    if (styleNames.has(lower)) continue;
    if (!dict.correct(normalizeApostrophes(word))) introduced.push(word);
  }

  return introduced;
}

/**
 * Like findSuspectWords, but also returns a Correction[] with the top
 * Hunspell suggestion for each suspect word.  These corrections can be
 * merged directly into the editor/reviewer pipeline so the user sees
 * every spell-check hit in the accept/dismiss list.
 */
export function getSpellCorrections(
  text: string,
  lang: string,
  opts?: {
    englishDialect?: string;
    styleGuideNames?: string[];
    maxHints?: number;
  },
): Correction[] {
  const dictName = langToDictName(lang, opts?.englishDialect);
  if (!dictName) return [];

  const dict = loadDict(dictName);
  if (!dict) return [];

  const maxHints = opts?.maxHints ?? 30;
  const styleNames = new Set(
    (opts?.styleGuideNames ?? []).flatMap((n) =>
      n
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  const corrections: Correction[] = [];
  const seen = new Set<string>();

  WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD_RE.exec(text)) !== null) {
    const word = match[0];
    const norm = normalizeApostrophes(word);
    const lower = norm.toLowerCase();

    if (isSkipWord(word)) continue;
    if (seen.has(lower)) continue;
    if (styleNames.has(lower)) continue;
    if (isLikelyProperNoun(word)) continue;

    seen.add(lower);

    if (!dict.correct(norm)) {
      const suggestions = dict.suggest(norm);
      const corrected = suggestions.length > 0 ? suggestions[0] : word;
      corrections.push({ original: word, corrected });
      if (corrections.length >= maxHints) break;
    }
  }

  return corrections;
}
