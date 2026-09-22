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
