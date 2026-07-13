// ── AI "auto-format for ebook" pass ──
//
// Runs a single-pass, formatting-only LLM rewrite over a finished manuscript:
// normalizes chapter headings, canonicalizes scene breaks, and tidies paragraph
// spacing — WITHOUT changing the prose. Images are shielded behind opaque
// placeholder tokens so the model can never move, drop, or reword them.

import { splitIntoChunks } from "./chunking.js";
import { editChunkStream } from "./llm.js";
import { buildFormatEbookPrompt } from "./prompts.js";
import { appendLog } from "./logBus.js";

// Roughly one chunk ≈ 1500 words. The model's output is about the same size as
// its input for a formatting pass, so keep chunks comfortably inside context.
const TARGET_WORDS = 1500;

const IMG_REF_RE = /!\[[^\]]*\]\([^)]*\)/g;
const IMG_TOKEN_RE = /⟦IMG:(\d+)⟧/g;

/** Replace markdown image refs with opaque placeholders the LLM won't touch. */
function protectImages(md: string): { text: string; images: string[] } {
  const images: string[] = [];
  const text = md.replace(IMG_REF_RE, (match) => {
    const idx = images.length;
    images.push(match);
    return `⟦IMG:${idx}⟧`;
  });
  return { text, images };
}

/** Restore image placeholders back to their original markdown refs. */
function restoreImages(md: string, images: string[]): string {
  return md.replace(IMG_TOKEN_RE, (whole, n: string) => {
    const idx = Number(n);
    return images[idx] ?? whole;
  });
}

/** Strip any stray preamble/code fences a model may wrap the output in. */
function cleanModelOutput(raw: string): string {
  let out = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Drop a leading ```/```markdown fence and its closing fence, if present.
  if (out.startsWith("```")) {
    out = out.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return out;
}

export interface FormatEbookOptions {
  signal?: AbortSignal;
  /** Called after each chunk completes (1-based done / total). */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Format `md` for ebook publication using `model`. Returns the reformatted
 * markdown with images preserved verbatim in their original positions.
 */
export async function formatEbookMarkdown(
  model: string,
  md: string,
  opts: FormatEbookOptions = {},
): Promise<string> {
  const { signal, onProgress } = opts;
  const { text, images } = protectImages(md);

  const systemPrompt = buildFormatEbookPrompt();
  const chunks = splitIntoChunks(text, TARGET_WORDS, 0);
  const total = chunks.length;

  appendLog({
    level: "info",
    source: "ebook",
    message: `Auto-formatting manuscript for ebook (${total} chunk${total === 1 ? "" : "s"})…`,
  });

  const formatted: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error("aborted");
    let raw = "";
    for await (const tok of editChunkStream(
      model,
      chunks[i].body,
      systemPrompt,
      signal,
    )) {
      raw += tok;
    }
    formatted.push(cleanModelOutput(raw));
    onProgress?.(i + 1, total);
    appendLog({
      level: "info",
      source: "ebook",
      message: `Formatted chunk ${i + 1}/${total}.`,
    });
  }

  const merged = formatted.join("\n\n");
  return restoreImages(merged, images);
}
