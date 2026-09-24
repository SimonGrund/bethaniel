// ── One shape for a readiness blocker, three renderings ──
//
// The panel, the exported PDF and the Markdown report each answer the same
// three questions about a blocker: what would change, where in the sentence,
// and why. They answered them in three different ways, and the panel's was
// the bad one — it spliced the word-level diff INTO the sentence, which is
// unreadable for a punctuation swap. "Tobias said," → "Tobias said." came out
// mid-paragraph as
//
//     …aware of her own heavy breaths. Tobias said,. “This is the first…
//
// with the deleted comma and the inserted period adjacent, so the passage
// looks mispunctuated and the reader cannot tell which mark is the proposal.
// The PDF keeps them apart: the change on its own line, then the author's
// sentence with the span bracketed and otherwise untouched. That is the form
// that reads, so it is the form all three use — from these functions, so a
// later edit to one cannot quietly leave the others behind.

import { certaintyPercent, flagKindOf, type Correction } from "./types";

export interface ReportIssue {
  location: string;
  /** The change, as the author wrote it and as proposed. */
  original?: string;
  corrected?: string;
  /** A sentence of context around the change, when there is one. */
  context?: string;
  /** For structural findings: what was found. */
  message?: string;
  detail?: string;
  correction?: Correction;
}

/**
 * The author's own sentence with the changed span marked — never the diff
 * applied. The brackets are literal because this same string is set as plain
 * text in the PDF and in the Markdown; a styled span would be one rendering
 * the other two could not reproduce.
 *
 * Returns undefined when there is no context on either side, which is how
 * `extractSentenceContext` reports that it could not place the span. Saying
 * nothing is right there: a bracket around a passage we failed to find would
 * point at the wrong words.
 */
export function bracketedContext(
  original: string,
  before: string,
  after: string,
): string | undefined {
  if (!before && !after) return undefined;
  const body = [before, `[${original}]`, after]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return `…${body}…`;
}

/** Where a correction came from, in the reader's words. */
export function sourceOf(
  c: Correction,
  t: (k: string, f?: string) => string,
): string {
  const reason = c.reason ?? "";
  let source: string;
  if (reason === "spell-check" || reason === "spell-check-uncommon")
    source = t("rr_src_dictionary");
  else if (reason === "dialect") source = t("rr_src_dialect");
  else if (reason.startsWith("grammar:"))
    source = `${t("rr_src_grammar")} · ${reason.slice(8).replace(/_/g, " ")}`;
  else if (reason.startsWith("retext:"))
    source = `${t("rr_src_text")} · ${reason.slice(7).replace(/-/g, " ")}`;
  else source = t("rr_src_betty");
  const pct = certaintyPercent(c);
  const kind = flagKindOf(c);
  const tail =
    kind === "unreviewed" || kind === "unchecked"
      ? t("flag_unchecked")
      : pct !== null
        ? `${pct}%`
        : "";
  return tail ? `${source} · ${tail}` : source;
}
