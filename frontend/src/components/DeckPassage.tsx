import type { ReactNode } from "react";
import { diffTokens, diffWords } from "../wordDiff";
import { emphasisRuns, type Segment } from "../inlineEmphasis";

/**
 * A card's passage — the text before the change, the change as a word diff,
 * the text after — with the manuscript's Markdown emphasis rendered rather
 * than shown: *hello*, not `_hello_`. Emphasis is read across the whole
 * passage, since an italic phrase can contain the change or begin before the
 * passage does (inlineEmphasis.ts).
 */
export function DeckPassage({
  before,
  original,
  corrected,
  unfixable,
  after,
}: {
  before: string;
  original: string;
  corrected: string;
  unfixable: boolean;
  after: string;
}) {
  const segs: Segment[] = [];
  if (before) segs.push({ text: before, kind: "context" });
  if (unfixable) {
    // Nothing is proposed, so there is nothing to diff. The word itself is
    // the finding.
    segs.push({ text: original, kind: "mark" });
  } else {
    for (const p of diffTokens(diffWords(original), diffWords(corrected))) {
      const kind = p.type === "equal" ? "equal" : p.type;
      const last = segs[segs.length - 1];
      if (last && last.kind === kind) last.text += p.text;
      else segs.push({ text: p.text, kind });
    }
  }
  if (after) segs.push({ text: after, kind: "context" });

  return (
    <span className="correction-diff">
      {emphasisRuns(segs).map((r, i) => {
        let inner: ReactNode = r.text;
        if (r.bold) inner = <strong>{inner}</strong>;
        if (r.italic) inner = <em>{inner}</em>;
        switch (r.kind) {
          case "context":
            return <span key={i} className="correction-context">{inner}</span>;
          case "del":
            return <span key={i} className="word-del">{inner}</span>;
          case "ins":
            return <span key={i} className="word-ins">{inner}</span>;
          case "mark":
            return <mark key={i} className="deck-unfixable-word">{inner}</mark>;
          default:
            return <span key={i}>{inner}</span>;
        }
      })}
    </span>
  );
}
