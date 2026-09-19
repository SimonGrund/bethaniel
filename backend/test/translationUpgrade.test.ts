// Tests for the translation upgrade stage: structural guards and the
// upgrade → fluency-review → re-polish orchestrator with injected deps.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  draftGuard,
  splitIntoParas,
  upgradeGuard,
} from "../src/translationUpgrade.ts";

const DRAFT =
  "Para one draft sentence.\n\nPara two draft sentence.\n\nPara three draft sentence.";
const POLISHED =
  "Para one polished sentence.\n\nPara two polished sentence.\n\nPara three polished sentence.";

test("splitIntoParas: splits on blank lines, trims, drops empties", () => {
  assert.deepEqual(splitIntoParas("a\n\n  b  \n\n\n\nc\n"), ["a", "b", "c"]);
  assert.deepEqual(splitIntoParas("   "), []);
});

test("upgradeGuard: accepts same paragraph count and sane length", () => {
  assert.deepEqual(upgradeGuard(DRAFT, POLISHED), { ok: true });
});

test("upgradeGuard: rejects empty output", () => {
  const r = upgradeGuard(DRAFT, "   ");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /empty/i);
});

test("upgradeGuard: rejects paragraph count mismatch", () => {
  const r = upgradeGuard(DRAFT, "Merged into one paragraph.");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /paragraph count/i);
});

test("upgradeGuard: rejects output shorter than 60% of draft", () => {
  const r = upgradeGuard(DRAFT, "a.\n\nb.\n\nc.");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /too short/i);
});

import {
  buildTranslationUpgradePrompt,
  buildFluencyReviewerPrompt,
} from "../src/prompts.ts";

test("buildTranslationUpgradePrompt: names target language, forbids meaning/paragraph changes", () => {
  const p = buildTranslationUpgradePrompt("Danish");
  assert.match(p, /native Danish line editor/i);
  assert.match(p, /Do NOT add, drop, or alter any meaning/);
  assert.match(p, /Do NOT merge, split, add, or remove paragraphs/);
  assert.doesNotMatch(p, /BINDING GLOSSARY/);
});

test("buildTranslationUpgradePrompt: includes binding glossary when style guide given", () => {
  const p = buildTranslationUpgradePrompt("Danish", "Betty → Betty (never translate)");
  assert.match(p, /BINDING GLOSSARY/);
  assert.match(p, /never translate/);
});

test("buildFluencyReviewerPrompt: JSONL contract and drift flagging", () => {
  const p = buildFluencyReviewerPrompt("Danish");
  assert.match(p, /"index": 0, "confidence": 5/);
  assert.match(p, /STRICT JSONL/);
  assert.match(p, /Meaning added, dropped, or altered/);
  assert.doesNotMatch(p, /BINDING GLOSSARY/);
});

test("buildFluencyReviewerPrompt: glossary violations become defects when style guide given", () => {
  const p = buildFluencyReviewerPrompt("Danish", "Betty → Betty (never translate)");
  assert.match(p, /BINDING GLOSSARY/);
  assert.match(p, /VIOLATION/);
});

import {
  runTranslationUpgrade,
  type UpgradeDeps,
  type UpgradeOptions,
} from "../src/translationUpgrade.ts";

function mkOpts(overrides: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    draft: DRAFT,
    upgradePrompt: "UPGRADE-PROMPT",
    reviewMode: false,
    reviewerThreshold: 3,
    chunkLabel: "1/1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function mkDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    editStream: async () => POLISHED,
    runReviewer: async () => new Map(),
    log: () => {},
    setPhase: () => {},
    ...overrides,
  };
}

test("orchestrator: without reviewMode returns the polished text", async () => {
  const out = await runTranslationUpgrade(mkOpts(), mkDeps());
  assert.equal(out, POLISHED);
});

test("orchestrator: guard rejection falls back to the draft", async () => {
  const out = await runTranslationUpgrade(
    mkOpts(),
    mkDeps({ editStream: async () => "Everything merged into one paragraph." }),
  );
  assert.equal(out, DRAFT);
});

test("orchestrator: upgrade pass throwing falls back to the draft", async () => {
  const out = await runTranslationUpgrade(
    mkOpts(),
    mkDeps({
      editStream: async () => {
        throw new Error("slot exhausted");
      },
    }),
  );
  assert.equal(out, DRAFT);
});

test("orchestrator: abort re-throws instead of falling back", async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    runTranslationUpgrade(
      mkOpts({ signal: ctl.signal }),
      mkDeps({
        editStream: async () => {
          throw new Error("aborted");
        },
      }),
    ),
    /aborted/,
  );
});

test("orchestrator: reviewMode with no flags returns polished text", async () => {
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      runReviewer: async () =>
        new Map([
          [0, { confidence: 5, reason: "" }],
          [1, { confidence: 4, reason: "" }],
          [2, { confidence: 5, reason: "" }],
        ]),
    }),
  );
  assert.equal(out, POLISHED);
});

test("orchestrator: flagged paragraph is re-polished from the DRAFT paragraph", async () => {
  const editCalls: { text: string; prompt: string }[] = [];
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      editStream: async (text, prompt) => {
        editCalls.push({ text, prompt });
        return editCalls.length === 1 ? POLISHED : "Para two re-polished sentence.";
      },
      runReviewer: async () => new Map([[1, { confidence: 2, reason: "stiff phrasing" }]]),
    }),
  );
  assert.equal(
    out,
    "Para one polished sentence.\n\nPara two re-polished sentence.\n\nPara three polished sentence.",
  );
  assert.equal(editCalls.length, 2);
  assert.equal(editCalls[1].text, "Para two draft sentence.");
  assert.match(editCalls[1].prompt, /CRITICAL/);
  assert.match(editCalls[1].prompt, /stiff phrasing/);
});

test("orchestrator: empty re-polish keeps the DRAFT paragraph", async () => {
  let calls = 0;
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      editStream: async () => (++calls === 1 ? POLISHED : "   "),
      runReviewer: async () => new Map([[1, { confidence: 1, reason: "garbled" }]]),
    }),
  );
  assert.equal(
    out,
    "Para one polished sentence.\n\nPara two draft sentence.\n\nPara three polished sentence.",
  );
});

test("orchestrator: re-polish throwing keeps the DRAFT paragraph", async () => {
  let calls = 0;
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      editStream: async () => {
        if (++calls === 1) return POLISHED;
        throw new Error("boom");
      },
      runReviewer: async () => new Map([[0, { confidence: 1, reason: "garbled" }]]),
    }),
  );
  assert.equal(
    out,
    "Para one draft sentence.\n\nPara two polished sentence.\n\nPara three polished sentence.",
  );
});

test("orchestrator: all reviewers failing accepts the polish unreviewed", async () => {
  const warnings: string[] = [];
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      runReviewer: async () => {
        throw new Error("reviewer died");
      },
      log: (level, msg) => {
        if (level === "warn") warnings.push(msg);
      },
    }),
  );
  assert.equal(out, POLISHED);
  assert.ok(warnings.some((w) => /fluency/i.test(w)));
});

test("orchestrator: unparsable reviewer output accepts the polish as-is", async () => {
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      // Unparsable reviewer output reaches the orchestrator as an empty map.
      runReviewer: async () => new Map(),
    }),
  );
  assert.equal(out, POLISHED);
});

// The fluency reviewer runs exactly once. Asking for more used to fan out N
// identical calls: same prompt, same seed, temperature 0. The min-score
// aggregation below still exists and still works — there is simply never more
// than one score to take the minimum of.
test("orchestrator: one reviewer runs, and its score decides", async () => {
  let reviewer = 0;
  const outputs = ["strict", "lenient"];
  let editCalls = 0;
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true }),
    mkDeps({
      editStream: async () => (++editCalls === 1 ? POLISHED : "Para one re-polished sentence."),
      runReviewer: async () =>
        outputs[reviewer++] === "strict"
          ? new Map([[0, { confidence: 2, reason: "calqued idiom" }]])
          : new Map([[0, { confidence: 5, reason: "fine" }]]),
    }),
  );
  assert.equal(
    out,
    "Para one re-polished sentence.\n\nPara two polished sentence.\n\nPara three polished sentence.",
  );
});


// ── The draft translation's own guard ──────────────────────────────────────
// Nothing used to check the draft at all: the polish pass had upgradeGuard,
// but the translation it polishes was taken on trust. A chunk that came back
// empty became an empty chapter, and a chunk that came back in the source
// language became an untranslated one — both on a task that reported "done",
// so the author downloaded a finished-looking book with English in it.

const SOURCE =
  "The ferry stopped running in October, and by November the river had frozen hard enough to walk on.\n\nHer father had drowned under it when she was nine, and she had never once crossed the ice.";
const DANISH =
  "Færgen holdt op med at sejle i oktober, og i november var floden frosset så hårdt til, at man kunne gå på den.\n\nHendes far var druknet under den, da hun var ni, og hun havde aldrig krydset isen.";

test("draftGuard: accepts a real translation", () => {
  assert.deepEqual(draftGuard(SOURCE, DANISH), { ok: true });
});

test("draftGuard: rejects an empty draft", () => {
  const r = draftGuard(SOURCE, "   \n  ");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /empty/i);
});

test("draftGuard: rejects a draft that is the source text echoed back", () => {
  const r = draftGuard(SOURCE, SOURCE);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /untranslated/i);
});

test("draftGuard: the echo check ignores whitespace and case differences", () => {
  const r = draftGuard(SOURCE, `  ${SOURCE.toUpperCase()}  `);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /untranslated/i);
});

test("draftGuard: rejects a draft far shorter than its source", () => {
  const r = draftGuard(SOURCE, "Færgen.");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /too short/i);
});

test("draftGuard: a short source is not judged on length", () => {
  // Target languages compress; the length rule must not fire on a one-liner
  // where a few characters either way is a large ratio.
  assert.deepEqual(draftGuard("Yes.", "Ja."), { ok: true });
});
