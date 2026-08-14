// ── The skip report, sized to fit a response header ──
//
// Surgical export returns the .docx as the body, so what was left out has to
// travel beside it in a header. That is a hard budget: adding the surrounding
// context to each skipped edit made the report roughly ten times larger, and a
// manuscript with many mixed-formatting edits could push it past what servers
// and browsers accept.
//
// Losing the export because the explanation of what it omitted grew too big
// would be a poor trade, so the report is trimmed to fit and says that it was.

import type { SkippedEdit } from "./docxSurgery.js";
import type { UnmappedNote } from "./docxRemap.js";

/**
 * Byte budget for the encoded header value. Node accepts more, but 8 KB is the
 * common limit across proxies and intermediaries, so stay well inside it.
 */
export const MAX_REPORT_HEADER_BYTES = 6144;

/** Longest context excerpt kept per row before the row count is reduced. */
const MAX_CONTEXT_CHARS = 200;

function trimRow(e: SkippedEdit) {
  // Only the fields the user-facing table needs. start/end are offsets into a
  // paragraph the client cannot see, and cost bytes that context can use.
  return {
    reason: e.reason,
    original: e.original,
    replacement: e.replacement,
    context: e.context.slice(0, MAX_CONTEXT_CHARS),
    paragraphIndex: e.paragraphIndex,
  };
}

/**
 * The report as a URI-encoded JSON header value, trimmed to the byte budget.
 *
 * Rows are dropped from the end until it fits — measuring after encoding,
 * because encodeURIComponent turns one 'ø' into nine bytes and a Danish
 * manuscript would otherwise sail past a limit checked on the raw string.
 */
export function buildReportHeader(
  skipped: SkippedEdit[],
  unmapped: UnmappedNote[],
): string {
  const rows = skipped.map(trimRow);
  const notes = unmapped.map((u) => ({
    reason: u.reason,
    detail: u.detail,
    paragraphIndex: u.paragraphIndex,
  }));

  const encode = (n: number) =>
    encodeURIComponent(
      JSON.stringify({
        skipped: rows.slice(0, n),
        unmapped: notes,
        truncated: n < rows.length,
        totalSkipped: skipped.length,
        totalUnmapped: unmapped.length,
      }),
    );

  let n = rows.length;
  let header = encode(n);
  while (n > 0 && Buffer.byteLength(header) > MAX_REPORT_HEADER_BYTES) {
    // Halve rather than step: a 400-row report would otherwise re-encode 400
    // times to find the fit.
    n = Math.floor(n / 2);
    header = encode(n);
  }

  if (Buffer.byteLength(header) > MAX_REPORT_HEADER_BYTES) {
    // Even with no rows the notes overflow. Report the counts and nothing else,
    // so the client still learns that changes were left out.
    return encodeURIComponent(
      JSON.stringify({
        skipped: [],
        unmapped: [],
        truncated: true,
        totalSkipped: skipped.length,
        totalUnmapped: unmapped.length,
      }),
    );
  }
  return header;
}
