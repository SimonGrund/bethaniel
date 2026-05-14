// ── Text chunking with paragraph overlap — ported from book_editor.py ──

import type { ChunkData } from "./types.js";

/** Split text into paragraph blocks, each block keeps its trailing blank line. */
export function splitIntoParagraphs(text: string): string[] {
  const parts = text.split(/(\n\s*\n)/);
  const blocks: string[] = [];
  let buffer = "";

  for (const part of parts) {
    buffer += part;
    if (part.trim() === "") {
      if (buffer.trim()) {
        blocks.push(buffer);
      }
      buffer = "";
    }
  }
  if (buffer.trim()) {
    blocks.push(buffer);
  }
  return blocks;
}

/**
 * Split markdown into chunks of roughly `targetWords` words.
 *
 * Overlap paragraphs let the model see the end of the previous chunk for
 * continuity, then we strip them from the response so they aren't duplicated.
 * Chapter boundaries (lines starting with # or ##) reset overlap to 0.
 */
export function splitIntoChunks(
  text: string,
  targetWords: number,
  overlapParagraphs: number,
): ChunkData[] {
  const paragraphs = splitIntoParagraphs(text);
  const chunks: ChunkData[] = [];
  let currentIndices: number[] = [];
  let currentWords = 0;

  function wordsIn(idx: number): number {
    return paragraphs[idx].split(/\s+/).filter(Boolean).length;
  }

  function flush(headOverlap: number): void {
    if (currentIndices.length === 0) return;
    const body = currentIndices.map((i) => paragraphs[i]).join("");
    const coreIndices = currentIndices.slice(headOverlap);
    const core = coreIndices.map((i) => paragraphs[i]).join("");
    chunks.push({
      body: body.replace(/^\n+|\n+$/g, ""),
      core: core.replace(/^\n+|\n+$/g, ""),
      overlapHeadParagraphs: headOverlap,
    });
    currentIndices = [];
    currentWords = 0;
  }

  let i = 0;
  while (i < paragraphs.length) {
    const para = paragraphs[i];
    const isTopHeading = /^\s*#{1,2}\s/.test(para);

    // Break BEFORE a top-level heading to keep chapters intact.
    if (isTopHeading && currentWords > 0) {
      flush(0); // don't bleed overlap into a new chapter
    }

    currentIndices.push(i);
    currentWords += wordsIn(i);

    if (currentWords >= targetWords) {
      const headOverlap =
        chunks.length === 0
          ? 0
          : Math.min(overlapParagraphs, currentIndices.length - 1);
      flush(headOverlap);
      // Seed next chunk with the last `overlapParagraphs` paragraphs.
      if (overlapParagraphs > 0 && i + 1 < paragraphs.length) {
        const seedStart = Math.max(0, i + 1 - overlapParagraphs);
        currentIndices = Array.from(
          { length: i + 1 - seedStart },
          (_, k) => seedStart + k,
        );
        currentWords = currentIndices.reduce((s, j) => s + wordsIn(j), 0);
      }
    }
    i++;
  }

  const headOverlap =
    chunks.length === 0
      ? 0
      : Math.min(overlapParagraphs, currentIndices.length - 1);
  flush(Math.max(0, headOverlap));
  return chunks;
}

/** Drop the first N paragraphs from the model's response (overlap context). */
export function stripOverlapFromResponse(
  response: string,
  overlapParagraphs: number,
): string {
  if (overlapParagraphs <= 0) return response;
  const paragraphs = splitIntoParagraphs(response);
  if (paragraphs.length <= overlapParagraphs) {
    return response; // Model returned less than expected — keep everything
  }
  return paragraphs
    .slice(overlapParagraphs)
    .join("")
    .replace(/^\n+|\n+$/g, "");
}
