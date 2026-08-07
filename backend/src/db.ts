// ── SQLite session persistence ──
// Stores uploaded documents so users can resume across backend restarts.

import Database from "better-sqlite3";
import { join } from "path";
import type { DocumentMeta, TaskState } from "./types.js";
import {
  median,
  pushSample,
  type ThroughputProfile,
} from "./modelRecommendation.js";

const DB_PATH = join(process.env.DATA_DIR ?? "./data", "bethaniel.db");

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        md TEXT NOT NULL,
        chapters TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        uploaded_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS style_guides (
        id TEXT PRIMARY KEY DEFAULT 'default',
        content TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        finished_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_finished_at
        ON tasks (finished_at DESC);
      CREATE TABLE IF NOT EXISTS model_perf (
        model_file TEXT PRIMARY KEY,
        samples TEXT NOT NULL,
        words_per_sec REAL,
        updated_at INTEGER NOT NULL
      );
    `);
  }
  return db;
}

export function saveDocument(doc: DocumentMeta): void {
  const d = getDb();
  d.prepare(
    `
    INSERT OR REPLACE INTO documents
      (id, name, md, chapters, word_count, uploaded_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    doc.id,
    doc.name,
    doc.md,
    JSON.stringify(doc.chapters),
    doc.wordCount,
    doc.uploadedAt,
  );
}

export function getDocument(id: string): DocumentMeta | null {
  const d = getDb();
  const row = d.prepare("SELECT * FROM documents WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    md: row.md as string,
    chapters: JSON.parse(row.chapters as string),
    wordCount: row.word_count as number,
    uploadedAt: row.uploaded_at as number,
  };
}

export function listDocuments(): DocumentMeta[] {
  const d = getDb();
  const rows = d
    .prepare("SELECT * FROM documents ORDER BY uploaded_at DESC")
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    md: row.md as string,
    chapters: JSON.parse(row.chapters as string),
    wordCount: row.word_count as number,
    uploadedAt: row.uploaded_at as number,
  }));
}

export function deleteDocument(id: string): void {
  const d = getDb();
  d.prepare("DELETE FROM documents WHERE id = ?").run(id);
}

export function saveStyleGuide(content: string): void {
  const d = getDb();
  d.prepare(
    `
    INSERT OR REPLACE INTO style_guides (id, content, updated_at)
    VALUES ('default', ?, ?)
  `,
  ).run(content, Date.now());
}

export function getStyleGuide(): string | null {
  const d = getDb();
  const row = d
    .prepare("SELECT content FROM style_guides WHERE id = 'default'")
    .get() as Record<string, unknown> | undefined;
  return row ? (row.content as string) : null;
}

// ── Model throughput profiles ──
// What each local model actually achieves on *this* machine. The recommendation
// table is a guess; these are measurements, and they outrank it once there are
// enough of them. Persisted so the profile survives a restart — otherwise every
// launch would have to re-learn that the big model is unusable here.

/** Append one decode tok/s sample for a model, keeping a rolling window. */
export function recordThroughputSample(modelFile: string, tps: number): void {
  if (!Number.isFinite(tps) || tps <= 0) return;
  const d = getDb();
  const row = d
    .prepare("SELECT samples FROM model_perf WHERE model_file = ?")
    .get(modelFile) as { samples: string } | undefined;
  const existing: number[] = row ? safeParseSamples(row.samples) : [];
  const samples = pushSample(existing, tps);
  d.prepare(
    `INSERT INTO model_perf (model_file, samples, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(model_file) DO UPDATE SET samples = excluded.samples,
                                           updated_at = excluded.updated_at`,
  ).run(modelFile, JSON.stringify(samples), Date.now());
}

/**
 * Record the words/second a completed job achieved end to end.
 *
 * Unlike the per-chunk tok/s samples this accounts for parallel slots, so it is
 * the honest number to build a "this will take about N hours" estimate from.
 */
export function recordJobThroughput(
  modelFile: string,
  wordsPerSec: number,
): void {
  if (!Number.isFinite(wordsPerSec) || wordsPerSec <= 0) return;
  const d = getDb();
  d.prepare(
    `INSERT INTO model_perf (model_file, samples, words_per_sec, updated_at)
     VALUES (?, '[]', ?, ?)
     ON CONFLICT(model_file) DO UPDATE SET words_per_sec = excluded.words_per_sec,
                                           updated_at = excluded.updated_at`,
  ).run(modelFile, wordsPerSec, Date.now());
}

/** Every model's measured profile, keyed by GGUF file name. */
export function getThroughputProfiles(): Record<string, ThroughputProfile> {
  const d = getDb();
  const rows = d
    .prepare("SELECT model_file, samples, words_per_sec FROM model_perf")
    .all() as {
    model_file: string;
    samples: string;
    words_per_sec: number | null;
  }[];
  const out: Record<string, ThroughputProfile> = {};
  for (const row of rows) {
    const samples = safeParseSamples(row.samples);
    out[row.model_file] = {
      medianTps: median(samples),
      samples: samples.length,
      wordsPerSec: row.words_per_sec ?? undefined,
    };
  }
  return out;
}

export function clearThroughputProfile(modelFile: string): void {
  getDb().prepare("DELETE FROM model_perf WHERE model_file = ?").run(modelFile);
}

/** A corrupted or hand-edited row must not take the backend down on boot. */
function safeParseSamples(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((n): n is number => typeof n === "number" && n > 0)
      : [];
  } catch {
    return [];
  }
}

// ── Task persistence ──

export function saveTaskState(task: TaskState): void {
  const d = getDb();
  d.prepare(
    `INSERT OR REPLACE INTO tasks (id, state, finished_at) VALUES (?, ?, ?)`,
  ).run(task.id, JSON.stringify(task), task.finishedAt ?? Date.now());
}

const MAX_KEPT_TASKS = 200;

export function loadTaskStates(): TaskState[] {
  const d = getDb();
  const rows = d
    .prepare(
      "SELECT state FROM tasks ORDER BY finished_at DESC LIMIT ?",
    )
    .all(MAX_KEPT_TASKS) as { state: string }[];
  const out: TaskState[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.state));
    } catch {
      // skip corrupt row
    }
  }
  return out;
}

export function pruneOldTasks(): number {
  const d = getDb();
  const row = d
    .prepare("SELECT COUNT(*) as cnt FROM tasks")
    .get() as { cnt: number };
  if (row.cnt <= MAX_KEPT_TASKS) return 0;
  const ids = d
    .prepare(
      "SELECT id FROM tasks ORDER BY finished_at DESC LIMIT -1 OFFSET ?",
    )
    .all(MAX_KEPT_TASKS) as { id: string }[];
  if (ids.length === 0) return 0;
  deleteTaskStatesIn(ids.map((r) => r.id));
  return ids.length;
}

export function deleteTaskState(id: string): void {
  const d = getDb();
  d.prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

export function deleteTaskStatesIn(ids: string[]): void {
  if (ids.length === 0) return;
  const d = getDb();
  const placeholders = ids.map(() => "?").join(",");
  d.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...ids);
}

export function deleteAllTaskStates(): void {
  const d = getDb();
  d.prepare("DELETE FROM tasks").run();
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
