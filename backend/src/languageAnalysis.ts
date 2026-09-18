// ── Language analysis: a prose report with no model in it ──
//
// Everything here is counting. A word-frequency table, sentence lengths, what
// sentences start with, how close together a distinctive word recurs, how
// much of a chapter is inside quotation marks. None of it needs inference,
// which is the point: it runs on any machine in under a second, on a
// manuscript that has never left it, for a user who has downloaded nothing.
//
// It is also the reason to keep it narrow. A model can tell you a scene
// drags; a count can only tell you the sentences in it are all the same
// length and a third of them start with "He". So this reports the handful of
// things that counting is genuinely good at and writers genuinely check for
// — the overused word, the adverb habit, the filter verb, the flat rhythm,
// the same opener four times running — and stops there. The AI writing
// report (text_evaluator) is the place for judgement; this is the place for
// the numbers a good editor would circle in the margin before forming one.
//
// Thresholds are soft. They come from common fiction editing guidance, not
// measurement, and the report says "worth a look" rather than "wrong": the
// author who writes in long unvarying sentences on purpose is entitled to.

import type { LanguageAnalysisReport, LanguageFinding } from "./types.js";

export interface AnalysisUnit {
  name: string;
  original: string;
}

// ── Word lists ──
//
// Five languages, three lists each. STOP is what a frequency table ignores;
// CRUTCH is the words writers reach for without noticing (each counted on its
// own, since "very" at 4 per thousand is a habit whatever the rest of the
// table says); FILTER is the perception verbs that put the narrator between
// the reader and the scene ("she saw the door open" for "the door opened").
// SAID is the neutral dialogue tag; every other verb attached to a line of
// dialogue is counted against it.
//
// Danish and German mark few adverbs morphologically, so ADVERB_SUFFIX is
// null there and the intensifier habit is caught by CRUTCH alone. English,
// Spanish and French have a reliable suffix, with an exclusion list for the
// words that happen to end the same way — in French those are nouns
// (moment, gouvernement, sentiment) rather than adjectives, and there are a
// great many of them, which is why that list is the longest of the three.

interface LangLists {
  /** Never reported as a sentence opener: "The" starting a sixth of all
   *  sentences is English, not a habit. */
  articles: Set<string>;
  stop: Set<string>;
  crutch: Set<string>;
  filter: Set<string>;
  said: Set<string>;
  adverbSuffix: RegExp | null;
  notAdverbs: Set<string>;
  /**
   * Speech verbs other than the neutral one, when a suffix cannot find them.
   *
   * The shared fallback recognises a tag verb by its ending (-ed, -te, -ó,
   * -aba). French inflects its narrative past as -a and -it — endings shared
   * with half the nouns in the language ("la nuit", "un petit") — so a suffix
   * rule there would read ordinary narration as dialogue tags. A curated list
   * is the only precise answer, and this is what French uses instead.
   */
  tagVerbs?: Set<string>;
}

// One word per entry, by construction: a phrase like "ein wenig" split into
// "ein" and "wenig" once counted every German article as a crutch word.
const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const LISTS: Record<string, LangLists> = {
  en: {
    articles: words("a an the"),
    stop: words(
      "a an the and or but if then than that this these those there here it its is are was were be been being am do does did have has had of to in on at by for with from as into onto up down out over under about after before between through during without within along across behind beyond off not no nor so yet i me my mine we us our you your he him his she her hers they them their who whom whose which what when where why how all any both each few more most other some such only own same too can could will would shall should may might must just also again once s t d ll ve re m don didn isn wasn weren won wouldn couldn shouldn one two though although because whether unless until while someone something anything nothing everything everyone anyone nobody somewhere anywhere nowhere everywhere himself herself itself themselves myself yourself ourselves",
    ),
    crutch: words(
      "very really just quite rather somewhat pretty actually basically literally definitely certainly totally absolutely completely suddenly immediately finally began started seemed felt looked nodded smiled sighed shrugged glanced turned realized somehow slightly almost nearly perhaps maybe simply even still then",
    ),
    filter: words(
      "saw see seen watched watch heard hear felt feel noticed notice realized realise wondered seemed sensed",
    ),
    said: words("said asked says ask asks"),
    adverbSuffix: /ly$/,
    notAdverbs: words(
      "only family early reply apply supply ally belly bully fly holy jelly lily rally rely silly ugly jolly folly lovely friendly lonely elderly daily weekly monthly yearly likely unlikely deadly lively costly cowardly ghastly kindly leisurely orderly sly ply bodily heavenly homely lowly manly womanly worldly beastly comely curly burly surly wily holly molly sally billy italy july assembly melancholy anomaly butterfly dragonfly firefly",
    ),
  },
  da: {
    articles: words("en et den det de"),
    stop: words(
      "og i jeg det at en den til er som på de med han af for ikke der var mig sig men et har om vi min havde ham hun nu over da fra du ud sin dem os op man hans hvor eller hvad skal selv her alle vil blev kunne ind når være dog noget ville jo deres efter ned skulle denne end dette mit også under have dig anden hende mine alt meget sit sine vor mod disse hvis din nogle hos blive mange ad bliver hendes været thi jer sådan så ind ved kan kom",
    ),
    crutch: words(
      "meget virkelig bare lige pludselig egentlig faktisk helt ret ganske næsten altid aldrig begyndte startede syntes følte kiggede nikkede smilede sukkede trak vendte indså nogenlunde lidt måske simpelthen endda stadig alligevel",
    ),
    filter: words(
      "se set hørte høre følte føle mærkede mærke bemærkede syntes fornemmede",
    ),
    said: words("sagde spurgte siger spørger"),
    adverbSuffix: null,
    notAdverbs: new Set(),
  },
  de: {
    articles: words("der die das ein eine einen einem einer des dem den"),
    stop: words(
      "der die das und in zu den mit von ist des sich auf für nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei ich du wir ihr mir mich dich uns euch ihm ihn ihnen ihrer seiner seinem seinen meine meiner deine keine kein was wenn dann doch schon hier da wo hatte hatten habe hast wäre würde könnte sollte muss kann",
    ),
    crutch: words(
      "sehr wirklich einfach plötzlich eigentlich irgendwie ziemlich total völlig absolut endlich schließlich tatsächlich natürlich wahrscheinlich vielleicht begann fing schien fühlte blickte nickte lächelte seufzte zuckte drehte erkannte fast beinahe etwas bloß immer",
    ),
    filter: words(
      "sah sehen gesehen beobachtete hörte hören fühlte spürte bemerkte schien",
    ),
    said: words("sagte fragte sagt fragt"),
    adverbSuffix: null,
    notAdverbs: new Set(),
  },
  fr: {
    articles: words("le la les un une des du de"),
    stop: words(
      "le la les un une des du de et est sont était étaient a ai as ont avait avaient être avoir été fait faire dit que qui quoi dont où ne pas plus moins rien jamais toujours dans sur sous vers chez sans pour par avec en au aux il elle ils elles je tu nous vous on lui leur leurs me te se moi toi son sa ses mon ma mes ton ta tes notre nos votre vos ce cet cette ces celui celle ceux celles cela ça ici là si mais ou donc or car quand comme alors puis depuis avant après pendant tout tous toute toutes autre autres même mêmes chaque quelque quelques beaucoup peu très bien mal encore déjà aussi non oui peut pouvait pouvoir veut voulait vouloir doit devait devoir va allait aller vient venait venir y qu'il qu'elle qu'ils qu'elles qu'on c'est c'était n'est n'était n'a n'avait n'y s'il s'y s'est s'était d'un d'une d'être d'avoir l'un l'une j'ai j'avais j'étais m'a m'avait t'a qu'un qu'une lorsqu'il lorsqu'elle jusqu'à jusqu'au d'abord",
    ),
    crutch: words(
      "très vraiment juste simplement plutôt assez soudain soudainement brusquement immédiatement finalement enfin littéralement absolument complètement totalement évidemment certainement sûrement franchement carrément commença commençait sembla semblait parut sentit regarda hocha sourit soupira haussa tourna comprit réalisa presque quasiment quand-même toutefois néanmoins encore toujours",
    ),
    filter: words(
      "vit voir vu voyait regarda regardait entendit entendre entendait écouta sentit sentir sentait ressentit remarqua remarquait aperçut apercevait semblait parut songea comprit réalisa",
    ),
    // Inverted tags are one token to the tokeniser ("dit-il"), but the
    // dialogue-tag scan captures letters only and so reads the verb up to the
    // hyphen — the bare forms cover both "dit-il" and ", dit Marie".
    said: words("dit dis disait demanda demandait répondit répond répondait"),
    tagVerbs: words(
      "murmura murmurait chuchota souffla soupira cria criait hurla gronda grommela marmonna bredouilla balbutia bafouilla s'exclama exclama ajouta ajoutait reprit repris insista protesta objecta rétorqua riposta lança lançait coupa interrompit renchérit rugit gémit siffla susurra articula déclara annonça observa remarqua constata expliqua précisa avoua confia admit concéda suggéra proposa ordonna commanda supplia implora",
    ),
    adverbSuffix: /ment$/,
    // French builds adverbs on -ment and also builds a very large class of
    // ordinary nouns on it. Without these the report would read a page of
    // plain narration as an adverb habit.
    notAdverbs: words(
      "moment moments vêtement vêtements gouvernement gouvernements document documents monument monuments sentiment sentiments appartement appartements changement changements mouvement mouvements instrument instruments élément éléments argument arguments comment département départements parlement régiment testament tempérament bâtiment bâtiments compartiment compartiments ciment froment tourment tourments serment serments firmament aliment aliments médicament médicaments événement événements enterrement logement logements jugement jugements règlement règlements remerciement remerciements commencement achèvement traitement traitements équipement équipements environnement raisonnement raisonnements comportement comportements étonnement emplacement emplacements placement remplacement engagement engagements chargement campement hurlement hurlements grognement grognements craquement craquements gémissement gémissements frémissement frémissements battement battements claquement claquements roulement ruissellement tremblement tremblements tressaillement glissement pincement serrement déchirement soulagement dégagement renseignement renseignements enseignement établissement établissements investissement appartenance ferment garnement",
    ),
  },
  es: {
    articles: words("el la los las un una unos unas"),
    stop: words(
      "de la que el en y a los del se las por un para con no una su al lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto mí antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada muchos cual poco ella estar estas algunas algo nosotros mi mis tú te ti tu tus ellas nosotras vosotros vosotras os mío mía era eran fue fueron ha han había habían es son está están",
    ),
    crutch: words(
      "muy realmente simplemente bastante algo repentinamente inmediatamente finalmente empezó comenzó parecía sintió miró asintió sonrió suspiró encogió giró casi quizá quizás incluso todavía aún entonces luego",
    ),
    filter: words(
      "vio ver visto observó oyó escuchó sintió notó advirtió parecía percibió",
    ),
    said: words("dijo preguntó dice pregunta"),
    adverbSuffix: /mente$/,
    notAdverbs: words("mente clemente demente vehemente inclemente"),
  },
};

// The aims the report states and the marks it awards, in one place. The
// interface prints these numbers; it never carries its own copy of them.
export const AIMS = {
  crutchPerThousand: 2,
  adverbsPerThousand: 20,
  filterPerThousand: 12,
  openerShare: 25,
  echoesPerThousand: 5,
  sentenceMean: 22,
  /** Standard deviation over mean: below this the rhythm reads as flat. */
  rhythmCv: 0.45,
  tagsOtherShare: 30,
  longParagraphShare: 5,
} as const;

const LANG_OF = (lang: string | undefined) => LISTS[(lang ?? "en").slice(0, 2)] ? (lang ?? "en").slice(0, 2) : "en";

// ── Tokenising ──

const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;

/**
 * One spelling per word, whatever the manuscript's apostrophe.
 *
 * French carries its function words INSIDE the token — qu'elle, c'était,
 * d'un, s'il — so a list that spells them with ' would miss every one of them
 * in a manuscript typeset with ’, and the frequency table would report
 * "qu'elle" as the author's most overused word. The straight apostrophe is
 * the spelling the lists use, so it is the one every token is folded to.
 */
function normWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’ʼ]/g, "'")
    .replace(/^['-]+|['-]+$/g, "");
}

function wordsOf(text: string): string[] {
  return (text.match(WORD_RE) ?? []).map(normWord).filter(Boolean);
}

// A sentence ends at . ! ? … followed by whitespace (or a closing quote then
// whitespace) or the end of the text. Abbreviations are not handled; on prose
// the error is small and symmetric across chapters, which is what the
// comparisons need.
function sentencesOf(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?…]+(?:[.!?…]+["”’»)]*|$)/g;
  for (const m of text.match(re) ?? []) {
    const s = m.replace(/\s+/g, " ").trim();
    if (s && /\p{L}/u.test(s)) out.push(s);
  }
  return out;
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p) && !/^\s*(\*{3}|-{3}|#)\s*$/.test(p));
}

// Dialogue: anything between paired quotation marks, plus paragraphs that
// open with a dash (Danish and Spanish convention). Counted in words.
function dialogueWords(text: string): number {
  let n = 0;
  const quoted = text.match(/["“„«][^"”“„«»]{1,2000}["”“«»]/g) ?? [];
  for (const q of quoted) n += wordsOf(q).length;
  for (const p of paragraphsOf(text)) {
    if (/^[—–-]\s?\p{L}/u.test(p) && !quoted.some((q) => p.includes(q))) n += wordsOf(p).length;
  }
  return n;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}
const per1k = (n: number, words: number) => (words ? (n / words) * 1000 : 0);
const round1 = (x: number) => Math.round(x * 10) / 10;

// ── The report ──

export function analyzeLanguage(units: AnalysisUnit[], lang?: string): LanguageAnalysisReport {
  const L = LISTS[LANG_OF(lang)];
  const language = LANG_OF(lang);

  const freq = new Map<string, number>();
  const capitalised = new Set<string>();
  const adverbFreq = new Map<string, number>();
  const filterFreq = new Map<string, number>();
  const crutchFreq = new Map<string, number>();
  const openerFreq = new Map<string, number>();
  const tagFreq = new Map<string, number>();
  let saidCount = 0;
  let totalWords = 0;
  let totalSentences = 0;
  const allParagraphLengths: number[] = [];
  const openerRuns: LanguageAnalysisReport["openerRuns"] = [];
  const echoes: LanguageAnalysisReport["echoes"] = [];
  const pacing: LanguageAnalysisReport["pacing"] = [];
  // Every sentence's length, in reading order, with the chapter it belongs
  // to — the raw material for a book-wide pace profile below.
  const sentenceStream: { len: number; chapter: string; dialogue: boolean }[] = [];

  for (const unit of units) {
    const text = unit.original;
    const ws = wordsOf(text);
    const sents = sentencesOf(text);
    const paras = paragraphsOf(text);
    totalWords += ws.length;
    totalSentences += sents.length;
    for (const p of paras) allParagraphLengths.push(wordsOf(p).length);

    // Names first: a word capitalised mid-sentence. Kept out of the frequent
    // table and the echoes both — a character being in a scene is not a habit.
    for (const m of text.matchAll(/(?<=[a-zæøåäöüß,;:—–-]\s+)([A-ZÆØÅÄÖÜ][\p{L}]+)/gu)) {
      capitalised.add(m[1].toLowerCase());
    }

    // Word frequencies.
    for (const raw of text.match(WORD_RE) ?? []) {
      const w = normWord(raw);
      if (!w) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
      if (L.crutch.has(w)) crutchFreq.set(w, (crutchFreq.get(w) ?? 0) + 1);
      if (L.filter.has(w)) filterFreq.set(w, (filterFreq.get(w) ?? 0) + 1);
      if (L.adverbSuffix && L.adverbSuffix.test(w) && !L.notAdverbs.has(w) && w.length > 4) {
        adverbFreq.set(w, (adverbFreq.get(w) ?? 0) + 1);
      }
    }
    // Openers, and runs of the same opener.
    let runWord = "";
    let runLen = 0;
    let runStart = 0;
    const flushRun = (end: number) => {
      if (runLen >= 3) {
        openerRuns.push({
          chapter: unit.name,
          word: runWord,
          length: runLen,
          excerpt: sents.slice(runStart, Math.min(end, runStart + 3)).map((s) => s.slice(0, 60)).join(" · "),
        });
      }
    };
    sents.forEach((s, i) => {
      const first = wordsOf(s)[0];
      if (!first) return;
      if (!L.articles.has(first)) openerFreq.set(first, (openerFreq.get(first) ?? 0) + 1);
      if (first === runWord) runLen++;
      else {
        flushRun(i);
        runWord = first;
        runLen = 1;
        runStart = i;
      }
    });
    flushRun(sents.length);

    // Echoes: a distinctive word recurring within 25 words. One report per
    // word per chapter, at its closest recurrence. Six letters and up: at
    // five, "every" and "quiet" made every chapter look like it echoed.
    const lastSeen = new Map<string, number>();
    const closest = new Map<string, { distance: number; at: number }>();
    ws.forEach((w, i) => {
      // Contractions are function words wearing an apostrophe, not vocabulary.
      if (w.length < 6 || /['’]/.test(w) || L.stop.has(w) || L.crutch.has(w) || L.said.has(w) || capitalised.has(w)) return;
      const prev = lastSeen.get(w);
      if (prev != null && i - prev <= 25) {
        const c = closest.get(w);
        if (!c || i - prev < c.distance) closest.set(w, { distance: i - prev, at: prev });
      }
      lastSeen.set(w, i);
    });
    for (const [w, { distance, at }] of closest) {
      echoes.push({
        chapter: unit.name,
        word: w,
        distance,
        excerpt: ws.slice(Math.max(0, at - 4), at + distance + 5).join(" "),
      });
    }

    // Dialogue tags. Only a line closed with a comma carries one — "…," she
    // said, or the continental "…", sagte sie with the comma outside — while
    // a line closed with a full stop is followed by an action beat, which is
    // not a tag however many verbs it has. Counting beats as tags made every
    // Danish chapter read as 96% "ornate".
    // The words after the comma are "she said" in English and "sagte sie" on
    // the continent, so each is tried: whichever is the verb. Three of them
    // rather than two, because French puts the pronoun and the auxiliary in
    // front of the verb — », lui avait dit sa sœur — and at two words the tag
    // that matters was always the one just out of reach. The third word is a
    // spare in every other language: an adverb or a name, neither of which
    // can pass the verb test below.
    for (const m of text.matchAll(/(?:,\s*["”“»«]|["”“»«]\s*,)\s*(\p{L}+)(?:\s+(\p{L}+))?(?:\s+(\p{L}+))?/gu)) {
      const window = [m[1], m[2], m[3]].filter(Boolean).map(normWord);
      if (window.some((w) => L.said.has(w))) {
        saidCount++;
        continue;
      }
      const verb = window.find((w) =>
        L.tagVerbs
          ? L.tagVerbs.has(w)
          : w.length > 3 && !L.stop.has(w) && /(ed|te|ó|ió|de|aba)$/.test(w),
      );
      if (verb) tagFreq.set(verb, (tagFreq.get(verb) ?? 0) + 1);
    }

    // Rhythm.
    const lens = sents.map((s) => wordsOf(s).length).filter((n) => n > 0);
    for (const s of sents) {
      const len = wordsOf(s).length;
      if (len > 0) sentenceStream.push({ len, chapter: unit.name, dialogue: /["“„«»”]/.test(s) || /^[—–-]\s?\p{L}/u.test(s) });
    }
    const dw = dialogueWords(text);
    pacing.push({
      chapter: unit.name,
      words: ws.length,
      sentences: lens.length,
      meanSentence: round1(mean(lens)),
      sd: round1(sd(lens)),
      shortShare: lens.length ? round1((lens.filter((n) => n <= 7).length / lens.length) * 100) : 0,
      longShare: lens.length ? round1((lens.filter((n) => n >= 30).length / lens.length) * 100) : 0,
      longestSentence: lens.length ? Math.max(...lens) : 0,
      dialogueShare: ws.length ? round1((Math.min(dw, ws.length) / ws.length) * 100) : 0,
    });
  }

  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([word, count]) => ({ word, count }));

  // Overused: every crutch word above 1 per thousand, then the most frequent
  // content words that are not names — the table an editor would draw up.
  const overused: LanguageAnalysisReport["overused"] = [];
  for (const [word, count] of crutchFreq) {
    const p = per1k(count, totalWords);
    if (p >= 1 && count >= 3) overused.push({ word, count, perThousand: round1(p), kind: "crutch" });
  }
  overused.sort((a, b) => b.perThousand - a.perThousand);
  const frequent = [...freq.entries()]
    .filter(([w, c]) => !L.stop.has(w) && !L.crutch.has(w) && !L.said.has(w) && w.length >= 4 && !capitalised.has(w) && c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([word, count]) => ({ word, count, perThousand: round1(per1k(count, totalWords)), kind: "frequent" as const }));

  const adverbCount = [...adverbFreq.values()].reduce((a, b) => a + b, 0);
  const filterCount = [...filterFreq.values()].reduce((a, b) => a + b, 0);
  const openers = top(openerFreq, 8).map((o) => ({ ...o, share: totalSentences ? round1((o.count / totalSentences) * 100) : 0 }));
  const tagOther = top(tagFreq, 8);
  const tagOtherCount = [...tagFreq.values()].reduce((a, b) => a + b, 0);

  const meanLens = pacing.map((p) => p.meanSentence).filter((x) => x > 0);

  // The profile: the book cut into equal runs of sentences, each reduced to
  // its mean sentence length. Short runs read quick, long runs read slow, and
  // the shape of the whole is the thing no per-chapter table can show. Up to
  // eighty bars, so a novel and a short story both draw at a readable width.
  const windowSize = Math.max(12, Math.ceil(sentenceStream.length / 80));
  const profile: LanguageAnalysisReport["rhythm"]["profile"] = [];
  for (let i = 0; i < sentenceStream.length; i += windowSize) {
    const slice = sentenceStream.slice(i, i + windowSize);
    if (slice.length < Math.min(6, windowSize)) break;
    profile.push({
      chapter: slice[0].chapter,
      meanSentence: round1(mean(slice.map((s) => s.len))),
      dialogueShare: round1((slice.filter((s) => s.dialogue).length / slice.length) * 100),
    });
  }
  const overallMean = round1(mean(pacing.flatMap((p) => Array(p.sentences).fill(p.meanSentence))));
  const overallSd = round1(mean(pacing.map((p) => p.sd)));
  const over200 = allParagraphLengths.filter((n) => n > 200).length;

  // ── Headlines: what to look at first ──
  // Each carries the numbers the sentence needs, so the interface can phrase
  // it in the reader's language. Ordered by how far past its threshold.
  const findings: (LanguageFinding & { score: number })[] = [];
  const add = (id: LanguageFinding["id"], score: number, params: Record<string, string | number>) => {
    if (score > 1) findings.push({ id, params, score });
  };
  // Every rate needs a floor under it: one long paragraph in a two-paragraph
  // chapter is not a habit, it is a sample of two. The floors are what keep
  // a short excerpt from being told it has all ten problems.
  const enough = totalSentences >= 20;
  const adverbPer1k = per1k(adverbCount, totalWords);
  if (L.adverbSuffix && enough) add("adverbs_high", adverbPer1k / AIMS.adverbsPerThousand, { perThousand: round1(adverbPer1k), example: top(adverbFreq, 3).map((x) => x.word).join(", ") });
  if (enough) add("filter_words_high", per1k(filterCount, totalWords) / AIMS.filterPerThousand, { perThousand: round1(per1k(filterCount, totalWords)), example: top(filterFreq, 3).map((x) => x.word).join(", ") });
  // Two at most, or a manuscript with one bad habit reads as having four.
  for (const o of overused.slice(0, 2)) add("crutch_word", o.perThousand / AIMS.crutchPerThousand, { word: o.word, count: o.count, perThousand: o.perThousand });
  if (openers[0] && enough) add("opener_dominant", openers[0].share / AIMS.openerShare, { word: openers[0].word, share: openers[0].share });
  if (openerRuns.length) add("opener_runs", openerRuns.length / 4, { runs: openerRuns.length, longest: Math.max(...openerRuns.map((r) => r.length)) });
  // A coefficient of variation under 0.45 reads as metronomic. Zero — every
  // sentence the same length — is the flattest case there is, not a case to
  // skip.
  if (overallMean > 0 && enough) {
    const cv = overallSd / overallMean;
    add("rhythm_flat", cv === 0 ? 10 : AIMS.rhythmCv / cv, { mean: overallMean, sd: overallSd });
  }
  if (overallMean && enough) add("sentences_long", overallMean / AIMS.sentenceMean, { mean: overallMean });
  if (tagOtherCount + saidCount >= 20) add("tags_ornate", tagOtherCount / (tagOtherCount + saidCount) / (AIMS.tagsOtherShare / 100), { share: round1((tagOtherCount / (tagOtherCount + saidCount)) * 100), example: tagOther.slice(0, 3).map((x) => x.word).join(", ") });
  if (allParagraphLengths.length >= 10) add("paragraphs_long", over200 / allParagraphLengths.length / (AIMS.longParagraphShare / 100), { count: over200, longest: Math.max(...allParagraphLengths) });
  if (echoes.length && enough) add("echoes", per1k(echoes.length, totalWords) / AIMS.echoesPerThousand, { count: echoes.length });
  findings.sort((a, b) => b.score - a.score);
  const headlines = findings.slice(0, 4).map(({ id, params }) => ({ id, params }));

  // One verdict per section of the report, from the same scores. "na" where
  // there is nothing to judge — too little text for a rate to mean anything,
  // a language whose adverbs are not marked, a book with no tagged dialogue —
  // so a green tick is never shown for want of evidence.
  const fired = new Set(findings.map((f) => f.id));
  const verdict = (...ids: LanguageFinding["id"][]): "ok" | "look" =>
    ids.some((id) => fired.has(id)) ? "look" : "ok";
  const sections: LanguageAnalysisReport["sections"] = !enough
    ? { overused: "na", adverbs: "na", filter: "na", openers: "na", echoes: "na", rhythm: "na", tags: "na", paragraphs: "na" }
    : {
        overused: verdict("crutch_word"),
        adverbs: L.adverbSuffix ? verdict("adverbs_high") : "na",
        filter: verdict("filter_words_high"),
        openers: verdict("opener_dominant", "opener_runs"),
        echoes: verdict("echoes"),
        rhythm: verdict("rhythm_flat", "sentences_long"),
        tags: tagOtherCount + saidCount >= 20 ? verdict("tags_ornate") : "na",
        paragraphs: allParagraphLengths.length >= 10 ? verdict("paragraphs_long") : "na",
      };

  echoes.sort((a, b) => a.distance - b.distance);

  return {
    language,
    chaptersScanned: units.length,
    words: totalWords,
    sentences: totalSentences,
    headlines,
    sections,
    overused: [...overused.slice(0, 12), ...frequent],
    adverbs: { count: adverbCount, perThousand: round1(adverbPer1k), top: top(adverbFreq, 10), detected: L.adverbSuffix !== null },
    filterWords: { count: filterCount, perThousand: round1(per1k(filterCount, totalWords)), top: top(filterFreq, 10) },
    openers,
    openerRuns: openerRuns.sort((a, b) => b.length - a.length).slice(0, 12),
    echoes: echoes.slice(0, 20),
    pacing,
    rhythm: { meanSentence: overallMean, sd: overallSd, meanByChapter: meanLens, profile, windowSentences: windowSize },
    aims: AIMS,
    dialogueTags: { said: saidCount, other: tagOther, otherCount: tagOtherCount },
    paragraphs: {
      count: allParagraphLengths.length,
      mean: round1(mean(allParagraphLengths)),
      longest: allParagraphLengths.length ? Math.max(...allParagraphLengths) : 0,
      over200,
    },
  };
}
