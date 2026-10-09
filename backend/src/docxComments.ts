// ── Word comments: one implementation for every export ──
//
// Moved out of docxTracked.ts so the clean export can use it too: a
// translation is always complete now, and where Betty is unsure of a
// paragraph — where it belongs, its layout, its emphasis — she says so in a
// comment on it rather than leaving it in the source language (docxSurgery).
//
// A comment is the part word/comments.xml (created with its content type and
// relationship when the document has none), a range around the commented
// text, and a reference run after it.

import type JSZip from "jszip";

export interface CommentAuthor {
  author: string;
  initials: string;
  /** ISO 8601, as Word writes it. */
  date: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Largest numeric value of `attr` in `xml`, or -1. */
export function maxId(xml: string, attr: string): number {
  let max = -1;
  const re = new RegExp(`${attr}="(\\d+)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) max = Math.max(max, Number(m[1]));
  return max;
}

const COMMENTS_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";
const COMMENTS_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

export function commentXml(id: number, text: string, opts: CommentAuthor): string {
  const paragraphs = text.split(/\n+/).filter((line) => line.trim() !== "");
  const body = (paragraphs.length ? paragraphs : [""])
    .map(
      (line, i) =>
        `<w:p>${i === 0 ? '<w:r><w:annotationRef/></w:r>' : ""}` +
        `<w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`,
    )
    .join("");
  return (
    `<w:comment w:id="${id}" w:author="${esc(opts.author)}" w:date="${opts.date}" ` +
    `w:initials="${esc(opts.initials)}">${body}</w:comment>`
  );
}

/** Add the comments to the package: the part, its content type, its relationship. */
export async function writeComments(
  zip: JSZip,
  documentXml: string,
  comments: string[],
): Promise<void> {
  if (comments.length === 0) return;
  const existing = await zip.file("word/comments.xml")?.async("string");
  if (existing) {
    const close = existing.lastIndexOf("</w:comments>");
    if (close >= 0) {
      zip.file(
        "word/comments.xml",
        existing.slice(0, close) + comments.join("") + existing.slice(close),
      );
      return;
    }
    // An empty part written self-closing (the docx library does this).
    const empty = existing.match(/<w:comments\b[^>]*\/>/);
    if (!empty) throw new Error("word/comments.xml has no <w:comments> element");
    zip.file(
      "word/comments.xml",
      existing.replace(
        empty[0],
        empty[0].replace(/\s*\/>$/, ">") + comments.join("") + "</w:comments>",
      ),
    );
    return;
  }
  // The document's own namespace for w:, so a Strict document gets a
  // comments part in Strict too.
  const ns = documentXml.match(/xmlns:w="([^"]+)"/)?.[1] ?? W_NS;
  zip.file(
    "word/comments.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
      `<w:comments xmlns:w="${ns}">${comments.join("")}</w:comments>`,
  );

  const typesPath = "[Content_Types].xml";
  const types = await zip.file(typesPath)?.async("string");
  if (types && !types.includes('PartName="/word/comments.xml"')) {
    zip.file(
      typesPath,
      types.replace(
        "</Types>",
        `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_TYPE}"/></Types>`,
      ),
    );
  }

  const relsPath = "word/_rels/document.xml.rels";
  const rels = await zip.file(relsPath)?.async("string");
  if (rels && !rels.includes(COMMENTS_REL)) {
    let n = 1;
    while (rels.includes(`Id="rIdBetty${n}"`)) n++;
    zip.file(
      relsPath,
      rels.replace(
        "</Relationships>",
        `<Relationship Id="rIdBetty${n}" Type="${COMMENTS_REL}" Target="comments.xml"/></Relationships>`,
      ),
    );
  }
}

