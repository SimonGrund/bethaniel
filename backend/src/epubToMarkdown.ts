// ── EPUB → Markdown ──
//
// An EPUB is a zip of XHTML, so unlike a PDF the text is text: paragraphs are
// paragraphs, italics are <em>, and nothing has to be inferred from geometry.
//
// It exists because a print-ready PDF could not be read at all — its fonts map
// to the wrong characters, and neither pdfjs nor poppler can recover them. The
// EPUB exported from the same typesetting run carries the same final text,
// correctly, and is a fraction of the size.
//
// Reading order comes from the spine. A zip has no inherent order and a
// manifest is not sorted, so the spine is the only statement of what order a
// book is read in.

import JSZip from "jszip";

/** Not an EPUB, or one whose package document cannot be found. */
export class InvalidEpubError extends Error {
  constructor(detail: string) {
    super(`This EPUB could not be read (${detail}).`);
    this.name = "InvalidEpubError";
  }
}

/** Strip a namespace prefix so `opf:href` and `href` both match. */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*"([^"]*)"`, "i").exec(
    tag,
  );
  return m ? m[1] : null;
}

/** Resolve an href against the directory holding the package document. */
function resolveHref(baseDir: string, href: string): string {
  const clean = decodeURIComponent(href.split("#")[0]);
  if (!baseDir) return clean;
  const parts = `${baseDir}/${clean}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Path of the package document, per META-INF/container.xml. */
async function findOpfPath(zip: JSZip): Promise<string> {
  const container = await zip.file("META-INF/container.xml")?.async("string");
  if (container) {
    const m = /<rootfile\b[^>]*>/i.exec(container);
    const full = m ? attr(m[0], "full-path") : null;
    if (full) return decodeURIComponent(full);
  }
  // Some producers omit the container. Fall back to any .opf in the archive
  // rather than refuse a book that is otherwise perfectly readable.
  const opf = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".opf"));
  if (!opf) throw new InvalidEpubError("no package document");
  return opf;
}

/**
 * Whether a content document is prose rather than apparatus.
 *
 * The table of contents is a list of every chapter title; imported as prose it
 * would be edited as if the author had written it.
 */
function isProse(html: string, href: string): boolean {
  if (/epub:type\s*=\s*"[^"]*\b(toc|landmarks|page-list|cover)\b/i.test(html)) {
    return false;
  }
  return !/(^|\/)(nav|toc|cover|titlepage)\.x?html?$/i.test(href);
}

/** Body content only; head, scripts and styles are not prose. */
function bodyOf(html: string): string {
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  const inner = body ? body[1] : html;
  return inner
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, "");
}

let _turndown: import("turndown") | null = null;
async function getTurndown() {
  if (_turndown) return _turndown;
  const { default: TurndownCtor } = await import("turndown");
  const td = new TurndownCtor({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "_",
  });
  td.addRule("lineBreak", { filter: "br", replacement: () => "\n" });
  // Images have no counterpart in the extracted manuscript; a bare alt text
  // reads as prose the author did not write.
  td.addRule("dropImages", { filter: "img", replacement: () => "" });
  _turndown = td as never;
  return _turndown as unknown as { turndown: (html: string) => string };
}

/** Read an EPUB into markdown, in spine order. */
export async function epubToMarkdown(buffer: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    throw new InvalidEpubError("not a zip archive");
  }

  const opfPath = await findOpfPath(zip);
  const opf = await zip.file(opfPath)?.async("string");
  if (!opf) throw new InvalidEpubError("package document missing");

  const baseDir = opfPath.includes("/")
    ? opfPath.slice(0, opfPath.lastIndexOf("/"))
    : "";

  // id → href, for the spine to point at.
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const id = attr(m[0], "id");
    const href = attr(m[0], "href");
    if (id && href) manifest.set(id, href);
  }

  const order: string[] = [];
  for (const m of opf.matchAll(/<itemref\b[^>]*>/gi)) {
    const idref = attr(m[0], "idref");
    const href = idref ? manifest.get(idref) : null;
    if (href) order.push(href);
  }
  // A book with no spine is unusual but readable; fall back to the manifest.
  const hrefs = order.length > 0 ? order : [...manifest.values()];
  if (hrefs.length === 0) throw new InvalidEpubError("no content documents");

  const td = await getTurndown();
  const parts: string[] = [];
  for (const href of hrefs) {
    if (!/\.x?html?$/i.test(href)) continue;
    const file = zip.file(resolveHref(baseDir, href));
    if (!file) continue;
    const html = await file.async("string");
    if (!isProse(html, href)) continue;
    const md = td.turndown(bodyOf(html)).trim();
    if (md) parts.push(md);
  }

  if (parts.length === 0) throw new InvalidEpubError("no readable text");
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
