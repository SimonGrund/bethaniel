// ── Markdown emphasis, rendered instead of shown ──
//
// The manuscript is Markdown, so a card in the review deck used to read
// `_hello_` where the book has *hello*. This reads the emphasis markers
// across a whole card — the passage before the change, the change itself
// (unchanged, deleted and inserted pieces), the passage after — and hands
// back runs of text marked italic or bold, with the markers removed.
//
// Three things make it more than a regex:
//
//   - A card's passage is cut out of a longer text, so it can start or end
//     inside an italic span. A closing marker with no opener in view means
//     the emphasis began before the window; an opener with no closer means
//     it runs past it.
//   - Markers in unchanged text pair across the whole card, because an
//     italic phrase can contain the change. Markers inside a deletion or an
//     insertion pair only within that piece: if Betty proposes adding or
//     removing emphasis, the author must see it, so a marker that would pair
//     with something outside the change stays visible as written.
//   - The usual Markdown restraint: `_` never opens or closes inside a word
//     (snake_case, or a name with an underscore), and a marker with spaces
//     on both sides (`5 * 3`) is not a marker.
//
// Pure; tested from backend/test/inlineEmphasis.test.ts.

export type SegmentKind = "context" | "equal" | "del" | "ins" | "mark";

export interface Segment {
  text: string;
  kind: SegmentKind;
}

export interface Run {
  text: string;
  /** Index of the segment this run came from. */
  segment: number;
  kind: SegmentKind;
  italic: boolean;
  bold: boolean;
}

interface Marker {
  seg: number;
  at: number; // index within the segment's text
  len: 1 | 2;
  ch: "*" | "_";
  canOpen: boolean;
  canClose: boolean;
}

const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
const isPunct = (c: string | undefined) => c !== undefined && !isSpace(c) && !isWordChar(c);

/** Markers in one segment, with what they may do. `prev`/`next` see across
 *  segment boundaries, so a marker at a segment's edge is judged by the
 *  text it actually touches. */
function findMarkers(segs: Segment[], seg: number, charAt: (seg: number, i: number) => string | undefined): Marker[] {
  const text = segs[seg].text;
  const out: Marker[] = [];
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    if (ch !== "*" && ch !== "_") {
      i++;
      continue;
    }
    const len: 1 | 2 = text[i + 1] === ch ? 2 : 1;
    // A run of three or more is a rule or decoration, not emphasis.
    if (text[i + len] === ch) {
      let j = i;
      while (text[j] === ch) j++;
      i = j;
      continue;
    }
    const prev = charAt(seg, i - 1);
    const next = charAt(seg, i + len);
    // CommonMark's flanking rules, simplified: an opener is followed by
    // something visible and not preceded by a word that would make it a
    // closer; a closer is the mirror image.
    const leftFlanking = !isSpace(next) && (!isPunct(next) || isSpace(prev) || isPunct(prev));
    const rightFlanking = !isSpace(prev) && (!isPunct(prev) || isSpace(next) || isPunct(next));
    let canOpen = leftFlanking;
    let canClose = rightFlanking;
    if (ch === "_") {
      canOpen = leftFlanking && (!rightFlanking || isPunct(prev));
      canClose = rightFlanking && (!leftFlanking || isPunct(next));
      // Never inside a word.
      if (isWordChar(prev) && isWordChar(next)) canOpen = canClose = false;
    }
    if (canOpen || canClose) out.push({ seg, at: i, len, ch: ch as "*" | "_", canOpen, canClose });
    i += len;
  }
  return out;
}

interface Pairing {
  /** Marker → its partner, or "start"/"end" for one cut by the window. */
  partner: Map<Marker, Marker | "start" | "end">;
}

/** Pair markers in order, by kind (`*` with `*`, `__` with `__`). With
 *  `openEnds`, an unmatched closer pairs with the window's start and an
 *  unmatched opener with its end; without, they are left unpaired. */
function pair(markers: Marker[], openEnds: boolean): Pairing {
  const partner = new Map<Marker, Marker | "start" | "end">();
  const stacks = new Map<string, Marker[]>();
  for (const m of markers) {
    const key = m.ch + m.len;
    const stack = stacks.get(key) ?? [];
    stacks.set(key, stack);
    if (m.canClose && stack.length > 0) {
      const open = stack.pop()!;
      partner.set(open, m);
      partner.set(m, open);
    } else if (m.canOpen) {
      stack.push(m);
    } else if (m.canClose && openEnds && ![...partner.values()].some((p) => p !== "start" && p !== "end" && p.ch + p.len === key)) {
      // A closer before any opener of its kind: the span began before the
      // window. Only the first such closer per kind, and only while nothing
      // of that kind has paired yet.
      partner.set(m, "start");
    }
  }
  if (openEnds) for (const stack of stacks.values()) for (const m of stack) partner.set(m, "end");
  return { partner };
}

export function emphasisRuns(segs: Segment[]): Run[] {
  const stable = (k: SegmentKind) => k === "context" || k === "equal" || k === "mark";
  // The character beside a position, as the text it belongs to reads. The
  // two sides of a change are alternatives, not neighbours: what follows a
  // deletion in the book is the unchanged text after it, never the
  // insertion that replaces it, and the same in reverse. So stepping out of
  // a deletion skips insertions, and out of an insertion skips deletions.
  const charAt = (from: number, i: number): string | undefined => {
    const skip: SegmentKind | null = segs[from].kind === "del" ? "ins" : segs[from].kind === "ins" ? "del" : "ins";
    let seg = from;
    while (seg >= 0 && seg < segs.length) {
      const t = segs[seg].text;
      if (i >= 0 && i < t.length) return t[i];
      if (i < 0) {
        do seg--; while (seg >= 0 && segs[seg].kind === skip);
        if (seg < 0) return undefined;
        i += segs[seg].text.length;
      } else {
        i -= t.length;
        do seg++; while (seg < segs.length && segs[seg].kind === skip);
      }
    }
    return undefined;
  };

  const all: Marker[] = [];
  for (let s = 0; s < segs.length; s++) all.push(...findMarkers(segs, s, charAt));

  const used = new Set<Marker>();
  // Spans as [startSeg, startAt, endSeg, endAt, style] in reading order.
  const spans: { from: [number, number]; to: [number, number]; bold: boolean }[] = [];
  const pos = (m: Marker | "start" | "end", side: "open" | "close"): [number, number] =>
    m === "start" ? [0, 0] : m === "end" ? [segs.length - 1, segs[segs.length - 1]?.text.length ?? 0] : side === "open" ? [m.seg, m.at + m.len] : [m.seg, m.at];
  const collect = (p: Pairing) => {
    for (const [m, other] of p.partner) {
      used.add(m);
      if (other === "start") spans.push({ from: pos("start", "open"), to: pos(m, "close"), bold: m.len === 2 });
      else if (other === "end") spans.push({ from: pos(m, "open"), to: pos("end", "close"), bold: m.len === 2 });
      else if (m.seg < other.seg || (m.seg === other.seg && m.at < other.at))
        spans.push({ from: pos(m, "open"), to: pos(other, "close"), bold: m.len === 2 });
    }
  };
  collect(pair(all.filter((m) => stable(segs[m.seg].kind)), true));
  for (let s = 0; s < segs.length; s++) {
    if (stable(segs[s].kind)) continue;
    collect(pair(all.filter((m) => m.seg === s), false));
  }

  const hidden = new Set<string>();
  for (const m of used) for (let k = 0; k < m.len; k++) hidden.add(`${m.seg}:${m.at + k}`);
  const inSpan = (seg: number, i: number, bold: boolean) =>
    spans.some(
      (sp) =>
        sp.bold === bold &&
        (seg > sp.from[0] || (seg === sp.from[0] && i >= sp.from[1])) &&
        (seg < sp.to[0] || (seg === sp.to[0] && i < sp.to[1])),
    );

  const runs: Run[] = [];
  for (let s = 0; s < segs.length; s++) {
    const t = segs[s].text;
    for (let i = 0; i < t.length; i++) {
      if (hidden.has(`${s}:${i}`)) continue;
      const italic = inSpan(s, i, false);
      const bold = inSpan(s, i, true);
      const last = runs[runs.length - 1];
      if (last && last.segment === s && last.italic === italic && last.bold === bold) last.text += t[i];
      else runs.push({ text: t[i], segment: s, kind: segs[s].kind, italic, bold });
    }
    // An emptied segment (a change that was only markers) still marks its
    // place, so a deletion of emphasis is not silently invisible.
    if (t.length > 0 && !runs.some((r) => r.segment === s))
      runs.push({ text: t, segment: s, kind: segs[s].kind, italic: false, bold: false });
  }
  return runs;
}
