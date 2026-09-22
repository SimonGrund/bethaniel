// ── Emphasis, read out of a translated paragraph and matched to its runs ──
//
// A translation replaces a whole paragraph, so the export used to give up any
// emphasis inside it. It need not: the model is given Markdown with the
// markers in, and it preserves them around the TARGET language's words —
// measured at 264 of 265 paragraphs on a real French translation, 304 spans in
// and 303 out.
//
// And the paragraph already has the runs to put them in. A paragraph is
// "flattened" precisely because it holds more than one formatting: a base run
// and an emphasised one. So nothing has to be created — the translated pieces
// only have to be handed to the runs that are already there.
//
// Pure: no docx types, no Markdown library, so the matching can be tested on
// its own.

/** One stretch of a paragraph, either emphasised or not. */
export interface EmphasisPiece {
  text: string;
  emphasised: boolean;
}

/**
 * Emphasis as turndown writes it. Longest markers first, so `***x***` is not
 * read as `*` twice. `(?=\S)` and `\S` pin the marker to non-space, which is
 * what stops an underscore inside a word — file_name — from opening a span.
 */
const EMPHASIS_RE = /(\*\*\*|___|\*\*|__|\*|_)(?=\S)([\s\S]*?\S)\1/g;

/**
 * Split a paragraph's Markdown into emphasised and unemphasised pieces.
 *
 * Empty pieces are never emitted: a paragraph that opens or closes with
 * emphasis would otherwise gain a zero-length piece, the shape would disagree
 * with a docx whose first run IS the emphasised one, and the whole paragraph
 * would fall back for no reason.
 */
export function splitEmphasis(md: string): EmphasisPiece[] {
  const pieces: EmphasisPiece[] = [];
  const push = (text: string, emphasised: boolean) => {
    if (text.length > 0) pieces.push({ text, emphasised });
  };

  let cursor = 0;
  for (const m of md.matchAll(EMPHASIS_RE)) {
    const at = m.index ?? 0;
    push(md.slice(cursor, at), false);
    push(m[2], true);
    cursor = at + m[0].length;
  }
  push(md.slice(cursor), false);

  // A paragraph of nothing but whitespace has no pieces to give.
  return pieces.length === 1 && !pieces[0].text.trim() ? [] : pieces;
}

/** The part of a docx text node this module needs. Structural, so the module
 *  stays free of docxSurgery's types and can be tested on plain objects. */
export interface RunLike {
  rPrXml: string;
  text: string;
  kind: string;
}

/** Consecutive runs that share formatting, as one stretch of text. */
export interface Segment {
  rPrXml: string;
  text: string;
}

/**
 * Fold a paragraph's runs into segments.
 *
 * Word splits runs for reasons of its own — a spell-check marker, a language
 * tag — that carry no formatting difference. Folding by rPrXml means those
 * splits do not make the paragraph look more complicated than it reads.
 *
 * Virtual nodes (a tab, a line break) are dropped: they hold a character but
 * no replaceable range, so they are not a place text can be put.
 */
export function foldSegments(nodes: readonly RunLike[]): Segment[] {
  const segments: Segment[] = [];
  for (const n of nodes) {
    if (n.kind === "virtual") continue;
    const last = segments[segments.length - 1];
    if (last && last.rPrXml === n.rPrXml) last.text += n.text;
    else segments.push({ rPrXml: n.rPrXml, text: n.text });
  }
  return segments;
}

/**
 * Which text each segment should receive, or null if that cannot be known.
 *
 * The paragraph's base formatting is taken from the first segment the
 * MARKDOWN calls unemphasised — not from the first segment positionally. A
 * paragraph that opens with an italic phrase has the italic run first, and
 * reading that as the base inverts the whole comparison: every emphasised
 * segment then looks plain and vice versa, and a paragraph that matched
 * perfectly would be refused.
 *
 * Refuses unless the two shapes agree completely: same number of parts, every
 * unemphasised segment sharing the base formatting, every emphasised one
 * differing from it, and nothing empty. That strictness is the whole safety
 * argument — a partial match would put translated text in the wrong run and
 * italicise the wrong phrase, which is worse than losing the emphasis. Losing
 * it is what happens today, so refusing costs nothing.
 */
export function allocateEmphasis(
  segments: readonly Segment[],
  pieces: readonly EmphasisPiece[],
): string[] | null {
  if (segments.length === 0 || pieces.length === 0) return null;
  if (segments.length !== pieces.length) return null;

  // No unemphasised piece means no base to compare against — a paragraph
  // entirely in italics, where there is nothing to tell apart.
  const baseIndex = pieces.findIndex((p) => !p.emphasised);
  if (baseIndex < 0) return null;
  const base = segments[baseIndex].rPrXml;

  for (let i = 0; i < segments.length; i++) {
    if ((segments[i].rPrXml !== base) !== pieces[i].emphasised) return null;
    if (pieces[i].text.length === 0) return null;
  }
  return pieces.map((p) => p.text);
}
