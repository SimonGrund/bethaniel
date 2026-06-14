// ── Diff generation — ported from book_editor.py + ui.py ──

import { diffWordsWithSpace } from "diff";
import type { Correction } from "./types.js";

/** Tokenize text into words, whitespace, and punctuation — matches Python _tok(). */
function tokenize(s: string): string[] {
  return s.match(/\s+|\w+|[^\w\s]/g) ?? [];
}

/** Generate inline HTML diff with word-level ins/del spans. */
export function inlineDiffHtml(before: string, after: string): string {
  const changes = diffWordsWithSpace(before, after);
  const parts: string[] = [];

  for (const change of changes) {
    const escaped = escapeHtml(change.value);
    if (change.added) {
      parts.push(`<span class="word-ins">${escaped}</span>`);
    } else if (change.removed) {
      parts.push(`<span class="word-del">${escaped}</span>`);
    } else {
      parts.push(escaped);
    }
  }
  return parts.join("");
}

/** Build a correction card HTML string. */
export function correctionCard(
  original: string,
  corrected: string,
  label = "",
): string {
  const lbl = label
    ? `<div style="font-size:0.75rem;color:#64748b;margin-bottom:0.25rem;">${escapeHtml(label)}</div>`
    : "";
  return (
    `<div class="correction-card">${lbl}` +
    `<div class="correction-diff">${inlineDiffHtml(original, corrected)}</div></div>`
  );
}

/** Generate a unified diff string for a chunk. */
export function makeDiff(before: string, after: string, label: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  // Simple unified diff
  const changes = diffWordsWithSpace(before, after);
  const hasChanges = changes.some((c) => c.added || c.removed);

  if (!hasChanges) {
    return `### ${label}\n_No changes._\n`;
  }

  // Build a basic unified diff representation
  const lines: string[] = [`--- ${label} (original)`, `+++ ${label} (edited)`];

  // Line-by-line diff
  const maxLen = Math.max(beforeLines.length, afterLines.length);
  let i = 0,
    j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    const bl = i < beforeLines.length ? beforeLines[i] : undefined;
    const al = j < afterLines.length ? afterLines[j] : undefined;
    if (bl === al) {
      lines.push(` ${bl}`);
      i++;
      j++;
    } else {
      if (bl !== undefined) {
        lines.push(`-${bl}`);
        i++;
      }
      if (al !== undefined) {
        lines.push(`+${al}`);
        j++;
      }
    }
  }

  return `### ${label}\n\`\`\`diff\n${lines.join("\n")}\n\`\`\`\n`;
}

/** Formatting signature — fingerprint of structural markdown elements. */
export function formattingSignature(text: string): Record<string, number> {
  return {
    paragraphs: text.trim().split(/\n\s*\n/).length,
    headings: (text.match(/(?:^|\n)#{1,6}\s/g) ?? []).length,
    bold_markers: (text.match(/\*\*/g) ?? []).length,
    code_fences: (text.match(/```/g) ?? []).length,
    blockquotes: (text.match(/(?:^|\n)\s*>/g) ?? []).length,
    list_items: (text.match(/(?:^|\n)\s*(?:[-*+]|\d+\.)\s/g) ?? []).length,
  };
}

/** Compare two formatting signatures and return warnings. */
export function compareSignatures(
  before: Record<string, number>,
  after: Record<string, number>,
): string[] {
  const warnings: string[] = [];
  for (const key of Object.keys(before)) {
    if (before[key] !== after[key]) {
      warnings.push(`${key}: ${before[key]} → ${after[key]}`);
    }
  }
  return warnings;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Extract correction pairs from the diff between original and rewritten text.
 * Walks word-level changes grouping consecutive removed→added sequences into
 * {original, corrected} pairs suitable for the accept/dismiss review UI.
 */
export function extractCorrectionsFromDiff(
  original: string,
  rewritten: string,
): Correction[] {
  const changes = diffWordsWithSpace(original, rewritten);
  const corrections: Correction[] = [];

  let i = 0;
  while (i < changes.length) {
    // Skip unchanged tokens
    while (i < changes.length && !changes[i].added && !changes[i].removed) i++;
    if (i >= changes.length) break;

    // Collect removed tokens (exist only in original)
    const removed: string[] = [];
    while (i < changes.length && changes[i].removed) {
      removed.push(changes[i].value);
      i++;
    }

    // Collect added tokens (exist only in rewritten)
    const added: string[] = [];
    while (i < changes.length && changes[i].added) {
      added.push(changes[i].value);
      i++;
    }

    const orig = removed.join("").trim();
    const corr = added.join("").trim();
    if (orig && corr && orig !== corr) {
      corrections.push({ original: orig, corrected: corr });
    }
  }

  return corrections;
}
