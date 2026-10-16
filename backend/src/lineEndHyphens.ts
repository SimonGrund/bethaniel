// ── Words broken across a line ──
//
// Text copied out of a typeset page arrives with its line-end hyphenation:
// "exam-" at the end of one line, "ple" at the start of the next. Every check
// downstream reads words, so it saw two — "exam" and "ple" — and offered a
// correction for each half. Rejoined here, at import, they are one word again.
//
// The hyphen is KEPT. Whether it was typesetting ("exam-ple") or the author's
// own ("well-known") cannot be told from the text, and dropping a real one is
// a silent change to the manuscript; keeping a typeset one leaves a single
// word the editor can fix on a single card. Only a lowercase continuation
// joins: "Copenhagen-\nBerlin" is two names, and a line starting with a
// capital is usually a new sentence or a heading.
//
// Not used on .docx: Word does not break words with a newline, and its
// paragraph map (conversion.ts) records offsets this would shift.

const BROKEN = /(\p{L})-[ \t]*\r?\n[ \t]*(\p{Ll})/gu;

export function joinLineEndHyphens(text: string): string {
  return text.replace(BROKEN, "$1-$2");
}
