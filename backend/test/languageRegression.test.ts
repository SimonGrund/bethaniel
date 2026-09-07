// Guard against the one bug this codebase keeps producing.
//
// Five have now been found and fixed, and they are the same bug five times:
// a heuristic that is correct in English, silently wrong in exactly one other
// language, and invisible until a large fixture in that language existed.
//
//   Spanish  COMILLAS_TIPOGRAFICAS rewrote every straight quote to an angle
//            quote. 124 flags on one clean fixture, 248 across the corpus,
//            0 on a real error. Held Spanish precision at 31%.
//   Danish   26,232 dictionary entries carried morphological tags the old
//            spell engine did not strip, so `den`, `havde` and `kom` were
//            unknown words. 34 flags on clean Danish prose.
//   German   93,148 lowercase words collide with a capitalised noun twin, and
//            the old engine kept one of each pair — rejecting 87,955 of its
//            own dictionary. 43 flags on clean German.
//   German   the proper-noun guard protects a mid-sentence capital, which is
//            right in English, Danish and Spanish and describes every noun in
//            German. It discarded all 27 capitalised planted misspellings
//            before the dictionary was consulted. Zero clean-text flags — a
//            pure recall loss, which is why it hid the longest.
//   All      findConfusables() returned [] for anything but English, so no
//            language but English had wrong-word detection at all.
//
// Every one of them was found by running a ~2,300-word fixture through the
// pipeline and reading the output by hand, weeks after the change landed.
// Every one of them is visible in a number that takes eleven seconds to
// compute and needs no model, no GPU and no network.
//
// So this file computes those numbers. It asserts the deterministic layer
// from both sides, because the five bugs came in from both:
//
//   ceiling on the CLEAN fixture    catches a checker that started inventing
//   floor on the ERRORED fixture    catches a checker that stopped looking
//
// Only the two-sided form covers all five. Three of them (Spanish quotes,
// Danish tags, German case) blew the clean ceiling. The fourth (the German
// name guard) left the clean text untouched and only shows up as the floor
// falling out from under the errored fixture. The fifth shows up as a
// language with no confusable sets at all.
//
// The bounds below are deliberately loose — roughly 3x the measured noise and
// 0.75x the measured detections. They are not a quality target and tightening
// them buys nothing. They are there to catch the 10-30x swing that every one
// of these bugs actually produced, without flapping when a dictionary is
// updated or a rule is retuned.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { initSpellchecker, getSpellCorrections } from "../src/spellcheck.ts";
import { findConfusables } from "../src/confusables.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "sample_texts");

const read = (name: string): string =>
  readFileSync(join(FIXTURES, `${name}.md`), "utf-8");

interface LangCase {
  lang: string;
  label: string;
  fixture: string;
  /** Spell flags on the error-free text. Measured, then the ceiling. */
  cleanMeasured: number;
  cleanCeiling: number;
  /** Spell flags on the ~100-error text. Measured, then the floor. */
  erroredMeasured: number;
  erroredFloor: number;
  /** Confusable sets the fixture's clean text triggers. Measured, then floor. */
  confusablesMeasured: number;
}

// Measured 7 Sept 2026 on the current dictionaries, both columns from the same
// run. Update the `measured` fields when a legitimate change moves them; move
// a bound only with a reason.
const LANGUAGES: LangCase[] = [
  { lang: "en", label: "English", fixture: "stress100",
    cleanMeasured: 1, cleanCeiling: 6, erroredMeasured: 37, erroredFloor: 28,
    confusablesMeasured: 25 },
  { lang: "da", label: "Danish", fixture: "stress100da",
    cleanMeasured: 0, cleanCeiling: 5, erroredMeasured: 27, erroredFloor: 20,
    confusablesMeasured: 13 },
  { lang: "de", label: "German", fixture: "stress100de",
    cleanMeasured: 4, cleanCeiling: 12, erroredMeasured: 47, erroredFloor: 36,
    confusablesMeasured: 12 },
  { lang: "es", label: "Spanish", fixture: "stress100es",
    cleanMeasured: 2, cleanCeiling: 8, erroredMeasured: 45, erroredFloor: 34,
    confusablesMeasured: 21 },
];

// Hunspell is WebAssembly, so the module load is async.
before(async () => {
  await initSpellchecker();
});

// ── The clean ceiling ───────────────────────────────────────────────────────
// What an author with a correct manuscript actually experiences. Three of the
// five bugs are a large number in this column and nothing else.

for (const c of LANGUAGES) {
  test(`${c.label}: the spell pass stays quiet on clean prose`, { timeout: 60_000 }, () => {
    const flagged = getSpellCorrections(read(`${c.fixture}_correct`), c.lang)
      .map((x) => x.original);
    assert.ok(
      flagged.length <= c.cleanCeiling,
      `${c.label} clean text: ${flagged.length} spell flags, ceiling ${c.cleanCeiling} ` +
        `(was ${c.cleanMeasured} when measured). Flagged: ${flagged.join(", ")}`,
    );
  });
}

// ── The errored floor ───────────────────────────────────────────────────────
// The side the German name-guard bug came in on. It cost 27 of 27 capitalised
// misspellings and did not move the clean column by one flag, so a
// noise-only guard would have shipped it exactly as the real one did.

for (const c of LANGUAGES) {
  test(`${c.label}: the spell pass still finds the planted misspellings`, { timeout: 60_000 }, () => {
    const found = getSpellCorrections(read(`${c.fixture}_copy_edit`), c.lang);
    assert.ok(
      found.length >= c.erroredFloor,
      `${c.label} errored text: only ${found.length} spell flags, floor ${c.erroredFloor} ` +
        `(was ${c.erroredMeasured} when measured). Something stopped looking.`,
    );
  });
}

// ── Wrong-word detection exists at all ──────────────────────────────────────
// findConfusables() answered [] for every language but English for as long as
// the feature existed. Nothing failed; Danish and German simply had no
// wrong-word detection, and the benchmark read it as a model weakness.

for (const c of LANGUAGES) {
  test(`${c.label}: confusable pairs are actually wired up`, { timeout: 60_000 }, () => {
    const sets = findConfusables(read(`${c.fixture}_correct`), c.lang);
    assert.ok(
      sets.length > 0,
      `${c.label} has no confusable sets — wrong-word detection is off for this ` +
        `language (${c.confusablesMeasured} sets when measured)`,
    );
  });
}

// ── LanguageTool ────────────────────────────────────────────────────────────
// The Spanish quote bug lived here, and it cannot be caught without a running
// server: the rule is LanguageTool's own and the client is a thin wrapper
// around it. So this leg runs only where a server is reachable — locally, and
// on any machine that sets LANGUAGETOOL_JAR — and reports itself skipped in
// CI rather than failing there.
//
//   LANGUAGETOOL_JAR=/path/to/languagetool-server.jar \
//   JAVA_BIN=/path/to/java npm test --workspace=backend
//
// A LanguageTool correction never passes through the reviewer, so a rule that
// misfires reaches the author unfiltered. That is why the bar for adding one
// to ALWAYS_DISABLED_RULES is as harsh as it is, and why this ceiling exists.

const LT_CLEAN_CEILING: Record<string, number> = { en: 6, da: 5, de: 12, es: 8 };
const LT_CLEAN_MEASURED: Record<string, number> = { en: 1, da: 0, de: 4, es: 2 };

const ltConfigured = !!process.env.LANGUAGETOOL_JAR || !!process.env.LANGUAGETOOL_BASE_URL;

// checkText() spawns the Java server on first use and leaves it running, which
// is right in the app and wrong here: a live child process keeps the test
// runner's event loop alive and the file never exits. Stop it on the way out.
after(async () => {
  if (!ltConfigured) return;
  const { shutdownLanguageTool } = await import("../src/languageToolServer.ts");
  await shutdownLanguageTool();
});

for (const c of LANGUAGES) {
  test(
    `${c.label}: LanguageTool stays quiet on clean prose`,
    { skip: ltConfigured ? false : "no LanguageTool server (set LANGUAGETOOL_JAR)", timeout: 180_000 },
    async () => {
      const { checkText } = await import("../src/languageTool.ts");
      const flagged = await checkText(read(`${c.fixture}_correct`), { lang: c.lang });
      assert.ok(
        flagged.length <= LT_CLEAN_CEILING[c.lang],
        `${c.label} clean text: ${flagged.length} LanguageTool flags, ceiling ` +
          `${LT_CLEAN_CEILING[c.lang]} (was ${LT_CLEAN_MEASURED[c.lang]} when measured). ` +
          `Check whether a rule has started firing on house style — see ` +
          `ALWAYS_DISABLED_RULES and the ledger bar above it.`,
      );
    },
  );
}
