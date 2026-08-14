// ── The uploaded .docx, kept for surgical export ──
//
// Until now the upload buffer was converted to markdown and dropped, so there
// was nothing to edit surgically. The original and its paragraph map live in
// MEDIA_DIR/<docId>/ deliberately: deleteDocumentMedia already removes that
// directory when a document is deleted, getStorageUsage().documents counts it,
// and the uninstall purge covers it — no new cleanup, no DB migration.
//
// Size: a typical novel is 0.5-5 MB. Image-heavy documents roughly double their
// footprint, since extracted images already live in the same directory.

import * as fs from "fs/promises";
import * as path from "path";

import { MEDIA_DIR } from "./conversion.js";
import type { ParagraphMapEntry } from "./conversion.js";

const ORIGINAL = "original.docx";
const MAP = "paragraph-map.json";
/** Bumped if the map's meaning changes, so stale maps are refused not misread. */
const MAP_VERSION = 1;

function dirFor(docId: string): string {
  return path.join(MEDIA_DIR, docId);
}

/** Keep the uploaded file and its map. Best-effort: never fail an upload. */
export async function saveOriginalDocx(
  docId: string,
  buffer: Buffer,
  paragraphMap: ParagraphMapEntry[],
): Promise<void> {
  try {
    const dir = dirFor(docId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ORIGINAL), buffer);
    await fs.writeFile(
      path.join(dir, MAP),
      JSON.stringify({ version: MAP_VERSION, paragraphMap }),
    );
  } catch (err) {
    // Losing this costs surgical export for one document; it must not cost the
    // upload itself.
    console.error(`[docx] could not keep the original for ${docId}:`, err);
  }
}

export async function hasOriginalDocx(docId: string): Promise<boolean> {
  try {
    await fs.access(path.join(dirFor(docId), ORIGINAL));
    return true;
  } catch {
    return false;
  }
}

export interface LoadedOriginal {
  buffer: Buffer;
  paragraphMap: ParagraphMapEntry[];
}

/**
 * The stored original and map, or null with a reason the caller can report.
 * A version mismatch is treated as absent — a map whose meaning has changed is
 * worse than no map.
 */
export async function loadOriginalDocx(
  docId: string,
): Promise<
  { ok: true; value: LoadedOriginal } | { ok: false; reason: "no-original" | "map-missing" | "map-stale" }
> {
  const dir = dirFor(docId);
  let buffer: Buffer;
  try {
    buffer = await fs.readFile(path.join(dir, ORIGINAL));
  } catch {
    return { ok: false, reason: "no-original" };
  }
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, MAP), "utf-8");
  } catch {
    return { ok: false, reason: "map-missing" };
  }
  try {
    const parsed = JSON.parse(raw) as {
      version?: number;
      paragraphMap?: ParagraphMapEntry[];
    };
    if (parsed.version !== MAP_VERSION || !Array.isArray(parsed.paragraphMap)) {
      return { ok: false, reason: "map-stale" };
    }
    return { ok: true, value: { buffer, paragraphMap: parsed.paragraphMap } };
  } catch {
    return { ok: false, reason: "map-stale" };
  }
}
