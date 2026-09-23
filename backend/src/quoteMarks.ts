// ── One reading of a quotation mark ──
//
// Two files used to answer this question separately and differently.
// `quoteRepair.marksOpen` counted a straight " as a quotation mark;
// `publicationScan.quoteBalance` did not. Measured on two real manuscripts,
// the publication scan reported 5 of 15 unbalanced paragraphs in one book and
// 0 of 8 in the other — and every single miss was a curly opener closed by a
// straight mark, which is to say every miss lived in the gap between the two
// readings. So there is one reading now, and both files consume it.
//
// Double quotes only. A manuscript carries thousands of ’ as apostrophes
// (2,002 in one of the test books), and telling those from a nested closing
// quote is a different and much riskier job.

/** Curly or straight. Which one a book uses is the author's choice. */
export type QuoteStyle = "curly" | "straight";

export interface QuoteFamily {
  open: string;
  close: string;
}

export interface QuoteConvention {
  family: QuoteFamily;
  /** Null when the manuscript has no convention to conform to. */
  style: QuoteStyle | null;
}

/**
 * The pair of marks a manuscript opens and closes speech with.
 *
 * English curly quotes were once hard-coded, which on a French novel meant the
 * check found no quotation marks at all and passed every chapter in silence —
 * the dialogue was in guillemets. The convention is the manuscript's, not the
 * language's (a French author may well use “ ”, a German one » «), so it is
 * counted off the text rather than looked up from a language code.
 */
export const QUOTE_FAMILIES: readonly QuoteFamily[] = [
  { open: "“", close: "”" }, // “ ”  English, and French houses that follow it
  { open: "«", close: "»" }, // « »  French, and the continental default
  { open: "„", close: "“" }, // „ “  German
  { open: "»", close: "«" }, // » «  German reversed guillemets
] as const;

const STRAIGHT = '"';

/** Every character that counts as a curly (non-straight) double-quote mark. */
const CURLY_MARKS_RE = /[“”„«»]/g;

/** Share of marks that must agree before a style counts as the manuscript's. */
const STYLE_MAJORITY = 0.75;

/** Below this many double-quote marks there is no style to infer. */
const MIN_MARKS_TO_JUDGE = 4;

function countOf(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n++;
  return n;
}

/**
 * Which family this manuscript speaks in: whichever opener it uses most.
 *
 * „ “ is decided before “ ”, because a German manuscript contains both — its
 * closer IS the English opener — and counting openers alone would call it
 * English and then report every closed line as unbalanced.
 */
export function detectQuoteFamily(text: string): QuoteFamily {
  const german = countOf(text, "„");
  if (german > 0 && german >= countOf(text, "“") - german) {
    return QUOTE_FAMILIES[2];
  }
  let best: QuoteFamily = QUOTE_FAMILIES[0];
  let bestCount = -1;
  for (const f of QUOTE_FAMILIES) {
    // » « is only ever the right reading when « is not itself the opener.
    if (
      f.open === "»" &&
      countOf(text, "«") >= countOf(text, "»")
    ) {
      continue;
    }
    const n = countOf(text, f.open);
    if (n > bestCount) {
      best = f;
      bestCount = n;
    }
  }
  return best;
}

/**
 * The manuscript's prevailing double-quote style.
 *
 * Style is the author's choice; only inconsistency is an error. A book set in
 * straight quotes throughout is correct and must be left alone. Null means
 * there is nothing here to conform to — too few marks to call it, or a book
 * so evenly mixed that picking one would rewrite half its dialogue on a
 * guess. A declared setting is what resolves that case; see resolveConvention.
 */
export function detectDominantStyle(text: string): QuoteStyle | null {
  const curly = (text.match(CURLY_MARKS_RE) ?? []).length;
  const straight = countOf(text, STRAIGHT);
  const total = curly + straight;
  if (total < MIN_MARKS_TO_JUDGE) return null;
  if (curly / total >= STYLE_MAJORITY) return "curly";
  if (straight / total >= STYLE_MAJORITY) return "straight";
  return null;
}

/**
 * The convention to read a manuscript against.
 *
 * `declared` is the style the author chose in the settings panel, when there
 * is a job that has one. It wins over the manuscript's own majority for the
 * same reason the English dialect check was changed to consult the declared
 * dialect: deciding by majority inside the check told a manuscript set to
 * British to standardise on American, the exact opposite of what the copy
 * edit would do to the same text. A book that is 60% curly would likewise be
 * "normalised" to curly whether or not its author wants that.
 *
 * The FAMILY is never declared — it is read off the text either way. An
 * author declaring "curly" is choosing curly over straight, not choosing
 * English quotes over guillemets.
 */
export function resolveConvention(
  text: string,
  declared?: QuoteStyle | null,
): QuoteConvention {
  return {
    family: detectQuoteFamily(text),
    style: declared ?? detectDominantStyle(text),
  };
}

export interface QuoteMark {
  index: number;
  char: string;
  role: "open" | "close";
}

/**
 * Every double-quote mark in one paragraph, with the role it plays.
 *
 * A family mark takes its role from its character: “ opens and ” closes, and
 * a paragraph holding two closers in a row is a defect rather than an
 * instruction to alternate. A straight mark has no orientation to read, so it
 * takes the role alternation needs — which is what `quoteRepair.marksOpen`
 * has always done, and which is why `“But—"` is BALANCED and wrong only in
 * style. Alternation is decided by preceding marks, not by the character
 * before the mark: “But sir—” is speech cut off mid-sentence and correctly
 * ends with an em-dash and a CLOSING mark. A rule that read the dash as
 * opening context flipped 61 correct marks in one book.
 *
 * State resets at every paragraph, which is also what the continued-speech
 * convention needs: each paragraph of a long speech opens with a mark.
 */
export function readMarks(
  paragraph: string,
  convention: QuoteConvention,
): QuoteMark[] {
  const { family } = convention;
  const out: QuoteMark[] = [];
  let inside = false;
  let index = 0;
  for (const ch of paragraph) {
    if (ch === family.open) {
      out.push({ index, char: ch, role: "open" });
      inside = true;
    } else if (ch === family.close) {
      out.push({ index, char: ch, role: "close" });
      inside = false;
    } else if (ch === STRAIGHT) {
      out.push({ index, char: ch, role: inside ? "close" : "open" });
      inside = !inside;
    }
    index += ch.length;
  }
  return out;
}
