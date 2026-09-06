// ── Confusable-word detection ──
//
// The one error class nothing in the stack could see. Benchmarking stress100
// (sample_texts/run_mode_bench_results.txt) found seven planted errors missed
// by EVERY layer and every model tested — the local 4B and 9B, all five
// OVHcloud candidates, and LanguageTool at its picky level:
//
//   than/then  weather/whether  write/right  allowed/aloud
//   past/passed  quiet/quite  their/there
//
// They are invisible to a dictionary because both members are perfectly good
// words, and LanguageTool's confusion rules do not cover them. Only reading
// the sentence resolves them.
//
// So this module does DETECTION only, exactly like `findSuspectWords`: it says
// "this text contains members of these confusable sets", and the editor agent
// decides in context whether the right one was used. It deliberately does NOT
// emit corrections. A list like this cannot be applied mechanically — "their"
// is correct far more often than it is wrong, and a rule that fired on every
// occurrence would produce exactly the flood of false positives that the comma
// rules produced before they were fixed.

/** Roughly ordered by how often the confusion actually occurs in prose, so
 *  that `maxSets` drops the least valuable sets rather than arbitrary ones.
 *
 *  Inclusion test: both members must be common in fiction AND genuinely
 *  confused in edited writing. Homophone pairs that are ubiquitous but almost
 *  never miswritten ("no"/"know", "one"/"won", "see"/"sea") are left out — they
 *  would fire on every chunk and spend the model's attention for nothing. */
export const CONFUSABLE_SETS: readonly (readonly string[])[] = [
  ["their", "there", "they're"],
  ["your", "you're"],
  ["its", "it's"],
  ["then", "than"],
  ["to", "too"],
  ["were", "we're", "where"],
  ["whose", "who's"],
  ["passed", "past"],
  ["quiet", "quite", "quit"],
  ["weather", "whether"],
  ["aloud", "allowed"],
  ["right", "write", "rite"],
  ["affect", "effect"],
  ["lose", "loose"],
  ["accept", "except"],
  ["breath", "breathe"],
  ["lead", "led"],
  ["threw", "through"],
  ["peace", "piece"],
  ["bare", "bear"],
  ["brake", "break"],
  ["plain", "plane"],
  ["role", "roll"],
  ["sole", "soul"],
  ["waist", "waste"],
  ["wander", "wonder"],
  ["forth", "fourth"],
  ["throne", "thrown"],
  ["tide", "tied"],
  ["rein", "reign", "rain"],
  ["pore", "pour"],
  ["peak", "peek", "pique"],
  ["straight", "strait"],
  ["taut", "taunt"],
  ["altar", "alter"],
  ["born", "borne"],
  ["coarse", "course"],
  ["desert", "dessert"],
  ["farther", "further"],
  ["faze", "phase"],
  ["hoard", "horde"],
  ["loath", "loathe"],
  ["moral", "morale"],
  ["advice", "advise"],
  ["council", "counsel"],
  ["complement", "compliment"],
  ["discreet", "discrete"],
  ["elicit", "illicit"],
  ["ensure", "insure", "assure"],
  ["lightning", "lightening"],
  ["pedal", "peddle"],
  ["personal", "personnel"],
  ["precede", "proceed"],
  ["principal", "principle"],
  ["prophecy", "prophesy"],
  ["stationary", "stationery"],
  ["cite", "site", "sight"],
  ["vain", "vane", "vein"],
  ["wretch", "retch"],
];

/**
 * The same idea in the other three bundled languages.
 *
 * Wrong-word recall is the weakest category in every language, and it was
 * weakest of all where this pass did not run: Danish scored 12% against 53%
 * for English on the ~100-error stress fixtures, because the English-only gate
 * meant nothing looked for `nogen`/`nogle` at all. Spanish scored 83% without
 * any help, since its wrong words are mostly dropped accents that stay visible
 * to a reader; Danish and German confusions are not visible that way.
 *
 * Same inclusion test as the English list: both members common in fiction AND
 * genuinely confused in edited writing. Same contract too — detection only,
 * handed to the editor agent to resolve in context. `dass` is correct far more
 * often than it is wrong, and a rule that fired on every occurrence would be
 * the comma flood again.
 */
export const CONFUSABLE_SETS_BY_LANG: Readonly<
  Record<string, readonly (readonly string[])[]>
> = {
  da: [
    // The two that Danish style guides lead with.
    ["nogen", "nogle"],
    ["ad", "af"],
    ["ligge", "lægge"],
    ["ligger", "lægger"],
    ["lå", "lagde"],
    ["synes", "syntes"],
    ["hans", "sin"],
    ["hendes", "sin"],
    ["end", "en"],
    ["der", "hvor"],
    ["vær", "hver", "værd"],
    ["selv", "selvom"],
    ["and", "ånd"],
    ["får", "for"],
    ["vores", "sit"],
    ["blandt", "iblandt"],
    ["tilbage", "til bage"],
    ["især", "i sær"],
  ],
  de: [
    // das/dass is the canonical German error; seit/seid runs it close.
    ["das", "dass"],
    ["seit", "seid"],
    ["wieder", "wider"],
    ["war", "wahr"],
    ["man", "mann"],
    ["den", "denn"],
    ["ihm", "ihn"],
    ["ihr", "ihre"],
    ["stadt", "statt"],
    ["lied", "lid"],
    ["mehr", "meer"],
    ["ende", "enge"],
    ["wart", "ward"],
    ["mahl", "mal"],
    ["lehre", "leere"],
    ["wieso", "wie so"],
    ["als", "wie"],
    ["scheinbar", "anscheinend"],
  ],
  es: [
    // Accent pairs where BOTH forms are real words, so no dictionary sees the
    // error. The fixture plants these deliberately.
    ["si", "sí"],
    ["el", "él"],
    ["tu", "tú"],
    ["mi", "mí"],
    ["se", "sé"],
    ["mas", "más"],
    ["aun", "aún"],
    ["te", "té"],
    ["de", "dé"],
    ["que", "qué"],
    ["como", "cómo"],
    ["donde", "dónde"],
    ["cuando", "cuándo"],
    ["porque", "por qué", "porqué"],
    // Homophones, the other half of Spanish wrong-word error.
    ["haber", "a ver"],
    ["hay", "ahí", "ay"],
    ["sino", "si no"],
    ["tuvo", "tubo"],
    ["echo", "hecho"],
    ["halla", "haya", "allá"],
    ["valla", "vaya", "baya"],
    ["a", "ha"],
    ["vez", "ves"],
    ["también", "tan bien"],
  ],
};

/** Normalise a caller's language tag to the key these tables use. */
function langKey(lang?: string): string {
  if (!lang) return "en";
  const base = lang.toLowerCase().split(/[-_]/)[0];
  return base || "en";
}

/** The set list for one language: English from CONFUSABLE_SETS, others here. */
function setsFor(lang?: string): readonly (readonly string[])[] {
  const key = langKey(lang);
  if (key === "en") return CONFUSABLE_SETS;
  return CONFUSABLE_SETS_BY_LANG[key] ?? [];
}

/**
 * word → every set it belongs to, per language. Built once; the sets are
 * static.
 *
 * A list rather than a single index because one word can genuinely take part
 * in two different confusions: Spanish "a" is both the preposition confused
 * with "ha" and the first token of "a ver" (confused with "haber"). A
 * one-to-one map silently kept whichever set was declared last and dropped
 * the other.
 */
const WORD_TO_SETS_BY_LANG = new Map<string, Map<string, number[]>>();
for (const key of ["en", ...Object.keys(CONFUSABLE_SETS_BY_LANG)]) {
  const sets = setsFor(key);
  const map = new Map<string, number[]>();
  for (let i = 0; i < sets.length; i++) {
    // A multi-word member ("a ver", "si no") is matched on its first token —
    // the point is only to notice the confusion is in play, and the editor
    // agent reads the sentence to decide.
    for (const word of sets[i]) {
      const token = word.split(" ")[0];
      const hit = map.get(token);
      if (hit) hit.push(i);
      else map.set(token, [i]);
    }
  }
  WORD_TO_SETS_BY_LANG.set(key, map);
}

/** Words, keeping the apostrophe so "it's" and "they're" survive as one token.
 *  Curly apostrophes are normalised first — manuscripts are full of them and
 *  "it’s" must match the same set as "it's". */
const WORD_RE = /\p{L}+(?:'\p{L}+)?/gu;

function tokenize(text: string): string[] {
  return text.replace(/[‘’ʼ]/g, "'").toLowerCase().match(WORD_RE) ?? [];
}

/**
 * The confusable sets with at least one member present in `text`, in
 * CONFUSABLE_SETS order.
 *
 * Each language gets its OWN sets, never a translation of the English ones —
 * feeding English words to a German manuscript would match a few by
 * coincidence ("die", "so") and spend the model's attention on nonsense. A
 * language with no table returns `[]`, mirroring how retextChecks.ts gates
 * itself.
 */
export function findConfusables(
  text: string,
  lang?: string,
  opts?: { maxSets?: number },
): readonly string[][] {
  const sets = setsFor(lang);
  if (sets.length === 0) return [];
  const wordToSets = WORD_TO_SETS_BY_LANG.get(langKey(lang));
  if (!wordToSets) return [];

  const present = new Set<number>();
  for (const token of tokenize(text)) {
    for (const idx of wordToSets.get(token) ?? []) present.add(idx);
  }

  const maxSets = opts?.maxSets ?? 40;
  const out: string[][] = [];
  for (let i = 0; i < sets.length && out.length < maxSets; i++) {
    if (present.has(i)) out.push([...sets[i]]);
  }
  return out;
}
