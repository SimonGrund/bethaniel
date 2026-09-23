// ── One reading of "is this a word" ──
//
// Two callers used to answer this question separately and differently:
//
//   routes.ts   harvestForUpload     isWord = en_US(w) OR en_GB(w)
//   queue.ts    getSpellCorrections(chunk.body, "en_US")
//
// "Tobias" appears 610 times in one real manuscript. It is in en_GB and not
// in en_US. So the lexicon asked "is this a word?", got yes, and did not
// harvest it — correctly, by its own rule, since it only collects what no
// dictionary knows. Nothing then protected it. The speller asked the same
// question of en_US alone, got no, and proposed "To bias". 75 of the 125
// findings that reached the author came from that gap, including "Anima" ->
// "Anita", "Scarface" -> "Scarce" and "barque" -> "baroque".
//
// So there is one reading now. The point is not that the two dictionaries
// merge — it is that a word the OTHER English knows is a different thing
// from a word neither knows, and the caller gets told which.

import { getWordValidator } from "./spellcheck.js";

export type EnglishDialect = "american" | "british";

export interface WordVerdict {
  /** In the dictionary for the dialect this manuscript declares. */
  inDeclared: boolean;
  /**
   * In the OTHER English dictionary. Always false outside English, where
   * there is no other dictionary to ask — which is also why callers must not
   * read this as "correct elsewhere".
   */
  inOtherEnglish: boolean;
}

function otherOf(d: EnglishDialect): EnglishDialect {
  return d === "american" ? "british" : "american";
}

/**
 * The verdict on one word, or null when no dictionary is available for this
 * language — in which case callers skip rather than guess, as they already do.
 */
export function wordKnowledge(
  lang: string,
  declared: EnglishDialect = "american",
): ((word: string) => WordVerdict) | null {
  const base = lang.toLowerCase().split(/[-_]/)[0];
  if (base === "en") {
    const inDeclared = getWordValidator("en", { englishDialect: declared });
    const inOther = getWordValidator("en", {
      englishDialect: otherOf(declared),
    });
    if (!inDeclared || !inOther) return null;
    return (word) => ({
      inDeclared: inDeclared(word),
      inOtherEnglish: inOther(word),
    });
  }
  const only = getWordValidator(base);
  if (!only) return null;
  return (word) => ({ inDeclared: only(word), inOtherEnglish: false });
}

/**
 * "Does ANY dictionary for this language know the word" — the question the
 * lexicon harvest asks, because a word one English knows is not a coinage
 * whatever the other thinks.
 */
export function isWordAnywhere(
  lang: string,
  declared: EnglishDialect = "american",
): ((word: string) => boolean) | null {
  const know = wordKnowledge(lang, declared);
  if (!know) return null;
  return (word) => {
    const v = know(word);
    return v.inDeclared || v.inOtherEnglish;
  };
}
