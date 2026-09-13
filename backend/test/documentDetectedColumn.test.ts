// The detected-settings column was added to a table that already exists on
// every installed copy of Bethaniel. CREATE TABLE IF NOT EXISTS does nothing
// to those databases, so without an explicit migration the column is missing,
// every read of it returns undefined, and detection silently stops working for
// exactly the users who have been here longest — while working perfectly on a
// developer's fresh database.
//
// This test builds a database with the PRE-migration schema and then goes in
// through the real db.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import type { DocumentMeta } from "../src/types.ts";

// The schema exactly as it stood before `detected` existed.
const OLD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    md TEXT NOT NULL,
    chapters TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    uploaded_at INTEGER NOT NULL
  );
`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bethaniel-db-"));

// Stand up an old database with one document already in it, the way a real
// upgrade finds things.
const legacy = new Database(path.join(dataDir, "bethaniel.db"));
legacy.exec(OLD_SCHEMA);
legacy
  .prepare(
    `INSERT INTO documents (id, name, md, chapters, word_count, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  .run("old-doc", "Before.md", "# Before\n", "[]", 2, 1700000000000);
legacy.close();

// db.ts resolves DB_PATH at import time, so this has to be set first.
process.env.DATA_DIR = dataDir;
const { saveDocument, getDocument, listDocuments } = await import("../src/db.ts");

test("a database predating the column is migrated rather than broken", () => {
  const before = getDocument("old-doc");
  assert.ok(before, "the existing document must survive the migration");
  assert.equal(before!.name, "Before.md");
  assert.equal(
    before!.detected,
    undefined,
    "a document stored before detection existed simply has none",
  );
});

test("detected settings survive a save and load round trip", () => {
  const doc: DocumentMeta = {
    id: "new-doc",
    name: "After.md",
    md: "# After\n",
    chapters: [],
    wordCount: 2,
    uploadedAt: 1700000001000,
    detected: {
      manuscriptLang: {
        status: "detected",
        value: "en",
        support: 40,
        against: 2,
        sample: 120,
      },
      englishDialect: { status: "unsure", support: 3, against: 2, sample: 5 },
    },
  };
  saveDocument(doc);

  const loaded = getDocument("new-doc");
  assert.deepEqual(
    loaded!.detected,
    doc.detected,
    "the whole detection result must come back intact, unsure entries included",
  );
});

test("listDocuments reports detection the same way getDocument does", () => {
  // The two readers used to build DocumentMeta separately, which is how a new
  // column ends up present on one path and missing on the other.
  const listed = listDocuments().find((d) => d.id === "new-doc");
  assert.deepEqual(listed!.detected, getDocument("new-doc")!.detected);
});
