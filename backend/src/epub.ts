// ── EPUB3 builder (pure JS, offline) ──
//
// Builds a valid EPUB3 from manuscript Markdown using JSZip (already a
// dependency). Reuses chapter detection (chapters.ts) and the shared markdown
// renderer (conversion.mdToHtml) so DOCX and EPUB stay visually consistent.
// Embedded images are copied into the EPUB and referenced relatively.

import JSZip from "jszip";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { findChapters } from "./chapters.js";
import {
  mdToHtml,
  resolveMediaPath,
  type ImageResolver,
  DEFAULT_DOCX_EXPORT_OPTIONS,
} from "./conversion.js";
import { SCENE_BREAK_MARKER } from "./sceneBreaks.js";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  tiff: "image/tiff",
  bmp: "image/bmp",
};

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

interface EmbeddedImage {
  href: string; // e.g. "images/image1.png"
  id: string;
  mediaType: string;
  data: Buffer;
}

export interface EpubOptions {
  title?: string;
  author?: string;
  language?: string;
}

/** Build an EPUB3 file from Markdown. Returns the zip as a Buffer. */
export async function markdownToEpub(
  md: string,
  opts: EpubOptions = {},
): Promise<Buffer> {
  const title = opts.title?.trim() || "Untitled";
  const author = opts.author?.trim() || "Unknown";
  const language = opts.language || "en";
  const bookId = `urn:uuid:${randomUUID()}`;

  // ── Collect chapters ──
  // Normalize raw scene-break variants so findChapters() Phase 3 never
  // mistakes them for chapter boundaries, and so blank-line scene breaks
  // (empty Word paragraphs) render as visual dividers instead of being lost.
  // Order matters: explicit markers first, then blank-line heuristic.
  const normalizedMd = md
    .replace(/^[ \t]*(\*[ \t]*){3,}[ \t]*$/gm, SCENE_BREAK_MARKER)
    .replace(/^[ \t]*-{3,}[ \t]*$/gm, SCENE_BREAK_MARKER)
    .replace(/^[ \t]*_{3,}[ \t]*$/gm, SCENE_BREAK_MARKER)
    .replace(/\n{3,}/g, `\n\n${SCENE_BREAK_MARKER}\n\n`);
  let chapters = findChapters(normalizedMd).map((c) => ({
    title: c.title,
    md: normalizedMd.slice(c.start, c.end),
  }));
  if (chapters.length === 0) {
    chapters = [{ title, md: normalizedMd }];
  }

  // ── Image collection: dedupe by source path → one EPUB entry each ──
  const images: EmbeddedImage[] = [];
  const imageBySrc = new Map<string, EmbeddedImage>();

  const epubImageResolver: ImageResolver = (alt, src) => {
    try {
      let entry = imageBySrc.get(src);
      if (!entry) {
        const abs = src.startsWith("media/") ? resolveMediaPath(src) : src;
        const data = fs.readFileSync(abs);
        const ext = path.extname(abs).slice(1).toLowerCase();
        const idx = images.length + 1;
        const href = `images/image${idx}.${ext || "png"}`;
        entry = {
          href,
          id: `img${idx}`,
          mediaType: MIME_BY_EXT[ext] ?? "image/png",
          data,
        };
        images.push(entry);
        imageBySrc.set(src, entry);
      }
      return `<img src="${entry.href}" alt="${escapeXml(alt)}" />`;
    } catch {
      return ""; // image missing — drop gracefully
    }
  };

  // ── Render each chapter to XHTML ──
  const renderOpts = { ...DEFAULT_DOCX_EXPORT_OPTIONS };
  const chapterFiles = chapters.map((ch, i) => {
    const body = mdToHtml(ch.md, renderOpts, epubImageResolver);
    const href = `chapter${i + 1}.xhtml`;
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}">
<head>
<meta charset="utf-8" />
<title>${escapeXml(ch.title || title)}</title>
<link rel="stylesheet" type="text/css" href="style.css" />
</head>
<body>
${body}
</body>
</html>`;
    return { id: `chap${i + 1}`, href, title: ch.title || title, xhtml };
  });

  // ── Assemble the zip ──
  const zip = new JSZip();

  // mimetype MUST be first and stored uncompressed.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`,
  );

  const oebps = zip.folder("OEBPS")!;

  oebps.file(
    "style.css",
    `body { font-family: Georgia, "Times New Roman", serif; line-height: 1.5; margin: 5%; }
h1, h2, h3 { text-align: center; margin: 1.5em 0 1em; page-break-before: always; }
p { margin: 0; text-indent: 1.2em; }
img { max-width: 100%; height: auto; }`,
  );

  for (const cf of chapterFiles) {
    oebps.file(cf.href, cf.xhtml);
  }
  for (const img of images) {
    oebps.file(img.href, img.data);
  }

  // nav.xhtml (EPUB3 table of contents)
  const navItems = chapterFiles
    .map(
      (cf) => `      <li><a href="${cf.href}">${escapeXml(cf.title)}</a></li>`,
    )
    .join("\n");
  oebps.file(
    "nav.xhtml",
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${language}">
<head><meta charset="utf-8" /><title>${escapeXml(title)}</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
${navItems}
    </ol>
  </nav>
</body>
</html>`,
  );

  // toc.ncx (EPUB2 fallback for older readers)
  const navPoints = chapterFiles
    .map(
      (cf, i) =>
        `    <navPoint id="nav${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(
          cf.title,
        )}</text></navLabel><content src="${cf.href}" /></navPoint>`,
    )
    .join("\n");
  oebps.file(
    "toc.ncx",
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${bookId}" /></head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
${navPoints}
  </navMap>
</ncx>`,
  );

  // content.opf (package manifest + spine)
  const manifestItems = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />`,
    `    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />`,
    `    <item id="css" href="style.css" media-type="text/css" />`,
    ...chapterFiles.map(
      (cf) =>
        `    <item id="${cf.id}" href="${cf.href}" media-type="application/xhtml+xml" />`,
    ),
    ...images.map(
      (img) =>
        `    <item id="${img.id}" href="${img.href}" media-type="${img.mediaType}" />`,
    ),
  ].join("\n");
  const spineItems = chapterFiles
    .map((cf) => `    <itemref idref="${cf.id}" />`)
    .join("\n");
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  oebps.file(
    "content.opf",
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${bookId}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>${language}</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
${manifestItems}
  </manifest>
  <spine toc="ncx">
${spineItems}
  </spine>
</package>`,
  );

  const buf = await zip.generateAsync({
    type: "nodebuffer",
    mimeType: "application/epub+zip",
  });
  return buf;
}
