// ── SQLite session persistence ──
// Stores uploaded documents so users can resume across backend restarts.

import Database from "better-sqlite3";
import { join } from "path";
import type { DocumentMeta } from "./types.js";

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
    `);
  }
  return db;
}

export function saveDocument(doc: DocumentMeta): void {
  const d = getDb();
  d.prepare(
    `
    INSERT OR REPLACE INTO documents (id, name, md, chapters, word_count, uploaded_at)
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

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
