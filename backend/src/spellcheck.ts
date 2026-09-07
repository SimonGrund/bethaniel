// ── Deterministic spell-checker (Hunspell, compiled to WebAssembly) ──
// Runs alongside the LLM editor. Can either feed suspect words as hints
// or directly generate Correction[] objects using Hunspell suggestions.
//
// This used nspell, a reimplementation of Hunspell in JavaScript, and paid for
// it twice in bugs that only showed up in one language each:
//
//   - Danish lost 26,232 entries, because nspell does not strip the
//     morphological tags Hunspell allows after a headword, so `den al:dens`
//     was indexed whole and plain `den` was unknown.
//   - German lost 87,955, because nspell keeps only one of a lowercase/
//     capitalised pair and German capitalises every noun, so `kommen` collided
//     with `Kommen` and lost.
//
// Both were worked around here. Neither workaround is needed now, and a third
// limitation could not have been worked around at all: nspell does not
// implement COMPOUNDRULE, so every novel compound in a compounding language
// was reported as a misspelling — `messinglup`, `rådhusarkivet`,
// `Werkstattfenster`. That is not an edge case in Danish or German, it is how
// the languages build words.
//
// hunspell-asm is Hunspell itself compiled to WebAssembly: same engine, same
// .aff/.dic semantics, no native module to build per platform. Measured on the
// clean stress fixtures, unique words wrongly flagged:
//
//   language   nspell (with both workarounds)   hunspell
//   English                                 3          3
//   Danish                                  3          0
//   German                                 71          5
//   Spanish                                 4          4
//
// The remaining flags are invented proper nouns and coined compounds, which a
// dictionary is right not to know.
//
// One constraint comes with it: Hunspell reads a dictionary's encoding from its
// own `SET` line and expects words in that encoding, so de_DE was converted
// from ISO-8859-1 to UTF-8 (SET line included) rather than decoded at load.
// Every bundled dictionary is now UTF-8.

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

import type { Correction } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
 * The WebAssembly module, once loaded.
 *
 * Loading it is the only async step; creating a dictionary from it is
 * synchronous, so `initSpellchecker()` runs once at startup and every caller
 * below keeps the synchronous API it always had. If startup never ran, or the
 * module failed to load, `loadDict` returns null and the spell pass degrades
 * to a no-op exactly as it already does for a missing dictionary.
 */
let hunspellFactory: {
  mountBuffer: (contents: Uint8Array, fileName?: string) => string;
  unmount: (path: string) => void;
  create: (affPath: string, dictPath: string) => {
    spell: (word: string) => boolean;
    suggest: (word: string) => string[];
    dispose: () => void;
  };
} | null = null;

/**
 * Load the Hunspell WebAssembly module. Call once, at startup, before any
 * spell-checking. Safe to call twice; the second call is a no-op.
 */
export async function initSpellchecker(): Promise<boolean> {
  if (hunspellFactory) return true;
  try {
    const mod = (await import("hunspell-asm")) as unknown as {
      loadModule: () => Promise<typeof hunspellFactory>;
      default?: { loadModule: () => Promise<typeof hunspellFactory> };
    };
    const loadModule = mod.loadModule ?? mod.default?.loadModule;
    if (!loadModule) throw new Error("hunspell-asm exposes no loadModule");
    hunspellFactory = await loadModule();
    return true;
  } catch (err) {
    console.warn("[spellcheck] Hunspell failed to load; spell-check is off:", err);
    hunspellFactory = null;
    return false;
  }
}

/** Whether the spell pass can run. False if the WebAssembly module failed. */
export function isSpellcheckReady(): boolean {
  return hunspellFactory !== null;
}

// Initialising on import would be tidier — the module would own its own
// readiness and no caller could get the order wrong. It is not available:
// top-level await forces the module async, and tsx transforms these files to
// CJS for the benchmark scripts, which then fails outright with
// ERR_REQUIRE_ASYNC_MODULE. So initialisation stays explicit, and the guard
// below makes a missed call loud instead of silent.

/** Warn once, not once per word, if someone forgot to initialise. */
let warnedUninitialised = false;

function loadDict(dictName: string): SpellDict | null {
  const cached = cache.get(dictName);
  if (cached) return cached;
  if (!hunspellFactory) {
    // Every function in this file is synchronous and silently returns "no
    // problems found" without a dictionary, so a missed initSpellchecker()
    // would look exactly like clean prose. Say so instead.
    if (!warnedUninitialised) {
      warnedUninitialised = true;
      console.warn(
        "[spellcheck] Not initialised — every spell check will find nothing. " +
          "Call `await initSpellchecker()` at startup before editing.",
      );
    }
    return null;
  }

  const affPath = path.join(DICT_DIR, `${dictName}.aff`);
  const dicPath = path.join(DICT_DIR, `${dictName}.dic`);

  try {
    // Hunspell parses the .aff and .dic itself, encoding included — the bytes
    // go in untouched. Both stay mounted for the process lifetime because the
    // instance reads from them lazily; unmounting would pull the dictionary
    // out from under it.
    const aff = hunspellFactory.mountBuffer(fs.readFileSync(affPath), `${dictName}.aff`);
    const dic = hunspellFactory.mountBuffer(fs.readFileSync(dicPath), `${dictName}.dic`);
    const h = hunspellFactory.create(aff, dic);
    const instance: SpellDict = {
      correct: (word) => h.spell(word),
      suggest: (word) => h.suggest(word),
    };
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


/**
 * Levenshtein distance, abandoned once it exceeds `max` — callers only ever
 * ask "is this close enough", never "how far exactly".
 */
function boundedDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Does an unknown word at least *begin* with a real word, in a language that
 * compounds? `siebzehnzähnige` is siebzehn + zähnig: the head is plainly a
 * word, the tail an adjective form the dictionary never lists. Full
 * decomposition fails, so the word is still reported — but it is far more
 * likely a coinage than a typo, and the suggestion for it (`siebzehnjährige`,
 * two edits away and a different meaning entirely) must not be offered with
 * the confidence of a fix for "teh".
 */
export function hasKnownCompoundHead(
  word: string,
  lang: string,
  dict: Pick<SpellDict, "correct">,
): boolean {
  if (!COMPOUNDING_LANGS.has(lang.slice(0, 2).toLowerCase())) return false;
  const w = word.toLowerCase();
  if (w.length < 8) return false;
  for (let i = 4; i <= w.length - 4; i++) {
    const head = w.slice(0, i);
    if (dict.correct(head) || dict.correct(head[0].toUpperCase() + head.slice(1))) {
      return true;
    }
  }
  return false;
}

/**
 * Is a Hunspell suggestion close enough to propose as a fix?
 *
 * Hunspell's suggest() is built for a human choosing from a list; taking the
 * first entry and presenting it as the correction turned unknown-but-valid
 * words into confident, wrong substitutions. Measured on the clean German
 * fixture: siebzehnzähnige -> siebzehnjährige (seventeen-TOOTHED becoming
 * seventeen-YEAR-OLD), tintenfleckigen -> grünfleckigen, Zehntelgrad ->
 * Zehntelegrad. Flagging those words is defensible — the dictionary really
 * does not know them. Rewriting them is not.
 *
 * Two things disqualify a suggestion:
 *
 *  - It splits the word where every part is itself a real word of 3+
 *    characters. That is a coined compound the dictionary has not enumerated
 *    ("woodsmoke", "inconfundiblemente"), not a typo. The 3-character floor
 *    keeps genuine fixes like "alot" -> "a lot", where "a" is no morpheme.
 *  - It is too far away to be a slip of the fingers. Real typos sit within an
 *    edit or two; the tolerance grows a little with length so long compounds
 *    are not judged more harshly than short words, but never below 2.
 */
export function isConfidentSuggestion(
  original: string,
  suggestion: string,
  dict: Pick<SpellDict, "correct">,
): boolean {
  if (!suggestion || suggestion === original) return false;

  const splitsWord = /[\s\u00a0-]/.test(suggestion) && !/[\s\u00a0-]/.test(original);
  if (splitsWord) {
    const parts = suggestion.split(/[\s\u00a0-]+/).filter(Boolean);
    const everyPartIsAWord =
      parts.length >= 2 &&
      parts.every((p) => p.length >= 3 && dict.correct(p.toLowerCase()));
    if (everyPartIsAWord) return false;
  }

  const tolerance = Math.max(2, Math.floor(original.length * 0.2));
  return (
    boundedDistance(original.toLowerCase(), suggestion.toLowerCase(), tolerance) <=
    tolerance
  );
}

/**
 * Languages that build new words by gluing existing ones together, where a
 * dictionary miss is the normal case rather than a signal. Hunspell's own
 * COMPOUNDRULE covers much of this, but never every coinage an author invents.
 */
const COMPOUNDING_LANGS = new Set(["de", "da", "nl", "sv", "no", "nb", "nn", "fi"]);

/**
 * Does this unknown word decompose into real words — i.e. is it a coined
 * compound rather than a misspelling?
 *
 * The distance guard cannot answer this. On the clean German fixture
 * `Zehntelgrad` -> `Zehntelegrad` is one edit away and `siebzehnzähnige` ->
 * `siebzehnjährige` is two, so both read as ordinary typos while actually
 * rewriting "tenth of a degree" and "seventeen-toothed" into something else.
 * What they have in common is not distance, it is that the original is a
 * perfectly good compound the dictionary never enumerated.
 *
 * Restricted to compounding languages, and to parts of 3+ characters, so an
 * English missing-space typo ("in the", "there is") is still caught — those
 * split on a part far too short to be a compound element.
 */
export function isValidCompound(word: string, lang: string, dict: SpellDict): boolean {
  if (!COMPOUNDING_LANGS.has(lang.slice(0, 2).toLowerCase())) return false;
  const w = word.toLowerCase();
  if (w.length < 8) return false;

  // German capitalises every noun, so a compound's parts live in the
  // dictionary capitalised — `Zehntel`, `Grad`, `Tinte` — while the compound
  // itself is lowercased mid-word. Checking only the lowercase form finds
  // nothing at all in exactly the language this matters most for.
  const known = (part: string) =>
    dict.correct(part) || dict.correct(part[0].toUpperCase() + part.slice(1));

  // Linking morphemes ("Fugenlaute") glue German and Danish compounds
  // together and belong to neither part: Tinte|n|fleckig, Arbeit|s|tag.
  const LINKERS = ["", "s", "n", "en", "es", "er"];

  for (let i = 3; i <= w.length - 3; i++) {
    const head = w.slice(0, i);
    if (!known(head)) continue;
    for (const link of LINKERS) {
      const tail = w.slice(i);
      if (!tail.startsWith(link)) continue;
      const rest = tail.slice(link.length);
      if (rest.length >= 3 && known(rest)) return true;
    }
  }
  return false;
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
 * Languages that capitalise every common noun, not just proper nouns.
 *
 * German is the one bundled here. Luxembourgish does it too; Danish stopped in
 * 1948 and Swedish in the 1900s, so neither belongs.
 */
const NOUN_CAPITALISING_LANGS = new Set(["de", "de_DE", "lb"]);

/** Does this language capitalise common nouns, not just proper ones? */
function capitalisesNouns(lang?: string): boolean {
  const base = lang?.toLowerCase().split(/[-_]/)[0];
  return !!base && NOUN_CAPITALISING_LANGS.has(base);
}

/**
 * Words that appear capitalized somewhere OTHER than a sentence start are
 * treated as proper nouns everywhere (returned lowercased). This lets a
 * character name that also happens to open a sentence stay protected, while a
 * capitalized misspelling that only ever appears at a sentence start remains a
 * correction candidate.
 *
 * German breaks the premise. The heuristic reads "capitalised mid-sentence" as
 * "probably a name", which holds in English, Danish and Spanish — and in German
 * describes every noun in the language. Measured on the German stress fixture,
 * it skipped 27 of 27 capitalised planted misspellings: `Zederholz`,
 * `Wolcken`, `Übersetztung` and the rest were all read as names and never
 * flagged, which is most of why German misspelling recall sat at 49% while the
 * dictionary itself rejected all 44 planted words.
 *
 * So for a noun-capitalising language the signal has to be something else, and
 * recurrence is the honest one: a character name comes back — Almut, Konrad,
 * Rothenfels appear throughout — while a typo is almost always a one-off. Two
 * or more occurrences protects the names and exposes the typos. Everywhere
 * else the original rule stands, because there capitalisation really is the
 * signal.
 */
function collectMidSentenceCapitals(text: string, lang?: string): Set<string> {
  const minOccurrences = capitalisesNouns(lang) ? 2 : 1;

  const counts = new Map<string, number>();
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text)) !== null) {
    const w = m[0];
    if (!isCapitalized(w)) continue;
    if (isSentenceInitial(text, m.index)) continue;
    const key = normalizeApostrophes(w).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const names = new Set<string>();
  for (const [word, n] of counts) {
    if (n >= minOccurrences) names.add(word);
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
  // The language matters: in German a mid-sentence capital is every noun.
  const nameSet = collectMidSentenceCapitals(text, lang);
  const nounCapitalising = capitalisesNouns(lang);

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
    //
    // "Usually proper nouns" is what German breaks: there a mid-sentence
    // capital is every common noun, so protecting them outright hid 27 of the
    // 27 capitalised misspellings planted in the German fixture — Zederholz,
    // Wolcken, Übersetztung — even though the dictionary rejected all of them.
    // For a noun-capitalising language the recurrence check in
    // collectMidSentenceCapitals carries the protection instead: a name comes
    // back, a typo does not.
    if (isCapitalized(word)) {
      if (!nounCapitalising && !isSentenceInitial(text, match.index)) continue;
      if (nameSet.has(lower)) continue;
    }

    seen.add(lower);

    if (!dict.correct(norm)) {
      // A valid hyphenated compound isn't a spelling error at all — the
      // dictionary just doesn't enumerate every compound, and the choice
      // between "iron-clad" and "ironclad" is style, not correctness.
      if (isValidHyphenCompound(norm, dict)) continue;

      // Prefer a suggestion we can stand behind. Where none qualifies the word
      // is still reported — an unrecognised word is worth the author's eye —
      // but the substitution is a guess, so it carries the low-confidence tag
      // rather than being offered with the same authority as a plain typo fix.
      const suggestions = dict.suggest(norm);
      const confident = suggestions.find((sg) =>
        isConfidentSuggestion(norm, sg, dict),
      );
      const corrected = confident ?? suggestions[0] ?? word;
      const correction: Correction = { original: word, corrected };
      // An unhyphenated coinage in a compounding language is still worth
      // reporting — `Zederholz` is a real slip for `Zedernholz` — but it must
      // not carry the authority of a fix for "teh". Decomposable words and
      // words that merely start with one are downgraded, not skipped: the
      // flag is defensible, the rewrite is not.
      const unverifiedSuggestion =
        (!confident && corrected !== word) ||
        isValidCompound(norm, lang, dict) ||
        hasKnownCompoundHead(norm, lang, dict);
      // Tagged distinctly (not the plain "spell-check" reason) so it's
      // surfaced as a minor suggestion rather than a publication blocker —
      // an unrecognized-but-plausible inflection is a much weaker signal
      // than an outright non-word like "amd" or "whe".
      if (isValidInflection(norm, dict) || unverifiedSuggestion) {
        correction.reason = "spell-check-uncommon";
      }
      corrections.push(correction);
      if (corrections.length >= maxHints) break;
    }
  }

  return corrections;
}
