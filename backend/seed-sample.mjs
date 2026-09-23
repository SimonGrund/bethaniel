// Seed the dev database with two finished jobs, so the review screen can be
// looked at without running a model:
//
//   job-copyedit  a copy_edit task  -> the interactive fix-less card
//   job-scan      a proofread task + a publication_scan task -> read-only
//
// loadTaskStates() runs at queue startup, so the backend picks these up on
// boot and broadcasts them like any finished work.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const db = new Database(process.argv[2]);

const CHAPTER = `# Chapter One

The last of the vaelfyre burned low in the grate, and Bria watched it go.

She had read the letter form the king twice over, and still it made no sense.
The barque rode low in the water beyond the harbour wall, its mastheads bare.

“Per’aps we should wait," Tobias said. “Until the tide turns, at least.”

“That will never work.

She turned to the window and said nothing for a long while.

“Fine,” he said.

Outside, the vaelfyre lanterns guttered along the quay. Bria counted nine of
them before she gave up and turned back to the fire.

The vaelfyre would not last the night. Nothing here would.
`;

/** One correction the way the backend emits it. */
const c = (o, corrected, reason, extra = {}) => ({
  id: randomUUID(),
  original: o,
  corrected,
  reason,
  chunk: "Chunk 1/1",
  ...extra,
});

const corrections = [
  // Fix-less findings — the new card. "vaelfyre" occurs three times, so the
  // ×3 count and the "3 findings withdrawn" toast are both visible.
  c("vaelfyre", "vaelfyre", "spell-check-unknown", {
    flagged: true,
    reviewReason:
      "No dictionary recognises this word. Check it — no replacement is proposed.",
  }),
  c("barque", "barque", "spell-check-unknown", {
    flagged: true,
    reviewReason:
      "No dictionary recognises this word. Check it — no replacement is proposed.",
  }),
  c("Per’aps", "Per’aps", "spell-check-unknown", {
    flagged: true,
    reviewReason:
      "No dictionary recognises this word. Check it — no replacement is proposed.",
  }),
  // An ordinary correction, so the two card shapes sit side by side.
  c("form the", "from the", "confusable:form-det", {
    confidence: 5,
    note: '"form" before a determiner is almost always "from".',
  }),
];

const task = (over) => ({
  id: over.id,
  jobId: over.jobId,
  status: "done",
  progress: 1,
  phase: "",
  name: over.name,
  source: "vaelfyre-sample.docx",
  mode: over.mode,
  wordCount: 96,
  submittedAt: Date.now() - 60_000,
  startedAt: Date.now() - 55_000,
  finishedAt: Date.now() - 5_000,
  unitIndex: 0,
  manuscriptLang: "en",
  model: "seeded-for-review",
  editOptions: { englishDialect: "american", quoteStyle: "curly" },
  result: over.result,
});

const editResult = {
  originalText: CHAPTER,
  editedText: CHAPTER.replace("form the king", "from the king"),
  corrections,
  skipped: [],
  errors: [],
};

const rows = [
  task({
    id: "seed-copyedit-1",
    jobId: "job-copyedit",
    name: "Chapter One",
    mode: "copy_edit",
    result: editResult,
  }),
  // A scan job: the proofread task carries the findings, and the presence of
  // a publication_scan task in the same job is what makes the cards read-only.
  task({
    id: "seed-proofread-1",
    jobId: "job-scan",
    name: "Chapter One",
    mode: "proofread",
    result: editResult,
  }),
  task({
    id: "seed-scan-1",
    jobId: "job-scan",
    name: "Publication scan",
    mode: "publication_scan",
    result: {
      originalText: CHAPTER,
      editedText: CHAPTER,
      corrections: [],
      skipped: [],
      errors: [],
      structuredData: {
        title: "Publication readiness scan",
        chaptersScanned: 1,
        summary: { error: 0, warning: 0, info: 0 },
        findings: [],
      },
    },
  }),
];

const stmt = db.prepare(
  "INSERT OR REPLACE INTO tasks (id, state, finished_at) VALUES (?, ?, ?)",
);
for (const r of rows) stmt.run(r.id, JSON.stringify(r), r.finishedAt);
console.log(`seeded ${rows.length} tasks into ${process.argv[2]}`);
