// The developmental review is a manuscript-level critique (structure, pacing,
// arcs, plot, POV) synthesized from the story read — a Markdown report, never
// the JSONL corrections contract.

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEVELOPMENTAL_REVIEW_PROMPT } from "../src/prompts.ts";
import { runDevelopmentalEdit } from "../src/developmentalEdit.ts";

const j = (o: unknown) => JSON.stringify(o);

test("developmental prompt targets manuscript-level concerns", () => {
  const p = DEVELOPMENTAL_REVIEW_PROMPT;
  assert.ok(p.includes("## Structure & shape"));
  assert.ok(p.includes("## Pacing"));
  assert.ok(p.includes("## Character arcs"));
  assert.ok(p.includes("## Plot & continuity"));
  assert.ok(p.includes("## Priority revisions"));
});

test("developmental prompt is a Markdown report, not JSONL corrections", () => {
  const p = DEVELOPMENTAL_REVIEW_PROMPT;
  assert.ok(p.includes("Output Markdown only"));
  assert.ok(!p.includes("JSONL"));
  assert.ok(!p.includes('"original"'));
});

test("manuscriptLang reaches the story read AND the final report pass", async () => {
  const calls: string[] = [];
  // Four story-read passes (2 chapters + part + story synthesis), then the
  // developmental synthesis itself.
  const responses = [
    j({ mentions: [], events: [], chapterSummary: "Noget sker." }),
    j({ mentions: [], events: [], chapterSummary: "Mere sker." }),
    j({ partSummary: "Første del.", eventTiers: [] }),
    j({ synopsis: "En historie.", characterRoles: [], locationSignificance: [] }),
    "## Samlet vurdering\n\nEt lovende udkast.",
  ];
  const llm = async (system: string): Promise<string> => {
    calls.push(system);
    return responses.shift()!;
  };

  const { report } = await runDevelopmentalEdit(
    [
      { name: "Kapitel 1", original: "Katrine ankom til huset." },
      { name: "Kapitel 2", original: "Næste morgen fandt hun et brev." },
    ],
    { llm, manuscriptLang: "da" },
  );

  assert.equal(calls.length, 5);
  for (const system of calls) {
    assert.match(system, /OUTPUT LANGUAGE: Danish/);
  }
  // The last call is the report synthesis — it must be told to write Danish
  // prose, and must not carry the JSON carve-out (it emits Markdown).
  assert.doesNotMatch(calls[4], /JSON keys/);
  assert.ok(report.startsWith("## Samlet vurdering"));
});

test("no manuscriptLang leaves the developmental prompts untouched", async () => {
  const calls: string[] = [];
  const responses = [
    j({ mentions: [], events: [], chapterSummary: "Something happens." }),
    j({ partSummary: "Part one.", eventTiers: [] }),
    j({ synopsis: "A story.", characterRoles: [], locationSignificance: [] }),
    "## Overall assessment\n\nA promising draft.",
  ];
  const llm = async (system: string): Promise<string> => {
    calls.push(system);
    return responses.shift()!;
  };

  await runDevelopmentalEdit([{ name: "Chapter 1", original: "She arrived." }], {
    llm,
  });
  for (const system of calls) assert.doesNotMatch(system, /OUTPUT LANGUAGE/);
});
