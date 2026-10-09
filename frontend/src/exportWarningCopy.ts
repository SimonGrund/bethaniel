// ── What the export warning says, and whether it shows a table ──
//
// The surgical export refuses anything it cannot apply without altering the
// author's formatting, and warns before handing the file over. For an EDIT
// that warning is a list of corrections: "replace X with Y", with a CSV so
// they can be done by hand. Useful, and the reason the table exists.
//
// For a TRANSLATION every one of those rows is a whole English paragraph
// beside a whole French one. The table is unreadable, the CSV is pointless,
// and calling them "changes" invites the author to go looking for corrections
// to accept — which a translation never produces. It reported 472 of them on a
// real manuscript and sent its author hunting for a review screen that had
// nothing in it.
//
// So a translation gets its own sentence, in paragraphs rather than changes,
// and no table at all.

export interface ExportWarningInput {
  /** Edits the export refused — paragraph replacements for a translation. */
  skipped: number;
  /** Paragraphs replaced whole whose internal emphasis could not survive. */
  flattened: number;
  /** Comments Betty left in a translated file (every doubt is one). Absent
   *  from a backend that predates them, which still warns the old way. */
  comments?: number;
  isTranslation: boolean;
}

export interface ExportWarningView {
  /** i18n keys to join, in order. `{count}` is filled per key. */
  parts: { key: string; count: number }[];
  /** Whether the "replace X with Y" table and its CSV belong here. */
  showUnapplied: boolean;
}

/**
 * Decide the warning, or null when there is nothing worth stopping for.
 *
 * Both conditions can hold at once on a translation — some paragraphs refused,
 * others flattened — and the author needs to hear about both. The edit path
 * keeps its single message, because the table below it is already the detail.
 */
export function exportWarningFor(
  input: ExportWarningInput,
): ExportWarningView | null {
  const { skipped, flattened, isTranslation } = input;

  if (!isTranslation) {
    // Unchanged: one message, with the corrections table under it.
    if (skipped > 0)
      return { parts: [{ key: "surgical_partial", count: skipped }], showUnapplied: true };
    if (flattened > 0)
      return { parts: [{ key: "surgical_flattened", count: flattened }], showUnapplied: false };
    return null;
  }

  const parts: { key: string; count: number }[] = [];
  if (skipped > 0)
    parts.push({ key: "surgical_partial_translation", count: skipped });
  if (input.comments !== undefined) {
    // The translation is complete; every doubt — a placement, a layout, an
    // emphasis that could not be carried — is a comment in the file itself.
    // "The whole translation is in the file" only when it is: beside a
    // refused paragraph it read as a contradiction.
    if (input.comments > 0)
      parts.push({
        key: skipped > 0 ? "surgical_translation_comments_only" : "surgical_translation_commented",
        count: input.comments,
      });
  } else if (flattened > 0) {
    parts.push({ key: "surgical_flattened", count: flattened });
  }
  // Never the table: its rows would be paragraph against paragraph.
  return parts.length > 0 ? { parts, showUnapplied: false } : null;
}
