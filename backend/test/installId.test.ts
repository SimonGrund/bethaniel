// The install id sent with cloud quotes, for codes limited per install.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installId, resetInstallIdCache } from "../src/installId.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("made once and kept in the data folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "install-id-"));
  resetInstallIdCache();
  const first = installId(dir);
  assert.match(first, UUID);
  assert.equal(readFileSync(join(dir, "install-id"), "utf8").trim(), first);
  resetInstallIdCache();
  assert.equal(installId(dir), first, "the same id after a restart");
});

test("a damaged file is replaced, not sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "install-id-"));
  writeFileSync(join(dir, "install-id"), "not an id");
  resetInstallIdCache();
  assert.match(installId(dir), UUID);
});
