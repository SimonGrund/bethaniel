// ── RTF text, located and rewritten in place ──
//
// The RTF counterpart of docxSurgery.ts, for Scrivener's content.rtf files.
// RTF interleaves text with control words: "{\f0\fs24\i0 Welcoem to
// chapter 2!}". This scans a file into paragraphs of plain text, and records
// for each stretch of literal text exactly which bytes of the source hold it,
// so an edit can replace those bytes and nothing else. Every control word,
// group and destination is carried through untouched — formatting survives
// because it is never parsed back out and written again.
//
// The same guarantee as the .docx export, for the same reason: an edit is
// applied only where it can be applied without touching formatting. One that
// would cross a control word (an italic boundary, a font switch), a line
// break, a field or a footnote is refused and reported, never guessed.
//
// Strings here are the file read as latin1, so one character is one byte and
// offsets are byte offsets. RTF is 7-bit by construction; anything wider
// arrives as \'hh or \uN escapes, which is how new text is written too.

/** One unbroken stretch of literal text in the source. */
export interface RtfTextNode {
  /** Source offsets of the stretch (escapes included). */
  start: number;
  end: number;
  /** The decoded text. */
  text: string;
  /** Offset of this text within its paragraph's text. */
  textStart: number;
  /** \uc in effect: fallback characters written after each \uN. */
  uc: number;
  /** Inside a field result: visible, but not safe to rewrite. */
  inField: boolean;
}

export interface RtfParagraph {
  index: number;
  /** Plain text. Line breaks (\line) are "\n", tabs "\t". */
  text: string;
  nodes: RtfTextNode[];
}

/** Destinations whose content is not body text. */
const SKIP_DESTINATIONS = new Set([
  "fonttbl", "colortbl", "stylesheet", "listtable", "listoverridetable",
  "info", "pict", "object", "header", "headerl", "headerr", "headerf",
  "footer", "footerl", "footerr", "footerf", "footnote", "annotation",
  "atnid", "atnauthor", "atndate", "atnref", "xe", "tc", "bkmkstart",
  "bkmkend", "themedata", "colorschememapping", "datastore", "latentstyles",
  "rsidtbl", "generator", "mmathPr", "revtbl", "pgdsctbl", "shppict",
  "nonshppict", "shp", "fldinst",
]);

/** Control words that stand for one character of text. */
const CHAR_WORDS: Record<string, string> = {
  emdash: "—",
  endash: "–",
  lquote: "‘",
  rquote: "’",
  ldblquote: "“",
  rdblquote: "”",
  bullet: "•",
  emspace: " ",
  enspace: " ",
};

/** Windows-1252 bytes 0x80–0x9F, which differ from Latin-1. */
const CP1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function cp1252(byte: number): string {
  return String.fromCharCode(CP1252[byte] ?? byte);
}

interface Group {
  skip: boolean;
  uc: number;
  field: boolean;
  /** No control word seen yet: the next one names the destination. */
  fresh: boolean;
}

/** Scan an RTF document into paragraphs of located text. */
export function indexRtf(src: string): RtfParagraph[] {
  const paragraphs: RtfParagraph[] = [];
  let para: RtfParagraph = { index: 0, text: "", nodes: [] };
  let node: RtfTextNode | null = null;
  const stack: Group[] = [{ skip: false, uc: 1, field: false, fresh: false }];
  const top = () => stack[stack.length - 1];

  const closeNode = () => {
    if (node && node.end > node.start) para.nodes.push(node);
    node = null;
  };
  /** Text that has a home in the source, from `from` to `to`. */
  const addText = (text: string, from: number, to: number) => {
    const g = top();
    if (g.skip) return;
    if (!node) {
      node = { start: from, end: to, text: "", textStart: para.text.length, uc: g.uc, inField: g.field };
    }
    node.text += text;
    node.end = to;
    para.text += text;
  };
  /** Text with no source of its own to rewrite (\line, \tab). */
  const addVirtual = (text: string) => {
    if (top().skip) return;
    closeNode();
    para.text += text;
  };
  const endParagraph = () => {
    closeNode();
    paragraphs.push(para);
    para = { index: paragraphs.length, text: "", nodes: [] };
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      closeNode();
      const g = top();
      stack.push({ skip: g.skip, uc: g.uc, field: g.field, fresh: true });
      i++;
      continue;
    }
    if (ch === "}") {
      closeNode();
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      // Raw line ends are formatting of the file, not text.
      i++;
      continue;
    }
    if (ch !== "\\") {
      addText(ch, i, i + 1);
      i++;
      continue;
    }

    // A backslash: control symbol or control word.
    const start = i;
    const next = src[i + 1];
    if (next === undefined) break;
    if (next === "'") {
      const hex = src.slice(i + 2, i + 4);
      addText(cp1252(parseInt(hex, 16)), start, i + 4);
      i += 4;
      continue;
    }
    if (next === "\\" || next === "{" || next === "}") {
      addText(next, start, i + 2);
      i += 2;
      continue;
    }
    if (next === "~") {
      addText(" ", start, i + 2);
      i += 2;
      continue;
    }
    if (next === "_") {
      addText("‑", start, i + 2);
      i += 2;
      continue;
    }
    if (next === "-") {
      addText("­", start, i + 2);
      i += 2;
      continue;
    }
    if (next === "*") {
      top().skip = true;
      i += 2;
      continue;
    }
    if (next === "\r" || next === "\n") {
      // "\" + line end is \par.
      endParagraph();
      i += 2;
      continue;
    }
    if (!/[a-zA-Z]/.test(next)) {
      // Another control symbol (\:, \|): formatting, no text.
      closeNode();
      i += 2;
      continue;
    }

    // Control word: letters, optional signed number, optional one space.
    let j = i + 1;
    while (j < src.length && /[a-zA-Z]/.test(src[j])) j++;
    const word = src.slice(i + 1, j);
    let param: number | null = null;
    const numMatch = /^-?\d+/.exec(src.slice(j, j + 12));
    if (numMatch) {
      param = Number(numMatch[0]);
      j += numMatch[0].length;
    }
    if (src[j] === " ") j++;

    const g = top();
    if (g.fresh) {
      g.fresh = false;
      if (SKIP_DESTINATIONS.has(word)) g.skip = true;
      if (word === "field") g.field = true;
    }

    if (word === "u" && param !== null) {
      // \uN then `uc` fallback characters, which a Unicode reader skips.
      const code = param < 0 ? param + 65536 : param;
      let k = j;
      for (let n = 0; n < g.uc && k < src.length; n++) {
        if (src[k] === "\\" && src[k + 1] === "'") k += 4;
        else if (src[k] === "\\" || src[k] === "{" || src[k] === "}") break;
        else k++;
      }
      addText(String.fromCharCode(code), start, k);
      i = k;
      continue;
    }
    if (word === "uc" && param !== null) {
      closeNode();
      g.uc = param;
      i = j;
      continue;
    }
    if (word === "par") {
      if (!g.skip) endParagraph();
      i = j;
      continue;
    }
    if (word === "line") {
      addVirtual("\n");
      i = j;
      continue;
    }
    if (word === "tab") {
      addVirtual("\t");
      i = j;
      continue;
    }
    if (CHAR_WORDS[word] !== undefined) {
      addText(CHAR_WORDS[word], start, j);
      i = j;
      continue;
    }
    // Any other control word changes formatting: the text either side of it
    // is two stretches, not one.
    closeNode();
    i = j;
  }
  closeNode();
  if (para.text.length > 0 || para.nodes.length > 0) paragraphs.push(para);
  return paragraphs;
}

/** Encode text for an RTF body, with `uc` fallback characters per \uN. */
export function encodeRtfText(text: string, uc: number): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === "{" || ch === "}") out += "\\" + ch;
    else if (code >= 0x20 && code < 0x80) out += ch;
    else {
      // UTF-16 units, signed, as RTF wants them.
      for (const unit of ch.split("").map((c) => c.charCodeAt(0))) {
        const signed = unit > 32767 ? unit - 65536 : unit;
        // With uc0 nothing follows to end the number, so a space does.
        out += `\\u${signed}` + (uc > 0 ? "?".repeat(uc) : " ");
      }
    }
  }
  return out;
}

export interface RtfEdit {
  paragraphIndex: number;
  /** Offsets in the paragraph's plain text. */
  start: number;
  end: number;
  replacement: string;
}

export interface RtfSkip extends RtfEdit {
  original: string;
  reason: "spans-formatting" | "line-break" | "field" | "out-of-range" | "unmappable-paragraph" | "new-line";
}

/**
 * Apply `edits` to `src`. Each edit must fall inside one stretch of literal
 * text; one that does not is returned in `skipped` and the source there is
 * left exactly as it was.
 */
export function rewriteRtf(
  src: string,
  edits: RtfEdit[],
): { rtf: string; applied: number; skipped: RtfSkip[] } {
  const paragraphs = indexRtf(src);
  const skipped: RtfSkip[] = [];
  const perNode = new Map<RtfTextNode, { from: number; to: number; insert: string }[]>();
  let applied = 0;

  for (const e of edits) {
    const p = paragraphs[e.paragraphIndex];
    const skip = (reason: RtfSkip["reason"]) =>
      skipped.push({ ...e, original: p ? p.text.slice(e.start, e.end) : "", reason });
    if (!p) {
      skip("unmappable-paragraph");
      continue;
    }
    if (e.start < 0 || e.end > p.text.length || e.start > e.end) {
      skip("out-of-range");
      continue;
    }
    if (/[\n\t]/.test(e.replacement)) {
      skip("new-line");
      continue;
    }
    const node = p.nodes.find((n) => {
      const nEnd = n.textStart + n.text.length;
      return e.start >= n.textStart && e.end <= nEnd;
    });
    if (!node) {
      // Not inside one stretch: it crosses a control word or a line break.
      skip(/[\n\t]/.test(p.text.slice(e.start, e.end)) ? "line-break" : "spans-formatting");
      continue;
    }
    if (node.inField) {
      skip("field");
      continue;
    }
    const list = perNode.get(node) ?? [];
    list.push({ from: e.start - node.textStart, to: e.end - node.textStart, insert: e.replacement });
    perNode.set(node, list);
    applied++;
  }

  // Each touched stretch is re-encoded whole from its new text; escapes in
  // its untouched part come out equivalent (an "…" stays an "…").
  const splices = [...perNode].map(([node, list]) => {
    let text = node.text;
    for (const part of [...list].sort((a, b) => b.from - a.from)) {
      text = text.slice(0, part.from) + part.insert + text.slice(part.to);
    }
    let encoded = encodeRtfText(text, node.uc);
    // "\b0This": a control word's number may run straight into the text.
    // New text starting with a digit would join the number ("\b05 apples"),
    // so it gets the space RTF reads as the word's end.
    if (/\d/.test(src[node.start - 1] ?? "") && /^\d/.test(encoded)) encoded = " " + encoded;
    return { start: node.start, end: node.end, text: encoded };
  });
  let rtf = src;
  for (const s of splices.sort((a, b) => b.start - a.start)) {
    rtf = rtf.slice(0, s.start) + s.text + rtf.slice(s.end);
  }
  return { rtf, applied, skipped };
}
