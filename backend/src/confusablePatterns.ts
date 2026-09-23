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
// MEASURED (2026-09-23):
//   planted sentences caught          27/27  (10 English, 17 Danish)
//   English, 203,000 words                0
//   Danish, old corpus, 337,489 words     4  all da-i-saer, all archaic
//   Danish, MODERN, 111,661 words         0  see THE DANISH CORPUS below
//
// The bar for adding one is those numbers, and the tests that enforce it are
// confusableCorpus.test.ts. (Counts are whitespace-split words, the same way
// the scoring script counts them — an earlier note said 333,455 for the old
// Danish corpus, which was the same text tokenised by word-regex instead.)
//
// THE DANISH CORPUS, and why there are three of it. The only public-domain
// Danish is 19th and early-20th century — `aa` for `å`, capitalised nouns,
// older usage — so a zero-hit result there was weaker evidence than the
// English side, which is contemporary. Two modern corpora were added rather
// than one, because neither is sufficient alone:
//
//   old    337,489 words  public domain, 19th/early-20th century
//   wiki    25,554 words  contemporary human Danish (Wikipedia) — but
//                         encyclopedic, so dialogue-shaped patterns like
//                         da-hver-saa-god barely get the chance to fire
//   mt      86,107 words  Betty's own Danish, a cloud translation of a real
//                         novel — fiction WITH dialogue, the register the
//                         patterns were built for, but machine-produced and
//                         so more standardised than a human author's prose
//
// All seventeen patterns fire ZERO times on both modern corpora, 111,661
// words between them. da-i-saer's four hits are all in the old corpus and all
// archaic ("i sær indre Bevægelse", and 17th-century spelling from Leonora
// Christina); in modern Danish `i sær` is an error, which is why it is kept.
//
// What is still missing, and would be the ideal corpus: human-written MODERN
// Danish FICTION. It is not in the public domain and none was available.

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
  // ── og / at — the error Danish style guides lead with ──
  {
    id: "da-lide-og",
    lang: "da",
    source: `\\b(?:lide|lyst til)\\s+og\\s+${DA_INFINITIVE}\\b`,
    wrong: "og",
    right: "at",
    note: 'Infinitiv styres af "at", ikke "og".',
    planted: "Jeg kan godt lide og læse bøger om aftenen.",
  },
  {
    id: "da-for-og",
    lang: "da",
    source: `\\bfor\\s+og\\s+${DA_INFINITIVE}\\b`,
    wrong: "og",
    right: "at",
    note: 'Hensigt udtrykkes med "for at".',
    planted: "Han gik ud for og hente vand ved brønden.",
  },
  {
    id: "da-verb-og",
    lang: "da",
    // Inflected forms only: a bare stem like "forsøg" is also a noun, and
    // "et sidste Forsøg og skrive" matched when stems were listed.
    source: `\\b(?:begynder|begyndte|prøver|prøvede|forsøger|forsøgte|nægter|nægtede|lover|lovede|beslutter|besluttede|glemmer|glemte|husker|huskede|ønsker|ønskede|lærer|lærte)\\s+og\\s+${DA_INFINITIVE}\\b`,
    wrong: "og",
    right: "at",
    note: 'Disse verber styrer infinitiv med "at".',
    planted: "Han begyndte og græde ved bordet.",
  },
  // ── end / en ──
  {
    id: "da-komparativ-en",
    lang: "da",
    // Narrowed to a following PRONOUN: "snarere en Grød" and "større en Dag"
    // are a comparative plus an article and perfectly correct.
    source:
      "\\b(?:mere|mindre|bedre|værre|større|hurtigere|langsommere|ældre|yngre|højere|lavere|flere|færre|anderledes)\\s+en\\s+(?:jeg|du|han|hun|vi|de|mig|dig|ham|hende|os|jer|dem|sin|sit|sine|min|din|hans|hendes|vores|deres)\\b",
    wrong: "en",
    right: "end",
    note: 'Sammenligning bruger "end".',
    planted: "Han var større en ham.",
  },
  // ── hver / vær / værd ──
  {
    id: "da-vaer-gang",
    lang: "da",
    source:
      "\\b(?:vær|værd)\\s+(?:gang|dag|uge|måned|morgen|aften|nat|time|år)\\b",
    wrong: "vær",
    right: "hver",
    note: '"hver gang", ikke "vær gang".',
    planted: "Vær gang han kom, sang hun for ham.",
  },
  {
    id: "da-hver-saa-god",
    lang: "da",
    source: "\\bhver\\s+så\\s+(?:god|venlig|artig)\\b",
    wrong: "hver",
    right: "vær",
    note: '"vær så god" er imperativ af "være".',
    planted: "Hver så god, sagde hun og rakte ham brødet.",
  },
  // ── the three transitive/intransitive pairs ──
  {
    id: "da-ligge-maerke",
    lang: "da",
    source: "\\bligge\\s+mærke\\s+til\\b",
    wrong: "ligge",
    right: "lægge",
    note: 'Det faste udtryk er "lægge mærke til".',
    planted: "Han kunne ikke ligge mærke til nogen forskel.",
  },
  {
    id: "da-ligge-objekt",
    lang: "da",
    source:
      "\\b(?:vil|ville|skal|skulle|kan|kunne|må|måtte|at)\\s+ligge\\s+(?:den|det|dem|sig|bogen|hånden|brevet|hovedet)\\b",
    wrong: "ligge",
    right: "lægge",
    note: 'Med objekt er verbet "lægge"; "ligge" er intransitivt.',
    planted: "Han ville ligge bogen på bordet ved vinduet.",
  },
  {
    id: "da-sidde-objekt",
    lang: "da",
    source:
      "\\b(?:vil|ville|skal|skulle|kan|kunne|må|måtte|at)\\s+sidde\\s+(?:den|det|dem|sig|barnet|koppen|kanden)\\b",
    wrong: "sidde",
    right: "sætte",
    note: 'Med objekt er verbet "sætte"; "sidde" er intransitivt.',
    planted: "Han ville sidde koppen på bordet ved vinduet.",
  },
  {
    id: "da-staa-objekt",
    lang: "da",
    source:
      "\\b(?:vil|ville|skal|skulle|kan|kunne|må|måtte|at)\\s+stå\\s+(?:den|det|dem|bogen|flasken|kurven)\\b",
    wrong: "stå",
    right: "stille",
    note: 'Med objekt er verbet "stille"; "stå" er intransitivt.',
    planted: "Han ville stå flasken ind i skabet igen.",
  },
  // ── nogen / nogle ──
  {
    id: "da-nogen-gange",
    lang: "da",
    source: "\\bnogen\\s+gange\\b",
    wrong: "nogen",
    right: "nogle",
    note: 'Flertal tager "nogle".',
    planted: "Han kom nogen gange om ugen.",
  },
  // ── mand / man ──
  {
    id: "da-mand-modal",
    lang: "da",
    source:
      "(?:^|(?<=[.!?]\\s)|(?<=\\n))[Mm]and\\s+(?:kan|skal|vil|må|bør|ved|siger)\\b",
    wrong: "mand",
    right: "man",
    note: 'Uden artikel er det pronominet "man".',
    planted: "Mand kan ikke vide det på forhånd.",
  },
  // ── ad / af ──
  {
    id: "da-hen-ned-af",
    lang: "da",
    // Only these motion phrases. "ud af døren" is deliberately NOT here:
    // prescriptive Danish wants "ud ad", but "ud af" is ordinary usage and
    // the pattern fired four times on the corpus.
    source:
      "\\b(?:hen|ned)\\s+af\\s+(?:vejen|gaden|trappen|bakken|stien|gangen)\\b",
    wrong: "af",
    right: "ad",
    note: 'Bevægelse langs noget tager "ad".',
    planted: "Han gik ned af trappen.",
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
  {
    id: "da-i-saer",
    lang: "da",
    source: "\\bi\\s+sær\\b",
    wrong: "i sær",
    right: "især",
    note: '"især" skrives i ét ord.',
    planted: "Det gjaldt i sær om vinteren.",
  },
  {
    id: "da-al-tid",
    lang: "da",
    source: "\\bal\\s+tid\\b",
    wrong: "al tid",
    right: "altid",
    note: '"altid" skrives i ét ord.',
    planted: "Han var al tid træt om morgenen.",
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
