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

/**
 * Hunspell .aff/.dic pairs declare their own byte encoding via a `SET`
 * directive — most bundled dictionaries (en_US, en_GB, da_DK, es_ES) are
 * UTF-8, but de_DE's is `SET ISO8859-1` (inherited from the igerman98
 * source). Reading it as UTF-8 regardless — the previous behavior — silently
 * mangled every non-ASCII German letter (ä/ö/ü/ß) into a run of U+FFFD
 * replacement characters, which then surfaced as garbled "spell-check"
 * suggestions like "über" → "�ber". `latin1` is Node's byte-identical decode
 * for the classic single-byte Hunspell charsets (ISO8859-1, CP1252, etc.);
 * `SET` lines that name anything else fall back to `utf-8`.
 */
function detectDictEncoding(affBuffer: Buffer): BufferEncoding {
  const header = affBuffer.toString("latin1").slice(0, 512);
  const m = header.match(/^SET\s+(\S+)/im);
  const charset = m?.[1]?.toUpperCase() ?? "UTF-8";
  return /^UTF-?8$/.test(charset) ? "utf-8" : "latin1";
}

/**
 * Drop Hunspell morphological fields from a .dic, keeping `word/flags`.
 *
 * Hunspell lets a dictionary entry carry analysis tags after the word —
 * `den al:dens`, `havde st:have` (`al:` alternate form, `st:` stem, `po:`
 * part of speech, and friends). nspell does not strip them, so it indexes the
 * ENTIRE line as the word: "den al:dens" becomes a known word and plain "den"
 * does not.
 *
 * That is not a rare corner. da_DK.dic tags 26,232 entries this way, and they
 * are exactly the high-frequency ones — pronouns, auxiliaries, irregular verb
 * forms: den, sin, havde, kom, nogen, nogle, lagde. The Danish spell pass
 * therefore reported the commonest words in the language as misspellings and
 * "corrected" them into nonsense (den → gen, kom → gom, havde → hævde).
 * de_DE.dic and the English dictionaries carry no such fields, which is why
 * only Danish was affected.
 *
 * Only a trailing run of `xx:value` tags is removed, so a legitimate entry
 * containing a space is left alone.
 */
export function stripMorphologicalFields(dic: string): string {
  return dic.replace(/^(\S+)(?:[ \t]+\w\w:\S+)+$/gm, "$1");
}

/**
 * Every headword the dictionary lists as usable on its own.
 *
 * A Hunspell entry may be flagged ONLYINCOMPOUND (valid only inside a
 * compound) or NEEDAFFIX (valid only once an affix is attached). Everything
 * else is a word a writer may type as it stands.
 */
export function standaloneHeadwords(aff: string, dic: string): Set<string> {
  const onlyInCompound = aff.match(/^ONLYINCOMPOUND\s+(\S)/m)?.[1];
  const needAffix = aff.match(/^NEEDAFFIX\s+(\S)/m)?.[1];

  const out = new Set<string>();
  const lines = dic.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const slash = line.indexOf("/");
    const word = slash === -1 ? line : line.slice(0, slash);
    if (!word) continue;
    const flags = slash === -1 ? "" : line.slice(slash + 1);
    if (onlyInCompound && flags.includes(onlyInCompound)) continue;
    if (needAffix && flags.includes(needAffix)) continue;
    out.add(word);
  }
  return out;
}

/**
 * Accept a word the dictionary lists outright, even when nspell does not.
 *
 * German spellcheck rejected a third of its own dictionary. 93,148 lowercase
 * German words also exist capitalised — because German capitalises every noun,
 * so a nominalised verb or adjective collides with itself (`kommen`/`Kommen`,
 * `recht`/`Recht`, `gut`/`Gut`) — and nspell keeps only one of the pair,
 * rejecting 87,955 of them. `kommen/DIVXW` sits in de_DE.dic at line 179,634
 * and `correct("kommen")` still answers false.
 *
 * The other three dictionaries are untouched by this: Danish rejects 1 of
 * 1,240 such pairs, Spanish and English 0. Only German has enough collisions
 * for it to matter, which is why it went unnoticed.
 *
 * The damage was indirect and worse than the missing words. The spell pass
 * emitted a correction for every one of those rejected words, so a German
 * chunk arrived at the reviewer carrying dozens of bogus corrections, and real
 * misspellings drowned in them: German scored 55% on misspelling recall
 * against 85-97% for the other three languages, while its clean fixture drew
 * 43 flags.
 *
 * Merging duplicate entries' flags — the obvious fix, and what Hunspell itself
 * does — was tried and made things worse: it also accepted `haus` for `Haus`,
 * which would gut the capitalization check German scores 79-86% on. So the
 * rescue is narrower. A word is accepted only if the dictionary lists it as a
 * STANDALONE headword in that exact case. `kommen` qualifies; `haus` does not,
 * because igerman98 lists it ONLYINCOMPOUND for building `Bauernhaus`.
 *
 * `licht` does get through, but `licht` is a real German adjective — a spell
 * checker is right not to flag it.
 */
function withStandaloneHeadwords(
  dict: SpellDict,
  aff: string,
  dic: string,
): SpellDict {
  const standalone = standaloneHeadwords(aff, dic);
  return {
    correct: (word) => dict.correct(word) || standalone.has(word),
    suggest: (word) => dict.suggest(word),
  };
}

function loadDict(dictName: string): SpellDict | null {
  const cached = cache.get(dictName);
  if (cached) return cached;

  const affPath = path.join(DICT_DIR, `${dictName}.aff`);
  const dicPath = path.join(DICT_DIR, `${dictName}.dic`);

  try {
    const affRaw = fs.readFileSync(affPath);
    const encoding = detectDictEncoding(affRaw);
    const aff = affRaw.toString(encoding);
    const dic = stripMorphologicalFields(fs.readFileSync(dicPath, encoding));
    // Dynamic import of nspell — avoids requiring it at import time
    // (keeps startup fast when spell-check is disabled).
    const nspell = _require("nspell") as (
      aff: string,
      dic: string,
    ) => SpellDict;
    const instance = withStandaloneHeadwords(nspell(aff, dic), aff, dic);
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

/**
 * A hyphenated word Hunspell doesn't recognize as a single entry ("iron-clad")
 * but whose parts are each independently valid ("iron", "clad") is a
 * legitimate compound, not a typo — dictionaries are notoriously incomplete
 * on hyphenation, and hyphenated vs. solid spelling is a style choice
 * ("iron-clad" and "ironclad" are both standard English).
 */
function isValidHyphenCompound(word: string, dict: SpellDict): boolean {
  if (!word.includes("-")) return false;
  const parts = word.split("-").filter(Boolean);
  return parts.length >= 2 && parts.every((p) => p.length >= 2 && dict.correct(p));
}

/**
 * A word Hunspell doesn't recognize but whose de-pluralized base form it
 * does ("storages" → "storage") is more likely an uncommon-but-real
 * inflection than an outright typo — worth a lower-confidence tag rather
 * than the same severity as "teh"/"amd".
 */
function isValidInflection(word: string, dict: SpellDict): boolean {
  const lower = word.toLowerCase();
  const bases = [
    lower.endsWith("es") ? lower.slice(0, -2) : null,
    lower.endsWith("s") ? lower.slice(0, -1) : null,
  ].filter((b): b is string => !!b && b.length >= 3);
  return bases.some((b) => dict.correct(b));
}

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

/** First alphabetic character is an uppercase letter. */
function isCapitalized(word: string): boolean {
  const first = word[0];
  return (
    first !== undefined &&
    first === first.toUpperCase() &&
    first !== first.toLowerCase()
  );
}

// Characters that end a sentence — a capitalized word right after one of these
// is a normal sentence start (a candidate typo), not necessarily a proper noun.
const SENTENCE_TERMINATORS = new Set([".", "!", "?", "…", "\n", "\r"]);
// Characters skipped when scanning left for the previous meaningful char:
// whitespace, quotation marks, and Markdown structure/emphasis markers.
const PRE_WORD_SKIP = new Set([
  " ", "\t", "\v", "\f",
  '"', "'", "“", "”", "‘", "’",
  "*", "_", "(", "[", ">", "#", "-",
]);

/**
 * True when the word starting at `index` opens a sentence — i.e. the nearest
 * non-whitespace, non-quote, non-Markdown character before it is a sentence
 * terminator, or the word is at the very start of the text. Used to tell a
 * capitalized typo at a sentence start ("Teh cat…") from a mid-sentence proper
 * noun ("…saw Karim").
 */
function isSentenceInitial(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0) {
    const ch = text[i];
    if (PRE_WORD_SKIP.has(ch) || /\s/.test(ch)) {
      i--;
      continue;
    }
    break;
  }
  if (i < 0) return true;
  return SENTENCE_TERMINATORS.has(text[i]);
}

/**
 * Words that appear capitalized somewhere OTHER than a sentence start are
 * treated as proper nouns everywhere (returned lowercased). This lets a
 * character name that also happens to open a sentence stay protected, while a
 * capitalized misspelling that only ever appears at a sentence start remains a
 * correction candidate.
 */
function collectMidSentenceCapitals(text: string): Set<string> {
  const names = new Set<string>();
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text)) !== null) {
    const w = m[0];
    if (!isCapitalized(w)) continue;
    if (isSentenceInitial(text, m.index)) continue;
    names.add(normalizeApostrophes(w).toLowerCase());
  }
  return names;
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

  // Default is unbounded: a single run should surface EVERY misspelling in the
  // chunk, not silently stop at an arbitrary cap. Callers may still pass a cap.
  const maxHints = opts?.maxHints ?? Infinity;
  const styleNames = new Set(
    (opts?.styleGuideNames ?? []).flatMap((n) =>
      n
        .split(/[,\s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  );

  // Proper nouns to protect everywhere (see collectMidSentenceCapitals).
  const nameSet = collectMidSentenceCapitals(text);

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

    // Capitalized words are usually proper nouns. A capital MID-sentence is
    // protected outright; a capital at a SENTENCE START is a candidate typo
    // ("Teh cat…") unless the same word is used as a name elsewhere.
    if (isCapitalized(word)) {
      if (!isSentenceInitial(text, match.index)) continue;
      if (nameSet.has(lower)) continue;
    }

    seen.add(lower);

    if (!dict.correct(norm)) {
      // A valid hyphenated compound isn't a spelling error at all — the
      // dictionary just doesn't enumerate every compound, and the choice
      // between "iron-clad" and "ironclad" is style, not correctness.
      if (isValidHyphenCompound(norm, dict)) continue;

      const suggestions = dict.suggest(norm);
      const corrected = suggestions.length > 0 ? suggestions[0] : word;
      const correction: Correction = { original: word, corrected };
      // Tagged distinctly (not the plain "spell-check" reason) so it's
      // surfaced as a minor suggestion rather than a publication blocker —
      // an unrecognized-but-plausible inflection is a much weaker signal
      // than an outright non-word like "amd" or "whe".
      if (isValidInflection(norm, dict)) correction.reason = "spell-check-uncommon";
      corrections.push(correction);
      if (corrections.length >= maxHints) break;
    }
  }

  return corrections;
}
