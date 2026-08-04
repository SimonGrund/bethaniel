/**
 * Publish-ready final review: a deterministic scan of the assembled, accepted
 * manuscript text right before export. It repairs only *unambiguous* artifacts
 * — stray emphasis markers wrapping punctuation (`okay_?_` → `okay?`) and
 * doubled/misplaced sentence punctuation (`left..` → `left.`, `waited., ` →
 * `waited, `) — and reports every fix so the reviewer sees what was cleaned.
 *
 * It deliberately does NOT touch lone/orphan markers, real emphasis spans, or
 * casing: those are either legitimate or too ambiguous to repair silently.
 */

export interface PublishFix {
  /** Machine-readable category, e.g. "stray-emphasis" or "doubled-punctuation". */
  type: string;
  /** The offending substring as it appeared. */
  before: string;
  /** What it was replaced with. */
  after: string;
}

// Emphasis/code markers (`_`, `__`, `*`, `**`, `***`) wrapping content that is
// *only* punctuation — never a real emphasis span, which always contains a
// letter or digit. Inner content excludes letters, digits, whitespace and the
// markers themselves, so `_?_`, `him_._`, `*!*` match but `_a word_` does not.
const STRAY_EMPHASIS_RE = /(\*{1,3}|_{1,2})([^\p{L}\p{N}\s*_]+)\1/gu;

// Exactly two dots (not part of a `...` ellipsis) → one dot.
const DOUBLED_DOT_RE = /(?<!\.)\.\.(?!\.)/g;

// Doubled non-dot sentence punctuation (`,,`, `!!`, `??`, `;;`, `::`) → one.
const DOUBLED_PUNCT_RE = /([,;:!?])\1/g;

// A lone period jammed against other sentence punctuation is a splice artifact;
// drop the period and keep the author's own mark (mirrors absorbSeamPunctuation
// in llm.ts). Guarded so it never bites into a `...` ellipsis.
const DOT_BEFORE_PUNCT_RE = /(?<!\.)\.([,;:!?])/g;
const DOT_AFTER_PUNCT_RE = /([,;:!?])\.(?!\.)/g;

function applyRule(
  text: string,
  re: RegExp,
  type: string,
  replacer: (match: string, ...groups: string[]) => string,
  fixes: PublishFix[],
): string {
  return text.replace(re, (match: string, ...args: unknown[]) => {
    const groups = args.slice(0, -2) as string[];
    const after = replacer(match, ...groups);
    if (after !== match) fixes.push({ type, before: match, after });
    return after;
  });
}

export function cleanPublishArtifacts(text: string): {
  cleaned: string;
  fixes: PublishFix[];
} {
  const fixes: PublishFix[] = [];
  let out = text;

  out = applyRule(
    out,
    STRAY_EMPHASIS_RE,
    "stray-emphasis",
    (_m, _marker, inner) => inner,
    fixes,
  );
  out = applyRule(out, DOUBLED_DOT_RE, "doubled-punctuation", () => ".", fixes);
  out = applyRule(
    out,
    DOUBLED_PUNCT_RE,
    "doubled-punctuation",
    (_m, ch) => ch,
    fixes,
  );
  out = applyRule(
    out,
    DOT_BEFORE_PUNCT_RE,
    "misplaced-period",
    (_m, ch) => ch,
    fixes,
  );
  out = applyRule(
    out,
    DOT_AFTER_PUNCT_RE,
    "misplaced-period",
    (_m, ch) => ch,
    fixes,
  );

  return { cleaned: out, fixes };
}

// ── Typographic quote/apostrophe normalization ──
// Betty preserves untouched prose byte-for-byte, so a manuscript's own mixed
// apostrophe styles (a few straight `'` among many curly `’`) survive into the
// export. The final review normalizes them toward the document's DOMINANT
// style — but only when it is overwhelmingly one way, so an intentionally
// straight-quote manuscript is left alone. The style decision is the caller's
// (it needs whole-document counts); these helpers do the counting and the
// context-aware conversion.

export interface QuoteStyle {
  singleCurly: number;
  singleStraight: number;
  doubleCurly: number;
  doubleStraight: number;
}

export function detectQuoteStyle(text: string): QuoteStyle {
  const count = (re: RegExp) => (text.match(re) ?? []).length;
  return {
    singleCurly: count(/[‘’]/g),
    singleStraight: count(/'/g),
    doubleCurly: count(/[“”]/g),
    doubleStraight: count(/"/g),
  };
}

// A quote is "opening" when it starts the string or follows whitespace or an
// opening bracket; otherwise it closes / is an apostrophe. This handles a stray
// straight quote sitting in otherwise-curly text without needing to track an
// alternating open/close state across the whole (possibly spliced) chapter.
const OPENS_AFTER = /[\s([{]/;

// Leading elisions read as an apostrophe (’), not an opening quote (‘), even
// though they sit in opening position: 'tis, 'em, 'n', decade forms like '90s,
// etc. The lookahead requires a word boundary so a genuine quoted word ('hello')
// is untouched. `n` covers "rock 'n' roll".
const ELISION_AFTER = new RegExp(
  "^(?:\\d|tis|twas|twere|twill|twould|em|im|n|cause|round|bout|til|till|neath|gainst|fore|nother|ere|cept|way|nuff)(?=[^\\p{L}]|$)",
  "iu",
);

function isElision(str: string, offset: number): boolean {
  return ELISION_AFTER.test(str.slice(offset + 1));
}

function curlyFor(str: string, offset: number, open: string, close: string): string {
  if (offset === 0) return open;
  return OPENS_AFTER.test(str[offset - 1]) ? open : close;
}

export function curlifyStrayQuotes(
  text: string,
  opts: { singles: boolean; doubles: boolean },
): { cleaned: string; fixes: PublishFix[] } {
  const fixes: PublishFix[] = [];
  let out = text;
  if (opts.singles) {
    out = out.replace(/'/g, (m, offset: number, str: string) => {
      const rep = isElision(str, offset) ? "’" : curlyFor(str, offset, "‘", "’");
      fixes.push({ type: "quote-style", before: m, after: rep });
      return rep;
    });
  }
  if (opts.doubles) {
    out = out.replace(/"/g, (m, offset: number, str: string) => {
      const rep = curlyFor(str, offset, "“", "”");
      fixes.push({ type: "quote-style", before: m, after: rep });
      return rep;
    });
  }
  return { cleaned: out, fixes };
}
