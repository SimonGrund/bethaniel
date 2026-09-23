// ── Real-word errors, caught by shape ──
//
// A dictionary cannot help with `form` for `from`, `their` for `there`, or
// `mand` for `man`: both members are real words. Two layers already try.
// LanguageTool catches about half of the English cases and NONE of the four
// canonical Danish ones, and its coverage is patchy per SENTENCE rather than
// per pair — measured on the bundled jar, it catches "on there own shelf" and
// misses "left there boots on the deck", catches "too quite" and misses
// "very quite". And confusables.ts feeds a hint into the LLM prompt, which
// makes the catch a model's decision and therefore different between two runs
// over the same text.
//
// So: narrow patterns, deterministic, each one scored twice before it is
// added — it must catch its planted sentence, and it must fire as close to
// zero as possible on real prose. Measured on 203,000 words of contemporary
// English and 333,455 words of Danish; see confusableCorpus.test.ts.
//
// These run in COPY AND LINE EDITS too, not only the readthrough, and a
// deterministic correction is pre-approved, which means it is APPLIED to the
// manuscript rather than merely reported. That is the whole reason every
// pattern is corpus-scored before it is added.
//
// WHAT THE CORPUS KILLED, so it is not re-proposed:
//
//   - `ud af (døren|vinduet)` → `ud ad` fired 4x. Prescriptive Danish wants
//     `ud ad`, but `ud af døren` is ordinary usage. A style preference, not
//     an error.
//   - `den man` → `mand` fired on "den man vil se". `den man` is a valid
//     relative construction in modern Danish too ("den man elsker"), so
//     `den` is not in the determiner list below.
//   - comparative + `en` first read "snarere en Grød" and "større en Dag" as
//     errors; both are a comparative followed by an article. It is narrowed
//     to comparative + `en` + PRONOUN, and `snarere` is gone — it takes `en`
//     legitimately.
//
// TWO TRAPS, likewise:
//
//   - Danish `og`/`at` cannot be separated by verb morphology. An exclusion
//     for past tense written as `-te` also excludes the infinitives `hente`,
//     `vente` and `lytte`. Hence a closed list of infinitives after `og`.
//   - A bare Danish verb stem is usually also a noun: `forsøg og skrive`
//     matched "et sidste Forsøg og skrive". Only INFLECTED forms are listed.
//
// CORPUS CAVEAT: the only public-domain Danish available is 19th and
// early-20th century — `aa` for `å`, capitalised nouns, older usage. A
// zero-hit result there is weaker evidence than on the English side, which is
// contemporary. The Danish patterns should be re-scored on a modern Danish
// manuscript before anyone leans on them hard.

import type { Correction } from "./types.js";

export interface ConfusablePattern {
  id: string;
  lang: "en" | "da";
  /** RegExp source. Stored as a string so every call gets a fresh lastIndex. */
  source: string;
  /** The word (or two words) inside the match that is wrong. */
  wrong: string;
  /** What it should be. */
  right: string;
  note: string;
  /** A sentence this pattern must catch. Scored by confusableCorpus.test.ts. */
  planted: string;
}

/** Danish infinitives that may follow `og` where `at` was meant. Closed, for
 *  the reason in the header: morphology cannot tell `hente` from `mødte`. */
const DA_INFINITIVE =
  "(?:græde|le|grine|gå|komme|se|høre|tale|sige|spise|drikke|sove|løbe|skrive|læse|arbejde|hjælpe|tænke|vente|hente|kigge|snakke|synge|danse|rejse|blive|tage|give|finde|lytte|spørge|svare|betale|købe|sælge)";

export const CONFUSABLE_PATTERNS: readonly ConfusablePattern[] = [
  {
    id: "form-det",
    lang: "en",
    // "form" is a noun and a verb; before a determiner it is almost always
    // "from". Excluded after a modal or auxiliary, which is the one real
    // false positive the corpus produced: "couldn't form the words".
    // The apostrophe class is ['\u2019\u02BC], not a bare '. The corpus hit was
    // "couldn\u2019t form the words" with a CURLY apostrophe, and a straight-only
    // exclusion sailed straight past it — the same straight-vs-curly gap the
    // quotation work closed one module over.
    source:
      "(?<!\\b(?:to|can|could|will|would|might|must|may|should|helps?|helped|began|begin|begins)\\s)(?<!\\b(?:could|would|should|must|might|can|do|does|did)n['\u2019\u02BC]t\\s)\\bform\\s+(?:the|a|an|his|her|their|its|my|your|our|this|that|these|those)\\b",
    wrong: "form",
    right: "from",
    note: '"form" before a determiner is almost always "from".',
    planted: "He read the letter form the king.",
  },
  {
    id: "weather-or-not",
    lang: "en",
    source: "\\bweather\\s+or\\s+not\\b",
    wrong: "weather",
    right: "whether",
    note: '"weather or not" is always "whether or not".',
    planted: "Weather or not they come, we sail.",
  },
  {
    id: "modal-of",
    lang: "en",
    source: "\\b(?:could|would|should|must|might)\\s+of\\b",
    wrong: "of",
    right: "have",
    note: 'A modal takes "have", not "of".',
    planted: "He could of told me sooner.",
  },
  {
    id: "its-a",
    lang: "en",
    source: "\\bits\\s+(?:a|an)\\s",
    wrong: "its",
    right: "it's",
    note: '"its" is possessive; before an article it is "it\'s".',
    planted: "Its a long way to the isles.",
  },
  {
    id: "intensifier-quite",
    lang: "en",
    // LanguageTool catches "too quite" and misses "very quite"; this covers
    // both, which is the point of not relying on its per-sentence coverage.
    source: "\\b(?:very|so|too|really|dead|awfully)\\s+quite\\b",
    wrong: "quite",
    right: "quiet",
    note: 'An intensifier before "quite" almost always wants "quiet".',
    planted: "The hall was very quite that evening.",
  },
  {
    id: "there-own",
    lang: "en",
    source: "\\bthere\\s+own\\b",
    wrong: "there",
    right: "their",
    note: '"their own" is the possessive.',
    planted: "They left there own boots behind.",
  },
  {
    id: "their-be",
    lang: "en",
    source: "\\btheir\\s+(?:is|are|was|were)\\b",
    wrong: "their",
    right: "there",
    note: '"there is/are" is the existential.',
    planted: "Their is a ship on the horizon.",
  },
  {
    id: "loose-verb",
    lang: "en",
    source: "\\b(?:to|will|would|might|can|could|may|must)\\s+loose\\b",
    wrong: "loose",
    right: "lose",
    note: '"loose" is the adjective; the verb is "lose".',
    planted: "We might loose the ship in this wind.",
  },
  {
    id: "then-comparative",
    lang: "en",
    source:
      "\\b(?:more|less|better|worse|bigger|smaller|taller|shorter|older|younger|faster|slower|higher|lower|greater|fewer)\\s+then\\b",
    wrong: "then",
    right: "than",
    note: 'A comparative takes "than", not "then".',
    planted: "He was taller then his brother.",
  },
  {
    id: "have-went",
    lang: "en",
    source: "\\b(?:have|has|had)\\s+went\\b",
    wrong: "went",
    right: "gone",
    note: 'The participle of "go" is "gone".',
    planted: "They have went to the harbour already.",
  },
  {
    id: "da-en-man",
    lang: "da",
    // "den" is deliberately absent — see the header.
    source: "\\b(?:en|denne|gamle|unge|store|anden|hver)\\s+man\\b",
    wrong: "man",
    right: "mand",
    note: 'Efter en artikel er det "mand", ikke pronominet "man".',
    planted: "Der stod en man ved døren.",
  },
  {
    id: "da-til-bage",
    lang: "da",
    source: "\\btil\\s+bage\\b",
    wrong: "til bage",
    right: "tilbage",
    note: '"tilbage" skrives i ét ord.',
    planted: "Han kom til bage om aftenen.",
  },
];

/** Which table applies. An absent tag is English, as elsewhere in the app. */
function tableFor(lang?: string): ConfusablePattern[] {
  const key = (lang ?? "en").toLowerCase().split(/[-_]/)[0];
  if (key !== "en" && key !== "da") return [];
  return CONFUSABLE_PATTERNS.filter((p) => p.lang === key);
}

/**
 * Replace `wrong` with `right` inside one matched span, keeping an initial
 * capital. "Weather or not" must come back as "Whether or not", not
 * "whether or not" — a correction that also changes the capitalisation reads
 * as two changes and invites the author to reject both.
 */
function substitute(span: string, wrong: string, right: string): string {
  const at = span.toLowerCase().indexOf(wrong.toLowerCase());
  if (at === -1) return span;
  const found = span.slice(at, at + wrong.length);
  const capitalised = /^\p{Lu}/u.test(found);
  const replacement = capitalised
    ? right.charAt(0).toUpperCase() + right.slice(1)
    : right;
  return span.slice(0, at) + replacement + span.slice(at + wrong.length);
}

/**
 * Corrections for the confusable phrasings this text contains.
 *
 * One correction per match, over the matched span only — never the whole
 * paragraph. The span is what makes the correction locatable and what keeps
 * two hits in one sentence from overlapping.
 */
export function findConfusablePatterns(
  text: string,
  lang?: string,
): Correction[] {
  const patterns = tableFor(lang);
  if (patterns.length === 0 || !text.trim()) return [];

  const out: Correction[] = [];
  for (const p of patterns) {
    const re = new RegExp(p.source, "giu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const original = m[0];
      const corrected = substitute(original, p.wrong, p.right);
      // A zero-length match would loop for ever. None of the patterns can
      // produce one, but the guard costs nothing.
      if (m.index === re.lastIndex) re.lastIndex++;
      if (corrected === original) continue;
      out.push({
        original,
        corrected,
        reason: `confusable:${p.id}`,
        note: p.note,
      } as Correction);
    }
  }
  return out;
}
