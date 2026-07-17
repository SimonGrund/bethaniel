// Tests for the sequential story-read orchestrator. The LLM is scripted: each
// test queues JSON responses and asserts on how the orchestrator applies them
// — registry identity, event sequencing, part synthesis, checkpoint/resume,
// and the final structuredData shape consumed by the frontend.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runStoryAnalysis,
  type StoryAnalysisState,
} from "../src/storyAnalysis.ts";

type Call = { system: string; user: string };

/** Scripted LLM: returns queued responses in order, records every call. */
function scriptedLlm(responses: (string | Error)[]) {
  const calls: Call[] = [];
  const llm = async (system: string, user: string): Promise<string> => {
    calls.push({ system, user });
    const next = responses.shift();
    if (next === undefined) throw new Error("scripted LLM ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  };
  return { llm, calls };
}

const j = (o: unknown) => JSON.stringify(o);

// Convenience chapter-pass responses
const ch1Response = j({
  mentions: [
    {
      new: {
        kind: "character",
        name: "Katherine",
        aliases: ["the queen"],
        oneLiner: "The reigning queen.",
        physicalDescription: "Tall, silver-haired.",
        personalityTraits: ["stern"],
      },
    },
    {
      new: {
        kind: "location",
        name: "Thornfield Hall",
        aliases: ["the manor"],
        oneLiner: "The queen's ancestral home.",
        description: "A sprawling Victorian manor.",
      },
    },
  ],
  events: [
    {
      description: "Katherine returns to Thornfield Hall.",
      characters: ["C1"],
      timeReference: "spring",
    },
  ],
  chapterSummary: "Katherine returns home after years away.",
});

const ch2Response = j({
  mentions: [
    { id: "C1", aliases: ["Kate"], traits: ["secretly kind"] },
    { id: "L1", aliases: ["home"] },
  ],
  events: [
    {
      description: "Kate discovers the sealed letter.",
      characters: ["Katherine"],
      timeReference: "the next morning",
    },
  ],
  chapterSummary: "Kate finds a letter that changes everything.",
});

const partResponse = j({
  partSummary: "Katherine returns and uncovers a family secret.",
  eventTiers: [{ seq: 1, tier: 1 }],
});

const storyResponse = j({
  synopsis: "A queen returns home and unearths her family's past.",
  characterRoles: [{ id: "C1", role: "protagonist" }],
  locationSignificance: [
    { id: "L1", significance: "Anchors the family history." },
  ],
});

const twoChapterUnits = [
  { name: "Chapter 1", original: "Katherine arrived at Thornfield Hall..." },
  { name: "Chapter 2", original: "The next morning Kate found a letter..." },
];

async function runTwoChapterStory(overrides?: {
  responses?: (string | Error)[];
}) {
  const { llm, calls } = scriptedLlm(
    overrides?.responses ?? [ch1Response, ch2Response, partResponse, storyResponse],
  );
  const result = await runStoryAnalysis(twoChapterUnits, { llm });
  return { result, calls };
}

// ── registry & alias resolution ──

test("mention with {id} merges into the existing entity", async () => {
  const { result } = await runTwoChapterStory();
  const chars = result.structuredData.characters;
  assert.equal(chars.length, 1);
  assert.equal(chars[0].name, "Katherine");
  assert.ok(chars[0].aliases.includes("the queen"));
  assert.ok(chars[0].aliases.includes("Kate"));
  assert.deepEqual(chars[0].chapters, ["Chapter 1", "Chapter 2"]);
  assert.ok(chars[0].personalityTraits.includes("stern"));
  assert.ok(chars[0].personalityTraits.includes("secretly kind"));
});

test("locations get the same identity treatment", async () => {
  const { result } = await runTwoChapterStory();
  const locs = result.structuredData.locations;
  assert.equal(locs.length, 1);
  assert.equal(locs[0].name, "Thornfield Hall");
  assert.ok(locs[0].aliases.includes("the manor"));
  assert.ok(locs[0].aliases.includes("home"));
});

test("a 'new' entity whose name matches an existing alias merges instead of duplicating", async () => {
  const ch2Dup = j({
    mentions: [
      {
        new: {
          kind: "character",
          name: "Kate",
          aliases: [],
          oneLiner: "A woman with a letter.",
        },
      },
    ],
    events: [],
    chapterSummary: "Kate reads.",
  });
  const ch1WithKate = j({
    mentions: [
      {
        new: {
          kind: "character",
          name: "Katherine",
          aliases: ["Kate"],
          oneLiner: "The queen.",
        },
      },
    ],
    events: [],
    chapterSummary: "Katherine arrives.",
  });
  const { result } = await runTwoChapterStory({
    responses: [ch1WithKate, ch2Dup, partResponse, storyResponse],
  });
  assert.equal(result.structuredData.characters.length, 1);
  assert.equal(result.structuredData.characters[0].name, "Katherine");
});

test("registry block in later chapter prompts contains earlier entities", async () => {
  const { calls } = await runTwoChapterStory();
  // Call 1 = chapter 2 pass (0-indexed): must see Katherine's registry entry
  assert.ok(calls[1].user.includes("C1"));
  assert.ok(calls[1].user.includes("Katherine"));
  assert.ok(calls[1].user.includes("the queen"));
});

// ── events & timeline ──

test("events are sequence-numbered in reading order with chapter forced", async () => {
  const { result } = await runTwoChapterStory();
  const events = result.structuredData.events;
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.seq),
    [1, 2],
  );
  assert.equal(events[0].chapter, "Chapter 1");
  assert.equal(events[1].chapter, "Chapter 2");
});

test("event character IDs resolve to canonical names", async () => {
  const { result } = await runTwoChapterStory();
  assert.deepEqual(result.structuredData.events[0].characters, ["Katherine"]);
});

test("part pass promotes event tiers; unpromoted events default to tier 3", async () => {
  const { result } = await runTwoChapterStory();
  const events = result.structuredData.events;
  assert.equal(events[0].tier, 1);
  assert.equal(events[1].tier, 3);
});

// ── outline & story pass ──

test("story pass fills synopsis, roles, and significance", async () => {
  const { result } = await runTwoChapterStory();
  const sd = result.structuredData;
  assert.equal(
    sd.outline.synopsis,
    "A queen returns home and unearths her family's past.",
  );
  assert.equal(sd.characters[0].role, "protagonist");
  assert.equal(sd.locations[0].significance, "Anchors the family history.");
});

test("implicit single part: outline.parts stays empty, chapter summaries kept", async () => {
  const { result } = await runTwoChapterStory();
  const outline = result.structuredData.outline;
  assert.deepEqual(outline.parts, []);
  assert.equal(outline.chapterSummaries.length, 2);
  assert.equal(
    outline.chapterSummaries[0].summary,
    "Katherine returns home after years away.",
  );
});

test("explicit parts produce one part pass each and named outline parts", async () => {
  const units = [
    { name: "Part One", original: "The beginning." },
    { name: "Chapter 1", original: "..." },
    { name: "Part Two", original: "The middle." },
    { name: "Chapter 2", original: "..." },
  ];
  const empty = (summary: string) =>
    j({ mentions: [], events: [], chapterSummary: summary });
  const partA = j({ partSummary: "Part one summary.", eventTiers: [] });
  const partB = j({ partSummary: "Part two summary.", eventTiers: [] });
  const { llm, calls } = scriptedLlm([
    empty("s1"),
    empty("s2"),
    partA,
    empty("s3"),
    empty("s4"),
    partB,
    storyResponse,
  ]);
  const result = await runStoryAnalysis(units, { llm });
  assert.equal(calls.length, 7);
  const outline = result.structuredData.outline;
  assert.equal(outline.parts.length, 2);
  assert.equal(outline.parts[0].title, "Part One");
  assert.equal(outline.parts[0].summary, "Part one summary.");
  assert.deepEqual(outline.parts[1].chapters, ["Part Two", "Chapter 2"]);
});

// ── robustness ──

test("invalid JSON is retried once with the error fed back", async () => {
  const { llm, calls } = scriptedLlm([
    "I cannot answer in JSON, sorry!",
    ch1Response,
    ch2Response,
    partResponse,
    storyResponse,
  ]);
  const result = await runStoryAnalysis(twoChapterUnits, { llm });
  assert.equal(calls.length, 5);
  // The retry call should mention the failure
  assert.ok(/invalid|parse|json/i.test(calls[1].user));
  assert.equal(result.structuredData.characters.length, 1);
});

test("a step that fails twice aborts the run", async () => {
  const { llm } = scriptedLlm(["garbage", "more garbage"]);
  await assert.rejects(
    () => runStoryAnalysis(twoChapterUnits, { llm }),
    /json/i,
  );
});

// ── checkpoint & resume ──

test("checkpoints fire per chapter and resume skips completed chapters", async () => {
  const checkpoints: StoryAnalysisState[] = [];
  const boom = new Error("connection lost");
  const first = scriptedLlm([ch1Response, boom]);
  await assert.rejects(() =>
    runStoryAnalysis(twoChapterUnits, {
      llm: first.llm,
      onCheckpoint: (s) => checkpoints.push(structuredClone(s)),
    }),
  );
  assert.ok(checkpoints.length >= 1);
  const saved = checkpoints[checkpoints.length - 1];
  assert.equal(saved.nextChapterIndex, 1);

  // Resume: only chapter 2 + part + story calls remain.
  const second = scriptedLlm([ch2Response, partResponse, storyResponse]);
  const result = await runStoryAnalysis(twoChapterUnits, {
    llm: second.llm,
    resumeFrom: saved,
  });
  assert.equal(second.calls.length, 3);
  assert.equal(result.structuredData.characters.length, 1);
  assert.ok(result.structuredData.characters[0].aliases.includes("Kate"));
});

// ── final shape ──

test("structuredData is backward-compatible for the existing frontend views", async () => {
  const { result } = await runTwoChapterStory();
  const sd = result.structuredData;
  for (const c of sd.characters) {
    assert.equal(typeof c.name, "string");
    assert.ok(Array.isArray(c.aliases));
    assert.ok(Array.isArray(c.chapters));
    assert.equal(typeof c.physicalDescription, "string");
    assert.ok(Array.isArray(c.personalityTraits));
    assert.equal(typeof c.role, "string");
  }
  for (const l of sd.locations) {
    assert.equal(typeof l.name, "string");
    assert.ok(Array.isArray(l.chapters));
    assert.equal(typeof l.description, "string");
    assert.equal(typeof l.significance, "string");
  }
  for (const e of sd.events) {
    assert.equal(typeof e.seq, "number");
    assert.equal(typeof e.chapter, "string");
    assert.equal(typeof e.description, "string");
    assert.ok([1, 2, 3].includes(e.tier));
  }
  assert.equal(typeof sd.outline.synopsis, "string");
});
