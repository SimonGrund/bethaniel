// ── The review table ──
//
// Every suggestion of the copy edits, line edits and readthroughs on this
// machine, with what the author did about it — exported from Settings so an
// author who wants to can send their reviews to the developer. The answers
// live here (acceptances and the deck's log, in the store); the suggestions
// come from the backend. This joins them, one row per suggestion.
//
// Pure; tested from backend/test/reviewTable.test.ts.

import type { Decision } from "./decisionLog";
import type { Correction, TaskResult } from "./types";

/** The modes whose results are suggestions the author reviews. */
export const REVIEW_MODES = ["copy_edit", "line_edit", "combined_edit", "proofread"];

export const REVIEW_HEADER = [
  "Document",
  "Chapter",
  "Mode",
  "Kind",
  "Original",
  "Suggestion",
  "Context",
  "Editor's reason",
  "Reviewer score (1-5)",
  "Reviewer note",
  "Flagged",
  "Pre-approved",
  "Blocks publication",
  "Response",
  "Answered in review deck",
  "Language",
  "Model",
  "App version",
  "Finished",
  "Task id",
  "Correction id",
];

export interface ReviewTask {
  id: string;
  name: string;
  source: string;
  mode: string;
  status: string;
  finishedAt?: number;
  model?: string;
  appVersion?: string;
  manuscriptLang?: string;
}

/** What the author did with one suggestion. An occurrence is accepted as
 *  `<id>:<n>`, so some but not all of them is "partly". */
export function reviewResponse(
  c: Pick<Correction, "id" | "original" | "corrected" | "reason">,
  accepted: Set<string> | undefined,
  answered: boolean,
): string {
  const id = c.id ?? "";
  if (id && accepted?.has(id)) {
    return c.reason === "author-correction" ? "accepted (author's own fix)" : "accepted";
  }
  if (id && accepted && [...accepted].some((k) => k.startsWith(`${id}:`))) return "partly accepted";
  return answered ? "dismissed" : "not answered";
}

/** The sentence or so around a suggestion, so a row can be read alone. */
function contextOf(text: string, original: string): string {
  const at = original ? text.indexOf(original) : -1;
  if (at < 0) return "";
  const from = Math.max(0, at - 120);
  const to = Math.min(text.length, at + original.length + 120);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`.replace(/\s+/g, " ");
}

const yes = (b: boolean | undefined) => (b ? "yes" : "");

export function reviewTable(
  tasks: ReviewTask[],
  results: Record<string, TaskResult>,
  accepted: Record<string, Set<string>>,
  decisionLog: Decision[],
): string[][] {
  const answered = new Set(decisionLog.map((d) => `${d.taskId}\u0000${d.correctionId}`));
  const rows: string[][] = [REVIEW_HEADER];
  const ordered = tasks
    .filter((t) => t.status === "done" && REVIEW_MODES.includes(t.mode) && results[t.id])
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
  for (const t of ordered) {
    const r = results[t.id];
    for (const c of r.corrections ?? []) {
      const wasAnswered = answered.has(`${t.id}\u0000${c.id ?? ""}`);
      rows.push([
        t.source,
        t.name,
        t.mode,
        c.editType ?? "",
        c.original,
        c.corrected,
        contextOf(r.originalText ?? "", c.original),
        c.reason ?? "",
        c.confidence !== undefined ? String(c.confidence) : "",
        c.reviewReason ?? "",
        yes(c.flagged),
        yes(c.preApproved),
        yes(c.blocksPublication),
        reviewResponse(c, accepted[t.id], wasAnswered),
        yes(wasAnswered),
        t.manuscriptLang ?? "",
        t.model ?? "",
        t.appVersion ?? "",
        t.finishedAt ? new Date(t.finishedAt).toISOString().slice(0, 10) : "",
        t.id,
        c.id ?? "",
      ]);
    }
  }
  return rows;
}
