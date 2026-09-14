// The lexicon column, like `detected` before it, lands on a documents table
// that already exists on every installed copy. Same shape of test as
// documentDetectedColumn.test.ts: a database with the previous schema, then
// in through the real db.ts. The one addition is the partial update — a
// tick or an added term must not re-save a whole manuscript.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

import type { DocumentMeta } from "../src/types.ts";
import type { Lexicon } from "../src/lexicon.ts";

// The schema exactly as it stood before `lexicon` existed.
const OLD_SCHEMA = `
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    md TEXT NOT NULL,
    chapters TEXT NOT NULL,
    word_count INTEGER NOT NULL,
    uploaded_at INTEGER NOT NULL,
    detected TEXT
  );
`;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bethaniel-lex-"));
const legacy = new Database(path.join(dataDir, "bethaniel.db"));
legacy.exec(OLD_SCHEMA);
legacy
  .prepare(
    `INSERT INTO documents (id, name, md, chapters, word_count, uploaded_at, detected)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  .run("old-doc", "Before.md", "# Before\n", "[]", 2, 1700000000000, null);
legacy.close();

process.env.DATA_DIR = dataDir;
const { saveDocument, getDocument, listDocuments, updateDocumentLexicon } = await import(
  "../src/db.ts"
);

const LEXICON: Lexicon = {
  version: 1,
  harvestedAt: 1700000002000,
  terms: [
    { term: "Gata", count: 40, kind: "name", source: "harvest", enabled: true },
    { term: "Petran", count: 6, kind: "name", source: "harvest", enabled: true, variants: ["PETRAN"] },
    { term: "Flame Thief", count: 5, kind: "phrase", source: "harvest", enabled: true },
  ],
  nearMisses: [{ term: "Silverhnad", of: "Silverhand", count: 1 }],
};

test("a database predating the column is migrated; the old document has no lexicon", () => {
  const before = getDocument("old-doc");
  assert.ok(before);
  assert.equal(before!.lexicon, undefined);
});

test("a lexicon survives the save and load round trip, on both readers", () => {
  const doc: DocumentMeta = {
    id: "new-doc",
    name: "After.md",
    md: "# After\n",
    chapters: [],
    wordCount: 2,
    uploadedAt: 1700000001000,
    lexicon: LEXICON,
  };
  saveDocument(doc);
  assert.deepEqual(getDocument("new-doc")!.lexicon, LEXICON);
  assert.deepEqual(listDocuments().find((d) => d.id === "new-doc")!.lexicon, LEXICON);
});

test("updateDocumentLexicon writes only the lexicon, and says whether the document existed", () => {
  const amended: Lexicon = {
    ...LEXICON,
    terms: [
      ...LEXICON.terms.map((t) => (t.term === "Petran" ? { ...t, enabled: false } : t)),
      { term: "Vardo", count: 0, kind: "name", source: "manual", enabled: true },
    ],
  };
  assert.equal(updateDocumentLexicon("new-doc", amended), true);
  const doc = getDocument("new-doc")!;
  assert.deepEqual(doc.lexicon, amended);
  assert.equal(doc.md, "# After\n", "the manuscript itself is untouched");
  assert.equal(updateDocumentLexicon("no-such-doc", amended), false);
});
