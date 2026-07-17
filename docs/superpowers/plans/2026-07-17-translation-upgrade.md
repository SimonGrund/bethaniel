# Translation Upgrade Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-on monolingual "upgrade" (target-language line-edit) pass after translation, plus a fluency review loop that re-polishes flagged paragraphs — per the approved spec at `docs/superpowers/specs/2026-07-17-translation-upgrade-design.md`.

**Architecture:** A new `backend/src/translationUpgrade.ts` module holds pure guards and a dependency-injected orchestrator for stages 3–4 (upgrade + fluency review). `prompts.ts` gains two prompt builders. `queue.ts`'s existing `mode === "translate"` branch calls the orchestrator after the existing accuracy-review loop. Every failure falls back to the accuracy-validated draft.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Node `node:test` via tsx loader, no new dependencies.

## Global Constraints

- No new npm dependencies.
- All imports between `backend/src` files use the `./name.js` suffix (ESM); test files import `../src/name.ts`.
- Tests run from `backend/`: `npm test` → `node --import tsx --test "test/**/*.test.ts"`.
- `translationUpgrade.ts` must NOT import from `llm.ts`, `db.ts`, or `queue.ts` — all model calls and logging are injected (this is what makes it testable).
- Safety invariant from the spec: any failure in upgrade/fluency stages returns the accuracy-validated draft (or, per paragraph, the draft paragraph). Cancellation (`signal.aborted`) must re-throw, never swallow.
- The fluency reviewer reuses the existing JSONL score format so `parseReviewScores` (from `llm.ts`) works unchanged.

---

### Task 1: Structural guards in `translationUpgrade.ts`

**Files:**
- Create: `backend/src/translationUpgrade.ts`
- Create: `backend/test/translationUpgrade.test.ts`

**Interfaces:**
- Consumes: `Correction` type from `backend/src/types.js` (fields used: `original`, `corrected`).
- Produces: `splitIntoParas(text: string): string[]` and `upgradeGuard(draft: string, polished: string): { ok: true } | { ok: false; reason: string }` — Task 3's orchestrator and its tests use both.

- [ ] **Step 1: Write the failing tests**

Create `backend/test/translationUpgrade.test.ts`:

```ts
// Tests for the translation upgrade stage: structural guards and the
// upgrade → fluency-review → re-polish orchestrator with injected deps.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `backend/`): `npm test -- --test-name-pattern "upgradeGuard|splitIntoParas"`
Expected: FAIL — cannot find module `../src/translationUpgrade.ts`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/translationUpgrade.ts`:

```ts
// ── Translation upgrade stage ──
// Monolingual target-language polish of an accuracy-validated draft
// translation, plus a fluency review that re-polishes flagged paragraphs.
// No imports from llm.ts/db.ts/queue.ts — model calls, logging, and phase
// updates are injected by the caller so the stage is unit-testable.

import type { Correction } from "./types.js";

export function splitIntoParas(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Below this polished/draft length ratio we assume the model ate content. */
const MIN_LENGTH_RATIO = 0.6;

export function upgradeGuard(
  draft: string,
  polished: string,
): { ok: true } | { ok: false; reason: string } {
  if (!polished.trim()) return { ok: false, reason: "empty upgrade output" };
  const d = splitIntoParas(draft);
  const p = splitIntoParas(polished);
  if (d.length !== p.length)
    return {
      ok: false,
      reason: `paragraph count changed (${d.length} → ${p.length})`,
    };
  if (polished.length < draft.length * MIN_LENGTH_RATIO)
    return {
      ok: false,
      reason: `output too short (${polished.length}/${draft.length} chars)`,
    };
  return { ok: true };
}
```

(The `Correction` import is unused until Task 3 — omit it here and add it in Task 3 to keep the build clean.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern "upgradeGuard|splitIntoParas"`
Expected: PASS (5 tests). Also run the full suite once: `npm test` — everything else still green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/translationUpgrade.ts backend/test/translationUpgrade.test.ts
git commit -m "feat: structural guards for translation upgrade pass"
```

---

### Task 2: Prompt builders in `prompts.ts`

**Files:**
- Modify: `backend/src/prompts.ts` (append after `buildTranslationReviewerPrompt`, which ends around line 875)
- Test: `backend/test/translationUpgrade.test.ts` (append)

**Interfaces:**
- Consumes: module-private `buildStyleSheetBlock(styleGuide, "translate")` already in `prompts.ts` (defined ~line 95).
- Produces: `buildTranslationUpgradePrompt(targetLang: string, styleGuide?: string): string` and `buildFluencyReviewerPrompt(targetLang: string, styleGuide?: string): string` — Task 4 imports both in `queue.ts`.

Context for the reviewer prompt: reviewer agents receive their input via `buildReviewerUserMessage` in `llm.ts`, which formats it as `ORIGINAL TEXT:\n<chunk>\n\nPROPOSED CORRECTIONS:\n[i] "original" → "corrected"`. For the fluency review, "original" is the draft paragraph and "corrected" is the polished paragraph — the prompt below explains that framing to the model. The JSONL output contract is copied from `buildTranslationReviewerPrompt` verbatim so `parseReviewScores` parses it unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/translationUpgrade.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern "Prompt"`
Expected: FAIL — `buildTranslationUpgradePrompt` is not exported from prompts.

- [ ] **Step 3: Write the implementation**

Append to `backend/src/prompts.ts` (after `buildTranslationReviewerPrompt`):

```ts
// ═══════════════════════════════════════════════════════════════════
// TRANSLATION UPGRADE — monolingual target-language polish pass
// ═══════════════════════════════════════════════════════════════════

export function buildTranslationUpgradePrompt(
  targetLang: string,
  styleGuide?: string,
): string {
  let p = `You are a native ${targetLang} line editor. The text below was translated into ${targetLang}. Your job is to make it read as if it had been originally written in ${targetLang} — remove every trace of "translationese".`;
  if (styleGuide)
    p += `\n⚠ A BINDING GLOSSARY / TRANSLATION NOTES SECTION IS PROVIDED AT THE END — listed terms and names MUST remain exactly as rendered.`;
  p += `

WHAT TO FIX:
- Calqued idioms — replace literal renderings with natural ${targetLang} expressions
- Source-language sentence rhythm and word order — restructure into natural ${targetLang} syntax
- Register mismatches — informal dialogue must sound informal in ${targetLang}, formal narration formal
- Unnatural collocations and word choices a native writer would never use

WHAT YOU MUST NOT DO:
- Do NOT add, drop, or alter any meaning, fact, event, or detail
- Do NOT change any proper noun, name, or glossary-bound term
- Do NOT merge, split, add, or remove paragraphs — the output must have exactly the same paragraphs as the input
- Do NOT change Markdown formatting (headings, bold, italic, lists stay exactly as they are)

Output ONLY the edited ${targetLang} Markdown. No preamble, no commentary.`;
  p += buildStyleSheetBlock(styleGuide ?? "", "translate");
  return p;
}

// ═══════════════════════════════════════════════════════════════════
// FLUENCY REVIEWER — scores polished translation naturalness & drift
// ═══════════════════════════════════════════════════════════════════

export function buildFluencyReviewerPrompt(
  targetLang: string,
  styleGuide?: string,
): string {
  let p = `You are a native ${targetLang} literary editor assessing prose quality. Under ORIGINAL TEXT you will receive a draft ${targetLang} translation for context. Under PROPOSED CORRECTIONS you will receive pairs formatted as [index] "draft paragraph" → "polished paragraph". Both sides are ${targetLang}. For each pair, score the POLISHED paragraph.

Score each on a 1-5 confidence scale:
- 5: Reads as if originally written in ${targetLang} — natural rhythm, idiomatic, meaning identical to the draft
- 4: Good — minor awkwardness only (one word choice or a slightly stiff phrase)
- 3: Acceptable — understandable but noticeably stilted or translation-flavored
- 2: Problematic — unnatural phrasing throughout, OR the polish changed the draft's meaning
- 1: Broken — garbled text, or content dropped/invented relative to the draft

Specifically flag (score <= 2):
- Meaning added, dropped, or altered relative to the DRAFT paragraph
- Calqued idioms or word-for-word constructions no native writer would use
- Grammatically broken or garbled sentences`;

  if (styleGuide && styleGuide.trim()) {
    p += `
- A name or term rendered in VIOLATION of the binding glossary below

═══ BINDING GLOSSARY / TRANSLATION NOTES ═══
The polished text must conform to the notes below. A rendering that contradicts a listed term, name, or rule is a defect — score it <= 2 and name the violated term in the reason.

${styleGuide.trim()}`;
  }

  p += `

OUTPUT FORMAT — STRICT JSONL (one JSON object per line):
{"index": 0, "confidence": 5, "reason": "Natural, idiomatic — meaning preserved"}
{"index": 1, "confidence": 2, "reason": "Polish dropped the second sentence of the draft"}

Each line is one JSON object with exactly three keys: index, confidence, reason. The "index" field matches the pair number shown in the input. The "confidence" field is an integer 1-5. The "reason" field is a brief explanation (one short sentence).

Do NOT wrap lines in an array. Do NOT add commas between lines. Do NOT add commentary, headers, code fences, or blank lines between objects.
Output ONLY the JSONL stream. No preamble, no commentary, no markdown fences.`;

  return p;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern "Prompt"`
Expected: PASS (4 tests). Then `npm run build` (in `backend/`) — tsc compiles clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/prompts.ts backend/test/translationUpgrade.test.ts
git commit -m "feat: translation upgrade and fluency reviewer prompts"
```

---

### Task 3: Upgrade orchestrator in `translationUpgrade.ts`

**Files:**
- Modify: `backend/src/translationUpgrade.ts` (append)
- Test: `backend/test/translationUpgrade.test.ts` (append)

**Interfaces:**
- Consumes: `splitIntoParas`, `upgradeGuard` (Task 1); `Correction` from `./types.js`.
- Produces (Task 4 wires these):

```ts
export interface FluencyScore { confidence: number; reason: string }
export interface UpgradeDeps {
  editStream: (text: string, systemPrompt: string) => Promise<string>;
  runReviewer: (draftChunk: string, pairs: Correction[]) => Promise<string>;
  parseScores: (raw: string) => Map<number, FluencyScore>;
  log: (level: "info" | "warn", message: string) => void;
  setPhase: (phase: string) => void;
}
export interface UpgradeOptions {
  draft: string;
  upgradePrompt: string;
  reviewMode: boolean;
  reviewerCount: number;
  reviewerThreshold: number;
  chunkLabel: string;
  signal: AbortSignal;
}
export function runTranslationUpgrade(opts: UpgradeOptions, deps: UpgradeDeps): Promise<string>;
```

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/translationUpgrade.test.ts`:

```ts
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
    reviewerCount: 1,
    reviewerThreshold: 3,
    chunkLabel: "1/1",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function mkDeps(overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    editStream: async () => POLISHED,
    runReviewer: async () => "",
    parseScores: () => new Map(),
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
      runReviewer: async () => "scores",
      parseScores: () =>
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
      runReviewer: async () => "scores",
      parseScores: () => new Map([[1, { confidence: 2, reason: "stiff phrasing" }]]),
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
      runReviewer: async () => "scores",
      parseScores: () => new Map([[1, { confidence: 1, reason: "garbled" }]]),
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
      runReviewer: async () => "scores",
      parseScores: () => new Map([[0, { confidence: 1, reason: "garbled" }]]),
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
    mkOpts({ reviewMode: true, reviewerCount: 2 }),
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
      runReviewer: async () => "<think>hmm</think> not json at all",
      parseScores: () => new Map(), // parseReviewScores finds nothing
    }),
  );
  assert.equal(out, POLISHED);
});

test("orchestrator: multiple reviewers — the minimum score wins", async () => {
  let reviewer = 0;
  const outputs = ["lenient", "strict"];
  let editCalls = 0;
  const out = await runTranslationUpgrade(
    mkOpts({ reviewMode: true, reviewerCount: 2 }),
    mkDeps({
      editStream: async () => (++editCalls === 1 ? POLISHED : "Para one re-polished sentence."),
      runReviewer: async () => outputs[reviewer++],
      parseScores: (raw) =>
        raw === "strict"
          ? new Map([[0, { confidence: 2, reason: "calqued idiom" }]])
          : new Map([[0, { confidence: 5, reason: "fine" }]]),
    }),
  );
  assert.equal(
    out,
    "Para one re-polished sentence.\n\nPara two polished sentence.\n\nPara three polished sentence.",
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern "orchestrator"`
Expected: FAIL — `runTranslationUpgrade` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `backend/src/translationUpgrade.ts` (and add the `Correction` type import at the top):

```ts
import type { Correction } from "./types.js";
```

```ts
export interface FluencyScore {
  confidence: number;
  reason: string;
}

export interface UpgradeDeps {
  /** Accumulate a full completion for `text` under `systemPrompt`. */
  editStream: (text: string, systemPrompt: string) => Promise<string>;
  /** Run one fluency-reviewer agent; resolves to its raw JSONL output. */
  runReviewer: (draftChunk: string, pairs: Correction[]) => Promise<string>;
  parseScores: (raw: string) => Map<number, FluencyScore>;
  log: (level: "info" | "warn", message: string) => void;
  setPhase: (phase: string) => void;
}

export interface UpgradeOptions {
  draft: string;
  upgradePrompt: string;
  reviewMode: boolean;
  reviewerCount: number;
  reviewerThreshold: number;
  chunkLabel: string;
  signal: AbortSignal;
}

/**
 * Stages 3–4 of the translate pipeline: polish the accuracy-validated draft
 * in the target language, then (reviewMode) score each draft↔polished
 * paragraph pair and re-polish flagged paragraphs once from the draft.
 * The draft is the fallback at every level: guard rejection, upgrade
 * failure, or a failed re-polish never produce anything worse than the
 * input. Abort always re-throws so the chunk-level handler sees it.
 */
export async function runTranslationUpgrade(
  opts: UpgradeOptions,
  deps: UpgradeDeps,
): Promise<string> {
  const { draft, chunkLabel } = opts;
  try {
    deps.setPhase(`upgrading chunk ${chunkLabel}`);
    const polished = (await deps.editStream(draft, opts.upgradePrompt)).trim();

    const guard = upgradeGuard(draft, polished);
    if (!guard.ok) {
      deps.log(
        "warn",
        `Upgrade of chunk ${chunkLabel} rejected: ${guard.reason}. Keeping draft.`,
      );
      return draft;
    }

    if (!opts.reviewMode) return polished;

    const draftParas = splitIntoParas(draft);
    const polishedParas = splitIntoParas(polished);
    const n = draftParas.length; // == polishedParas.length (guard passed)

    deps.setPhase(`reviewing fluency for chunk ${chunkLabel}`);
    const pairs: Correction[] = draftParas.map((d, i) => ({
      original: d,
      corrected: polishedParas[i],
    }));

    const results = await Promise.allSettled(
      Array.from({ length: opts.reviewerCount }, () =>
        deps.runReviewer(draft, pairs),
      ),
    );
    const outputs: string[] = [];
    for (const r of results)
      if (r.status === "fulfilled" && r.value) outputs.push(r.value);

    if (outputs.length === 0) {
      deps.log(
        "warn",
        `No fluency reviewer survived for chunk ${chunkLabel}; accepting polish unreviewed.`,
      );
      return polished;
    }
    if (outputs.length < opts.reviewerCount)
      deps.log(
        "warn",
        `Only ${outputs.length}/${opts.reviewerCount} fluency reviewers contributed for chunk ${chunkLabel}; scoring on survivors.`,
      );

    const allScores = outputs.map((o) => deps.parseScores(o));
    const flagged: { idx: number; conf: number; reason: string }[] = [];
    for (let i = 0; i < n; i++) {
      let minConf = 5;
      let minReason = "";
      for (const scores of allScores) {
        const s = scores.get(i);
        if (s && s.confidence < minConf) {
          minConf = s.confidence;
          minReason = s.reason;
        }
      }
      if (minConf < opts.reviewerThreshold)
        flagged.push({ idx: i, conf: minConf, reason: minReason });
    }

    if (flagged.length === 0) {
      deps.log(
        "info",
        `Fluency reviewer passed all ${n} paragraphs in chunk ${chunkLabel}.`,
      );
      return polished;
    }

    deps.log(
      "info",
      `Fluency reviewer flagged ${flagged.length}/${n} paragraphs in chunk ${chunkLabel}. Re-polishing…`,
    );
    const revised = [...polishedParas];
    for (const f of flagged) {
      try {
        const rePrompt =
          opts.upgradePrompt +
          `\n\nCRITICAL: Your previous edit of this paragraph was flagged: "${f.reason}". Rewrite it so it reads naturally while preserving the meaning exactly.`;
        const rePolished = (
          await deps.editStream(draftParas[f.idx], rePrompt)
        ).trim();
        if (rePolished) {
          revised[f.idx] = rePolished;
          deps.log(
            "info",
            `Re-polished paragraph ${f.idx + 1}/${n} (was confidence ${f.conf}).`,
          );
        } else {
          revised[f.idx] = draftParas[f.idx];
          deps.log(
            "warn",
            `Re-polish of paragraph ${f.idx + 1} came back empty; keeping draft paragraph.`,
          );
        }
      } catch (err) {
        if (opts.signal.aborted) throw err;
        revised[f.idx] = draftParas[f.idx];
        deps.log(
          "warn",
          `Re-polish of paragraph ${f.idx + 1} failed: ${err instanceof Error ? err.message : String(err)}. Keeping draft paragraph.`,
        );
      }
    }
    return revised.join("\n\n");
  } catch (err) {
    if (opts.signal.aborted) throw err;
    deps.log(
      "warn",
      `Translation upgrade failed for chunk ${chunkLabel}: ${err instanceof Error ? err.message : String(err)}. Keeping draft.`,
    );
    return draft;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- --test-name-pattern "orchestrator"`
Expected: PASS (11 tests). Then the full suite: `npm test` — all green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/translationUpgrade.ts backend/test/translationUpgrade.test.ts
git commit -m "feat: translation upgrade orchestrator with fluency review loop"
```

---

### Task 4: Wire the upgrade stage into `queue.ts` and document it

**Files:**
- Modify: `backend/src/queue.ts` — imports (top of file) and the `mode === "translate"` branch (the block ending with `stripOverlapFromResponse(translatedText, …)` around line 1756)
- Modify: `CLAUDE.md` — backend file table

**Interfaces:**
- Consumes: `runTranslationUpgrade` (Task 3), `buildTranslationUpgradePrompt` / `buildFluencyReviewerPrompt` (Task 2), and existing `queue.ts` locals: `model`, `taskId`, `chunkLabel`, `ac` (AbortController), `job` (JobData: `targetLang`, `styleGuide`, `reviewMode`, `reviewerCount`, `reviewerThreshold`), plus `editChunkStream`, `parseReviewScores`, `restoreTypography` (already imported from `./llm.js`), module-private `runReviewerAgentWithRetry`, `appendLog`, `updateTask`.
- Produces: the final translate-mode behavior; no new exports.

- [ ] **Step 1: Add imports**

In `backend/src/queue.ts`, find the existing import from `./prompts.js` (it already imports `buildTranslationReviewerPrompt` among others) and add the two new names:

```ts
import {
  // …existing names…
  buildTranslationUpgradePrompt,
  buildFluencyReviewerPrompt,
} from "./prompts.js";
```

Add the new module import next to the other local imports:

```ts
import { runTranslationUpgrade } from "./translationUpgrade.js";
```

- [ ] **Step 2: Insert the upgrade stage**

In the `mode === "translate"` branch, locate the end of the accuracy-review block — the closing brace of `if (job.reviewMode) { … }` immediately before:

```ts
            const core = stripOverlapFromResponse(
              translatedText,
              chunk.overlapHeadParagraphs,
            );
            pieces.push(core);
```

Insert between the closing brace and `const core = …`:

```ts
            // UPGRADE PASS — monolingual target-language polish + fluency
            // review. Falls back to the accuracy-validated draft on any
            // failure, so this can never regress the plain translation.
            const targetLang = job.targetLang ?? "the target language";
            const upgraded = await runTranslationUpgrade(
              {
                draft: translatedText,
                upgradePrompt: buildTranslationUpgradePrompt(
                  targetLang,
                  job.styleGuide,
                ),
                reviewMode: !!job.reviewMode,
                reviewerCount: job.reviewerCount ?? 1,
                reviewerThreshold: job.reviewerThreshold ?? 3,
                chunkLabel,
                signal: ac.signal,
              },
              {
                editStream: async (text, systemPrompt) => {
                  let out = "";
                  for await (const tok of editChunkStream(
                    model,
                    text,
                    systemPrompt,
                    ac.signal,
                  ))
                    out += tok;
                  return out;
                },
                runReviewer: (draftChunk, pairs) =>
                  runReviewerAgentWithRetry({
                    model,
                    chunkText: draftChunk,
                    cs: pairs,
                    reviewerPrompt: buildFluencyReviewerPrompt(
                      targetLang,
                      job.styleGuide,
                    ),
                    signal: ac.signal,
                    taskId,
                    chunkLabel,
                    agentLabel: "Fluency-reviewer agent",
                  }),
                parseScores: parseReviewScores,
                log: (level, message) =>
                  appendLog({ level, source: "engine", taskId, message, model }),
                setPhase: (phase) => updateTask(taskId, { phase }),
              },
            );
            translatedText = restoreTypography(translatedText, upgraded);
```

Note: `buildFluencyReviewerPrompt` is called once per reviewer invocation here; if you prefer, hoist it into a `const fluencyPrompt = …` next to `targetLang` — either is fine, the prompt builder is pure and cheap.

- [ ] **Step 3: Typecheck and run the full suite**

Run (from `backend/`): `npm run build`
Expected: tsc exits 0.

Run: `npm test`
Expected: all tests pass (the new file's 20 tests plus the existing suite).

- [ ] **Step 4: Update CLAUDE.md**

In the backend file table in `CLAUDE.md`, add a row after `chunking.ts`:

```markdown
| `translationUpgrade.ts` | Post-translation target-language polish pass + fluency review loop (stages 3–4 of translate mode) |
```

- [ ] **Step 5: Manual smoke test (optional but recommended)**

Run `npm run dev` from the repo root, upload a short manuscript, run Translate with review mode enabled, and watch the log panel for the new phases: `upgrading chunk 1/1`, `reviewing fluency for chunk 1/1`, and either "passed all N paragraphs" or "flagged …/N paragraphs … Re-polishing…". The backend has no file watching — restart it if it was already running.

- [ ] **Step 6: Commit**

```bash
git add backend/src/queue.ts CLAUDE.md
git commit -m "feat: run upgrade + fluency review after translation"
```
