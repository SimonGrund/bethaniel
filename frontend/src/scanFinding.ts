// ── A publication-scan finding, in the reader's language ──
//
// The backend sends each finding twice over: `message` and `detail` in
// English, and the same sentence as an i18n key with its values. This renders
// the key when there is one and falls back to the English when there is not —
// a result saved before the keys existed, or a key the interface has no
// string for. Pure, and tested from backend/test/publicationScanMessages.test.ts.

type T = (key: string, fallback?: string) => string;

export interface LocalisableFinding {
  location: string;
  message: string;
  detail?: string;
  messageKey?: string;
  detailKey?: string;
  params?: Record<string, string | number>;
  labelParams?: Record<string, string>;
  wholeManuscript?: boolean;
}

function render(f: LocalisableFinding, key: string | undefined, t: T): string | null {
  if (!key) return null;
  const template = t(key, "");
  if (!template) return null;
  const params = f.params ?? {};
  const labels = f.labelParams ?? {};
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in labels ? t(labels[name]) : name in params ? String(params[name]) : whole,
  );
}

export function localiseFinding(
  f: LocalisableFinding,
  t: T,
): { location: string; message: string; detail?: string } {
  return {
    location: f.wholeManuscript ? t("scan_loc_manuscript", f.location) : f.location,
    message: render(f, f.messageKey, t) ?? f.message,
    detail: render(f, f.detailKey, t) ?? f.detail,
  };
}

/**
 * The findings in the order of the book: the whole-book ones first, then by
 * the chapter each is about. The scan sorts them itself now (`unitIndex`);
 * a report saved before that has only the chapter's name in `location`, so
 * it is placed by where that name comes in `chapterNames` — the first name
 * of "Chapter 3 ↔ Chapter 9" or "Chapter 4 → Chapter 6". Anything it cannot
 * place goes last, in its original order.
 */
export function inChapterOrder<F extends LocalisableFinding & { unitIndex?: number }>(
  findings: F[],
  chapterNames: string[],
): F[] {
  const place = (f: F): number => {
    if (f.wholeManuscript || f.location === "Manuscript") return -1;
    if (f.unitIndex !== undefined) return f.unitIndex;
    const first = f.location.split(/ [↔→] /)[0];
    const i = chapterNames.indexOf(first);
    return i >= 0 ? i : Number.MAX_SAFE_INTEGER;
  };
  return findings
    .map((f, i) => ({ f, i, at: place(f) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map(({ f }) => f);
}
