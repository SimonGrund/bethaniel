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

/** word → index of the set it belongs to. Built once; the sets are static. */
const WORD_TO_SET = new Map<string, number>();
for (let i = 0; i < CONFUSABLE_SETS.length; i++) {
  for (const word of CONFUSABLE_SETS[i]) WORD_TO_SET.set(word, i);
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
 * English only — the sets are English words, and a Danish or German
 * manuscript would match a few of them by coincidence ("die", "so") and get
 * nonsense advice. Callers pass the manuscript language and get `[]` for
 * anything else, mirroring how retextChecks.ts gates itself.
 */
export function findConfusables(
  text: string,
  lang?: string,
  opts?: { maxSets?: number },
): readonly string[][] {
  if (lang && lang !== "en" && lang !== "en_US" && lang !== "en_GB") return [];

  const present = new Set<number>();
  for (const token of tokenize(text)) {
    const idx = WORD_TO_SET.get(token);
    if (idx !== undefined) present.add(idx);
  }

  const maxSets = opts?.maxSets ?? 40;
  const out: string[][] = [];
  for (let i = 0; i < CONFUSABLE_SETS.length && out.length < maxSets; i++) {
    if (present.has(i)) out.push([...CONFUSABLE_SETS[i]]);
  }
  return out;
}
