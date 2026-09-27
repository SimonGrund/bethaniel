// ── A word the writer dropped ──
//
// "they expect us to look each other in the same place" — "for" is missing.
// Every word that IS there is spelled correctly, so Hunspell, LanguageTool and
// the confusable patterns cannot see it, and an author reads straight past it
// because their mind supplies the word.
//
// WHAT DID NOT WORK, so it is not re-proposed (measured September 2026 on the
// bundled 4B, fixture sample_texts/missing300en_*):
//
//   - Telling the copy editor to look for missing words. It added no visible
//     catches and cost confusable-word recall 12/15 → 8/15 on stress100: a
//     small model's attention is zero-sum, and a new directive displaced
//     "by than", "weather/whether", "it's/its" and "quiet/quite".
//   - Teaching the reviewer and the precision pass (a second reviewing call,
//     since removed) that an insertion can be a
//     fix. The editor already proposes some; those two passes score them 1-2
//     ("a valid elliptical construction"). A rule in their prompts rescued one
//     and leaked into unrelated verdicts — the precision pass started scoring
//     Oxford commas 2.
//   - On the chapter that prompted this, the editor never proposed the fix at
//     all, so nothing downstream of it could have helped.
//
// WHAT DOES: a pass of its own, three stages.
//
//   1. SWEEP — small batches, one question only: is a word missing? The model
//      is noisy here (≈70 candidates per 3,000 words of clean prose).
//   2. SHAPE — deterministic. Keep only a candidate that inserts exactly ONE
//      function word of the manuscript's language, with words of the original
//      on both sides of the gap, anchored at exactly one place in the chunk.
//      This removes ≈98% of the sweep. The interior rule is what kills the
//      invented endings ("that someone would." → "would do.").
//   3. VERDICT — sentence A as written, sentence B with the word inserted:
//      which is grammatical? "B" is kept. Otherwise each sentence is judged
//      alone, and A failing while B passes is kept too. A comparison is a
//      question a small model answers well; "is anything missing in this
//      passage" is not.
//
// What survives is pre-approved: the verdict IS its review, and the main
// reviewer rejects insertions on principle, which is the failure above.
//
// Measured on the bundled 4B: see backend/test/missingWords.test.ts for the
// deterministic parts, and the numbers in the commit that added this file.
import type { Correction } from "./types.js";

/**
 * The words whose absence breaks a sentence rather than shortening it:
 * prepositions, articles, infinitive markers, pronouns, auxiliaries. A
 * content word (a noun, an adjective) is never inserted — that is writing,
 * not repair. Lowercase; matched against lowercased tokens.
 *
 * Languages absent from this table are not swept at all.
 */
const FUNCTION_WORDS: Record<string, string[]> = {
  en: "a an the to for of in on at from with by into onto about as was were is are be been had has have did do does she he they it we i you her him them his its their than".split(" "),
  da: "en et den det de at for til af i på med fra om ved over under efter var er har havde blev bliver være han hun jeg du vi man sig ham hende dem sin sit sine end".split(" "),
  de: "der die das den dem des ein eine einen einem einer eines zu für von in im an am auf aus mit bei nach über unter um ist war sind waren hat hatte haben wird wurde sein er sie es ich du wir ihr man sich ihn ihm dass als".split(" "),
  es: "el la los las un una unos unas a al de del en con por para sin sobre es era fue ha había han son estaba está se lo le les me te nos que su sus yo él ella".split(" "),
  // "ne" is deliberately absent: dropping it is how French is spoken, and in
  // dialogue it is voice, not an error. Likewise English "that" and Danish
  // "som"/"der": a relative or complement word the grammar lets the writer
  // leave out ("the trees he did not recognize") can never be the missing
  // one, and the model kept proposing them.
  fr: "le la les un une des du de à au aux en dans sur sous avec par pour sans est était a avait ont sont être été se il elle ils elles je tu nous vous on lui leur que qui y".split(" "),
};

const LANG_NAMES: Record<string, string> = {
  en: "English",
  da: "Danish",
  de: "German",
  es: "Spanish",
  fr: "French",
};

/** Real dropped-word errors, per language, for the sweep prompt. */
const EXAMPLES: Record<string, [string, string][]> = {
  en: [
    ["they expect us to look each other in the same place", "look for each other"],
    ["a document she never seen", "she had never seen"],
    ["He walked the door and knocked", "walked to the door"],
  ],
  da: [
    ["Hun gik hen døren og bankede på", "hen til døren"],
    ["Hun havde glemt lukke døren", "glemt at lukke døren"],
    ["Han tænkte hele tiden sin mor", "tænkte hele tiden på sin mor"],
  ],
  de: [
    ["Sie dachte die ganze Zeit ihre Mutter", "an ihre Mutter"],
    ["Er wartete lange den Bus", "auf den Bus"],
    ["Sie hatte vergessen, Tür zu schließen", "die Tür zu schließen"],
  ],
  es: [
    ["Pensaba todo el tiempo su madre", "en su madre"],
    ["Llegó la casa muy tarde", "a la casa"],
    ["Había olvidado cerrar puerta", "cerrar la puerta"],
  ],
  fr: [
    ["Elle pensait tout le temps son frère", "à son frère"],
    ["Il est allé la gare à pied", "à la gare"],
    ["Elle avait oublié fermer la porte", "de fermer la porte"],
  ],
};

export function missingWordLanguageSupported(lang?: string): boolean {
  return (lang ?? "en") in FUNCTION_WORDS;
}

export function buildMissingWordSweepPrompt(lang = "en"): string {
  const name = LANG_NAMES[lang] ?? "English";
  const examples = (EXAMPLES[lang] ?? EXAMPLES.en)
    .map(([wrong, right]) => `- "${wrong}" → "${right}"`)
    .join("\n");
  return `You are a proofreader looking for ONE kind of error only: a word the writer accidentally dropped. The text is written in ${name}.

Writers skip over a dropped word because their mind fills it in. Read every sentence below exactly as written, word by word, and ask: is it grammatical ${name} as it stands? If a sentence is broken because a small word is missing — a preposition, an article, an infinitive marker, a pronoun, or an auxiliary/linking verb — report it.

Examples of real errors:
${examples}

NOT errors — never report these:
- Correct constructions that merely look short or elliptical
- Deliberate fragments and clipped dialogue
- Anything that is a matter of style, word choice, spelling or punctuation — that is not your job here.

Check EVERY sentence, from the first to the last — a passage can contain several dropped words, and each one goes on its own line. Do not stop after the first.

Report a sentence ONLY if you are sure a word is missing and you know which word. Never translate anything.

OUTPUT: one JSON object per line, nothing else:
{"original": "<the 2-5 words around the gap, copied verbatim>", "corrected": "<the same words with the missing word inserted>"}
If nothing is missing, output exactly: NONE`;
}

export function buildMissingWordVerdictPrompt(lang = "en"): string {
  const name = LANG_NAMES[lang] ?? "English";
  return `You check ${name} grammar. You will see two versions of one sentence, A and B. They differ by exactly one word.

Decide, for each, whether it is a grammatical ${name} sentence exactly as written — judge grammar only, not style. Fiction allows fragments and clipped dialogue, but a sentence that simply lacks a word its grammar requires is NOT grammatical.

Answer with exactly one word:
B — A is ungrammatical and B is grammatical (the added word is needed)
A — A is grammatical and B is worse or ungrammatical
BOTH — both are grammatical
NEITHER — neither is grammatical`;
}

/**
 * The fallback verdict: one sentence, grammatical or not. Asked only when the
 * A/B comparison did not answer B. On 55 hand-labelled candidates across the
 * five languages, A/B alone kept 20 of 33 real errors; A/B or this kept 25,
 * for two more let through (both in 19th-century prose).
 */
export function buildMissingWordSoloPrompt(lang = "en"): string {
  const name = LANG_NAMES[lang] ?? "English";
  return `You check ${name} grammar. You will see one sentence from a novel. Is it a grammatical ${name} sentence exactly as written? Judge grammar only, not style: fragments, dialogue and older spellings are fine, but a sentence that lacks a word its grammar requires is not. Answer with exactly one word: YES or NO.`;
}

/** Paragraph-aligned batches of about `words` words. Small on purpose:
 *  500-word batches cut fixture recall from 9 to 3 of 29. */
export function sweepBatches(text: string, words = 250): string[] {
  const paras = text.split(/\n\s*\n/);
  const out: string[] = [];
  let cur: string[] = [];
  let n = 0;
  for (const p of paras) {
    const w = p.split(/\s+/).filter(Boolean).length;
    if (n + w > words && cur.length) {
      out.push(cur.join("\n\n"));
      cur = [];
      n = 0;
    }
    cur.push(p);
    n += w;
  }
  if (cur.length) out.push(cur.join("\n\n"));
  return out.filter((b) => b.trim().length > 0);
}

/**
 * Every {"original","corrected"} object in a sweep answer; the rest is noise.
 *
 * Arrays are accepted as well as strings, because the model sends them — in
 * German more often than not, and a dropped array was a dropped find:
 *   - phrase arrays of equal length, ["Mein Vater hat so geredet", "wenn müde
 *     war"] → [..., "wenn er müde war"], pair up element by element;
 *   - word arrays, ["als","könnte","fortlaufen"], are joined with spaces and
 *     left to shapeCandidates' relaxed anchoring to find in the text.
 */
export function parseSweepOutput(raw: string): { original: string; corrected: string }[] {
  const out: { original: string; corrected: string }[] = [];
  const isStrings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
  for (const line of raw.replace(/<think>[\s\S]*?<\/think>/g, "").split("\n")) {
    const m = line.match(/\{.*\}/);
    if (!m) continue;
    try {
      const c = JSON.parse(m[0]);
      if (typeof c.original === "string" && typeof c.corrected === "string") {
        out.push({ original: c.original, corrected: c.corrected });
      } else if (isStrings(c.original) && isStrings(c.corrected)) {
        const o: string[] = c.original;
        const k: string[] = c.corrected;
        const phrases = o.some((s) => /\s/.test(s.trim()));
        if (phrases && o.length === k.length) {
          o.forEach((s, i) => {
            if (s !== k[i]) out.push({ original: s, corrected: k[i] });
          });
        } else {
          out.push({ original: o.join(" "), corrected: k.join(" ") });
        }
      }
    } catch {
      // A malformed line is one lost candidate, never a failed chunk.
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Find `original` in `chunk` when it does not occur verbatim — the model
 * joined words that the text separates with a comma, or quoted a word array —
 * and rebuild the correction against the text as actually written. Returns
 * null unless the words match exactly one place.
 */
function relaxedAnchor(
  chunk: string,
  original: string,
  corrected: string,
): { original: string; corrected: string } | null {
  const oWords = original.split(/\s+/).filter(Boolean);
  const cWords = corrected.split(/\s+/).filter(Boolean);
  if (oWords.length < 2 || cWords.length !== oWords.length + 1) return null;
  let i = 0;
  while (i < oWords.length && oWords[i] === cWords[i]) i++;
  if (i === 0 || i >= oWords.length) return null;
  if (oWords.slice(i).join(" ") !== cWords.slice(i + 1).join(" ")) return null;
  const inserted = cWords[i];
  if (!/^\p{L}+$/u.test(inserted)) return null;
  // Words as given, anything that is not a letter or digit between them.
  const bare = oWords.map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
  if (bare.some((w) => !w)) return null;
  const sep = "[^\\p{L}\\p{N}]+";
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${bare.map(escapeRe).join(sep)}(?![\\p{L}\\p{N}])`,
    "gu",
  );
  const hits = [...chunk.matchAll(re)];
  if (hits.length !== 1) return null;
  const found = hits[0][0];
  // Where word i starts inside the matched text.
  const before = new RegExp(`^${bare.slice(0, i).map(escapeRe).join(sep)}${sep}`, "u").exec(found);
  if (!before) return null;
  const at = before[0].length;
  return { original: found, corrected: `${found.slice(0, at)}${inserted} ${found.slice(at)}` };
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * The inserted word, when `corrected` is `original` with exactly one function
 * word of `lang` added between two of original's words — else null.
 *
 * Interior only: a real dropped word has neighbours on both sides ("look ▢
 * each other"). An insertion at either edge is how the sweep invents
 * endings ("that someone would." → "would do."), and on the benchmark it was
 * two of the three false positives.
 */
export function insertedFunctionWord(
  original: string,
  corrected: string,
  lang = "en",
): string | null {
  const list = FUNCTION_WORDS[lang];
  if (!list) return null;
  // Character-exact first: corrected is original with letters and ONE space
  // spliced in and nothing else touched. Tokenising alone strips the marks
  // around a word, and the model does wrap its insertion in them — "Vagt" →
  // "**på** Vagt", "suddenly [is] dry" both passed as plain insertions.
  if (!isPlainWordSplice(original, corrected)) return null;
  const a = tokens(original);
  const b = tokens(corrected);
  if (a.length < 2 || b.length !== a.length + 1) return null;
  for (let i = 1; i < b.length - 1; i++) {
    const without = [...b.slice(0, i), ...b.slice(i + 1)];
    if (without.join(" ") === a.join(" ") && list.includes(b[i])) return b[i];
  }
  return null;
}

/** `corrected` = `original` with "word " or " word" spliced in at one point,
 *  where word is letters only. */
export function isPlainWordSplice(original: string, corrected: string): boolean {
  if (corrected.length <= original.length) return false;
  let p = 0;
  while (p < original.length && original[p] === corrected[p]) p++;
  let s = 0;
  while (
    s < original.length - p &&
    original[original.length - 1 - s] === corrected[corrected.length - 1 - s]
  )
    s++;
  if (p + s !== original.length) return false;
  const inserted = corrected.slice(p, corrected.length - s);
  // The shared prefix/suffix can claim the inserted word's own space from
  // either side, so accept the space on either end.
  return /^\p{L}+ $/u.test(inserted) || /^ \p{L}+$/u.test(inserted);
}

/** [start, end) of the sentence around text[idx, idx+len). */
export function sentenceAround(text: string, idx: number, len: number): [number, number] {
  let s = idx;
  while (s > 0 && !/[.!?\n]/.test(text[s - 1])) s--;
  let e = idx + len;
  while (e < text.length && !/[.!?\n]/.test(text[e])) e++;
  if (e < text.length) e++;
  while (e < text.length && /[”"’_*»]/.test(text[e])) e++;
  return [s, e];
}

/** A candidate that passed the shape filter, with the two sentences to judge. */
export interface MissingWordCandidate {
  original: string;
  corrected: string;
  word: string;
  /** The sentence as written. */
  sentenceA: string;
  /** The same sentence with the word inserted. */
  sentenceB: string;
}

/**
 * Stage 2: from raw sweep candidates to the ones worth a verdict. Pure.
 * Deduplicates, requires the original to occur exactly once in `chunk` (so
 * the correction lands where it was meant), and applies the shape rule.
 */
export function shapeCandidates(
  chunk: string,
  raw: { original: string; corrected: string }[],
  lang = "en",
): MissingWordCandidate[] {
  const out: MissingWordCandidate[] = [];
  const seen = new Set<string>();
  const atGap = new Set<string>();
  for (const given of raw) {
    let c = given;
    if (!chunk.includes(c.original)) {
      const relaxed = relaxedAnchor(chunk, c.original, c.corrected);
      if (!relaxed) continue;
      c = relaxed;
    }
    const key = `${c.original}\u0000${c.corrected}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const word = insertedFunctionWord(c.original, c.corrected, lang);
    if (!word) continue;
    const idx = chunk.indexOf(c.original);
    if (idx < 0 || chunk.indexOf(c.original, idx + 1) >= 0) continue;
    // One insertion point, one candidate: two spans around the same gap
    // would collide when applied.
    let p = 0;
    while (p < c.original.length && c.original[p] === c.corrected[p]) p++;
    const at = `${idx + p}`;
    if (atGap.has(at)) continue;
    atGap.add(at);
    const [s, e] = sentenceAround(chunk, idx, c.original.length);
    out.push({
      original: c.original,
      corrected: c.corrected,
      word,
      sentenceA: chunk.slice(s, e).trim(),
      sentenceB: (chunk.slice(s, idx) + c.corrected + chunk.slice(idx + c.original.length, e)).trim(),
    });
  }
  return out;
}

/** The verdict model's one-word answer, normalised. */
export function parseVerdict(raw: string): "A" | "B" | "BOTH" | "NEITHER" | null {
  const v = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim().toUpperCase();
  const m = v.match(/\b(NEITHER|BOTH|A|B)\b/);
  return (m?.[1] as "A" | "B" | "BOTH" | "NEITHER" | undefined) ?? null;
}

/** One LLM call: system prompt + user text → full answer. */
export type Complete = (system: string, user: string, maxTokens: number) => Promise<string>;

export interface MissingWordResult {
  corrections: Correction[];
  /** Raw sweep candidates, shape survivors and verdict survivors — for the log. */
  swept: number;
  shaped: number;
}

/**
 * Stages 1-3 over one chunk. Never throws for a bad model answer — a batch
 * that fails is a batch with no findings — but does rethrow an abort.
 */
export async function findMissingWords(
  chunk: string,
  lang: string,
  complete: Complete,
  signal?: AbortSignal,
): Promise<MissingWordResult> {
  if (!missingWordLanguageSupported(lang)) return { corrections: [], swept: 0, shaped: 0 };
  const sweepPrompt = buildMissingWordSweepPrompt(lang);
  const raw: { original: string; corrected: string }[] = [];
  for (const batch of sweepBatches(chunk)) {
    if (signal?.aborted) throw new Error("cancelled");
    try {
      raw.push(...parseSweepOutput(await complete(sweepPrompt, batch, 600)));
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  const shaped = shapeCandidates(chunk, raw, lang);
  const verdictPrompt = buildMissingWordVerdictPrompt(lang);
  const soloPrompt = buildMissingWordSoloPrompt(lang);
  const corrections: Correction[] = [];
  for (const c of shaped) {
    if (signal?.aborted) throw new Error("cancelled");
    let keep = false;
    try {
      keep = parseVerdict(await complete(verdictPrompt, `A: ${c.sentenceA}\nB: ${c.sentenceB}`, 8)) === "B";
      // The comparison is conservative on long sentences ("BOTH"). Judged one
      // at a time, the written sentence failing and the repaired one passing
      // is the same verdict reached another way.
      if (!keep && /\bNO\b/i.test(await complete(soloPrompt, c.sentenceA, 4))) {
        keep = /\bYES\b/i.test(await complete(soloPrompt, c.sentenceB, 4));
      }
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    if (!keep) continue;
    corrections.push({
      original: c.original,
      corrected: c.corrected,
      reason: "missing-word",
      preApproved: true,
      confidence: 5,
      editType: "copy",
    });
  }
  return { corrections, swept: raw.length, shaped: shaped.length };
}

/**
 * The passes that look for objective errors: the copy edit, the combined
 * edit's copy half, and the Final readthrough's proofread. A line edit
 * rewrites, and its reviewer judges rewrites; a dropped word is not its job.
 */
export const MISSING_WORD_MODES: readonly string[] = ["copy_edit", "combined_edit", "proofread"];

/** Whether a task in `mode` over a manuscript in `lang` runs the check. */
export function missingWordCheckApplies(mode: string, lang?: string): boolean {
  return MISSING_WORD_MODES.includes(mode) && missingWordLanguageSupported(lang ?? "en");
}

/**
 * Editor corrections that make the same repair the check already made — the
 * same word inserted at the same gap, over whatever span the editor chose.
 * Kept, they would collide with the check's correction when applied, and the
 * editor's copy is the one the reviewer would have thrown out.
 */
export function dropEditorDuplicates(
  chunk: string,
  found: Correction[],
  editorCs: Correction[],
  lang = "en",
): Correction[] {
  if (found.length === 0) return editorCs;
  const gaps = found
    .map((c) => {
      const idx = chunk.indexOf(c.original);
      let p = 0;
      while (p < c.original.length && c.original[p] === c.corrected[p]) p++;
      return { at: idx + p, word: insertedFunctionWord(c.original, c.corrected, lang) };
    })
    .filter((g) => g.word);
  return editorCs.filter((e) => {
    const word = insertedFunctionWord(e.original, e.corrected, lang);
    if (!word) return true;
    const idx = chunk.indexOf(e.original);
    if (idx < 0) return true;
    let p = 0;
    while (p < e.original.length && e.original[p] === e.corrected[p]) p++;
    return !gaps.some((g) => g.at === idx + p && g.word === word);
  });
}
