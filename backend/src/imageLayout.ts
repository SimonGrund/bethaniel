// ── The display size of an image ──
//
// An image file carries pixels; a document carries the size the author chose to
// show them at. A 2000px photo dropped into Word and dragged down to two inches
// is still 2000px on disk, and `wp:extent` in document.xml is the only record of
// the two inches.
//
// Import extracted the file and kept nothing else, so export had only the
// intrinsic pixel count to go on and every picture came back at the fallback
// width — reported from live use as "images are resized to larger".

import * as fs from "fs";
import * as path from "path";

/** English Metric Units per pixel at 96 dpi — the unit `docx` transformations use. */
export const EMU_PER_PX = 9525;

export interface DisplaySize {
  /** Pixels at 96 dpi, ready for a `docx` transformation. */
  width: number;
  height: number;
}

const SIZES_FILE = "image-sizes.json";

/**
 * Display extents of every inline/anchored image in `word/document.xml`, in
 * document order.
 *
 * Only `wp:extent` is read. `a:ext` inside the shape properties repeats the same
 * numbers and would double every entry, throwing the ordinal pairing below off
 * by a factor of two.
 */
export function extractDisplayExtents(documentXml: string): DisplaySize[] {
  const out: DisplaySize[] = [];
  const re = /<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"\s*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(documentXml)) !== null) {
    const width = Math.round(Number(m[1]) / EMU_PER_PX);
    const height = Math.round(Number(m[2]) / EMU_PER_PX);
    if (width > 0 && height > 0) out.push({ width, height });
  }
  return out;
}

/**
 * Pair extracted image files with the extents found in the document.
 *
 * Strictly ordinal, and deliberately all-or-nothing: mammoth walks the body in
 * document order, so the Nth extracted file is the Nth drawing — but only while
 * the counts agree. A mismatch means something is in play we have not modelled
 * (an image in a header, a floating shape we skipped), and mis-sizing every
 * picture from that point on is worse than sizing none of them.
 */
export function pairSizesByOrder(
  fileNames: string[],
  extents: DisplaySize[],
): Record<string, DisplaySize> | null {
  if (fileNames.length === 0) return null;
  if (fileNames.length !== extents.length) return null;
  const out: Record<string, DisplaySize> = {};
  fileNames.forEach((name, i) => {
    out[name] = extents[i];
  });
  return out;
}

function sizesPath(mediaDir: string, docId: string): string {
  return path.join(mediaDir, docId, SIZES_FILE);
}

/** Record display sizes beside the extracted images. Never fails an import. */
export function saveImageSizes(
  mediaDir: string,
  docId: string,
  sizes: Record<string, DisplaySize>,
): void {
  try {
    fs.writeFileSync(sizesPath(mediaDir, docId), JSON.stringify(sizes));
  } catch {
    // Losing this costs faithful sizing for one document, not the import.
  }
}

/** Recorded display sizes, or an empty map when none were kept. */
export function loadImageSizes(
  mediaDir: string,
  docId: string,
): Record<string, DisplaySize> {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(sizesPath(mediaDir, docId), "utf-8"),
    ) as Record<string, DisplaySize>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The recorded display size for a markdown image ref (`media/<docId>/x.png`),
 * or null when the document predates this record or was never a .docx.
 */
export function displaySizeFor(
  mediaDir: string,
  src: string,
): DisplaySize | null {
  const m = /^media\/([^/]+)\/(.+)$/.exec(src);
  if (!m) return null;
  const size = loadImageSizes(mediaDir, m[1])[m[2]];
  return size && size.width > 0 && size.height > 0 ? size : null;
}
