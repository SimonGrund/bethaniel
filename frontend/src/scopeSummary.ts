// ── What the collapsed Scope row says ──
//
// One line standing in for three radios, a chapter list and a word box. It has
// to carry the shape of the job — which part of the book, how much of it —
// because folding it away is otherwise just hiding a decision the author made.
//
// Pure, so backend/test/scopeSummary.test.ts can hold it to that.

export type ScopeMode = "whole_book" | "selected_chapters" | "first_n_words";

export interface ScopeShape {
  scopeMode: ScopeMode;
  /** Units the scope resolves to — chapters, unless none were detected. */
  unitCount: number;
  totalWords: number;
  /**
   * False when the manuscript has no chapter headings. buildUnits still makes
   * one synthetic "Manuscript" unit, and reporting that as "1 chapter" would
   * be a claim about the book rather than about the scope.
   */
  chaptersDetected?: boolean;
}

export function scopeSummary(
  t: (key: string) => string,
  { scopeMode, unitCount, totalWords, chaptersDetected = true }: ScopeShape,
): string {
  const label = t(
    scopeMode === "whole_book"
      ? "whole_book"
      : scopeMode === "selected_chapters"
        ? "selected_chapters"
        : "first_n_words",
  );
  // Nothing chosen yet: a size would read as a promise the run cannot keep.
  if (unitCount === 0) return label;

  const parts = [label, `${totalWords.toLocaleString()} ${t("lbl_words")}`];
  // A first-N-words scope is measured in words by construction; the chapters
  // it happens to span are an artefact of where the count fell.
  if (chaptersDetected && scopeMode !== "first_n_words") {
    parts.push(
      unitCount === 1
        ? `1 ${t("lbl_chapter")}`
        : `${unitCount} ${t("lbl_chapters")}`,
    );
  }
  return parts.join(" · ");
}
