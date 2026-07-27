// Tests for the LanguageTool supervisor's degradation contract. Whether a
// LanguageTool distribution is present on disk varies by machine, so these
// assert the environment-independent guarantees: availability is a boolean
// that never throws, the global off-switch forces it off (and ensure becomes a
// no-op), and the base URL is a loopback address.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isLanguageToolAvailable,
  getLanguageToolBaseUrl,
  ensureLanguageToolRunning,
} from "../src/languageToolServer.ts";

test("availability check returns a boolean and never throws", () => {
  assert.equal(typeof isLanguageToolAvailable(), "boolean");
});

test("LANGUAGETOOL_DISABLED forces unavailable and ensure becomes a no-op", async () => {
  const prev = process.env.LANGUAGETOOL_DISABLED;
  process.env.LANGUAGETOOL_DISABLED = "1";
  try {
    assert.equal(isLanguageToolAvailable(), false);
    await ensureLanguageToolRunning(); // must not spawn / throw / hang
  } finally {
    if (prev === undefined) delete process.env.LANGUAGETOOL_DISABLED;
    else process.env.LANGUAGETOOL_DISABLED = prev;
  }
});

test("base URL is a local loopback address", () => {
  assert.match(getLanguageToolBaseUrl(), /^http:\/\/127\.0\.0\.1:\d+$/);
});
