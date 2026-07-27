// Live end-to-end test for the LanguageTool integration: actually spawns the
// bundled Java server and runs a real /v2/check. Gated behind LT_LIVE_TEST so
// the normal `npm test` stays fast and hermetic (no Java process, no port).
//
// Run it with a LanguageTool distribution present in
// electron/resources/languagetool/ (or LANGUAGETOOL_JAR set):
//   LT_LIVE_TEST=1 npx tsx --test test/languageToolLive.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isLanguageToolAvailable,
  ensureLanguageToolRunning,
  shutdownLanguageTool,
} from "../src/languageToolServer.ts";
import { checkText } from "../src/languageTool.ts";

const enabled = process.env.LT_LIVE_TEST === "1" && isLanguageToolAvailable();

test(
  "LanguageTool live: spawns the server and fixes a real grammar/typo error",
  { skip: enabled ? false : "set LT_LIVE_TEST=1 with a bundled LanguageTool to run" },
  async () => {
    await ensureLanguageToolRunning();
    try {
      const text =
        "She go to the store yesterday and she dont have any money.";
      const cs = await checkText(text, { lang: "en", dialect: "american" });
      // At minimum LanguageTool should fix the missing-apostrophe typo, anchored
      // with surrounding context so it applies unambiguously.
      const dont = cs.find((c) => /\bdon't\b/.test(c.corrected));
      assert.ok(dont, `expected a don't fix, got ${JSON.stringify(cs)}`);
      assert.ok(dont!.original.includes("dont"), "original keeps the misspelling in context");
      assert.ok((dont!.reason ?? "").startsWith("grammar"), "tagged as a grammar correction");
    } finally {
      await shutdownLanguageTool();
    }
  },
);
