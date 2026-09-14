// ── English dialect evidence ──
//
// Measured on twelve public-domain novels, the old token-count detector
// called every American one "unsure". Each test here pins one of the
// reasons, so a future "improvement" cannot quietly bring one back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreDialectEvidence, MARKER_CAP } from "../src/dialectEvidence.ts";
import { detectEnglishDialect } from "../src/detectSettings.ts";
import { detectDialect } from "../src/dialect.ts";

const value = (d: ReturnType<typeof detectEnglishDialect>) =>
  d.status === "detected" ? d.value : "unsure";

test("the -ward(s) family is not evidence either way", () => {
  const text =
    "She walked towards the door and afterwards looked backwards, then forwards, upwards and onwards. ".repeat(10);
  const ev = scoreDialectEvidence(text);
  assert.equal(ev.britishWeight, 0);
  assert.equal(ev.americanWeight, 0);
  const us = "He walked toward the door and afterward looked backward. ".repeat(10);
  // "afterward" alone IS American; "toward" and "backward" are not evidence.
  assert.deepEqual([...scoreDialectEvidence(us).americanMarkers.keys()], ["afterward"]);
});

test("a name is not evidence: Dorian Gray does not vote American", () => {
  const text = "Dorian Gray smiled. Lord Henry watched Gray across the room, and Gray said nothing. ".repeat(20);
  const ev = scoreDialectEvidence(text);
  assert.equal(ev.americanMarkers.get("gray"), undefined);
  // The same word opening a sentence is ordinary prose and still counts.
  const prose = "The sky was gray. Gray was the colour of everything. gray, gray, gray.";
  assert.equal(scoreDialectEvidence(prose).americanMarkers.get("gray"), 5);
});

test("one habit cannot decide a book: a marker counts at most MARKER_CAP times", () => {
  const oneWord = "colour ".repeat(200);
  const many = "colour harbour centre defence travelled favourite neighbour theatre";
  const one = scoreDialectEvidence(oneWord);
  const breadth = scoreDialectEvidence(many);
  assert.equal(one.britishMarkers.get("colour"), 200, "raw hits are still reported");
  assert.equal(one.britishWeight, MARKER_CAP * 2);
  assert.ok(breadth.britishWeight > one.britishWeight, "eight spellings outweigh one repeated");
});

test("-ise proves British; -ize only leans American and is never a spelling hit", () => {
  const british = scoreDialectEvidence("She realised he had organised it. ".repeat(3));
  assert.ok(british.britishWeight > 0);
  assert.equal(british.britishHits, 6, "-ise is a spelling on the British side");
  const oxford = scoreDialectEvidence("She realized he had organized it. ".repeat(3));
  assert.ok(oxford.americanWeight > 0, "a lean");
  assert.equal(oxford.americanHits, 0, "not a word on the wrong side of a British book");
});

test("words the other dialect never writes count on their own", () => {
  const br = scoreDialectEvidence("Mum had learnt to drive the lorry, whilst Dad queued for petrol by the kerb.");
  assert.ok(br.britishWeight >= 6, `british ${br.britishWeight}`);
  assert.equal(br.americanWeight, 0);
  const us = scoreDialectEvidence("Mom had gotten the flashlight from the truck on the sidewalk by the elevator.");
  assert.ok(us.americanWeight >= 6, `american ${us.americanWeight}`);
  assert.equal(us.britishWeight, 0);
});

test("Mr with or without a period is house style, and only counts when consistent", () => {
  const american = "Mr. Gatsby waved. Mrs. Wilson waved back. Dr. Eckleburg watched. Mr. Carraway left.";
  const british = "Mr Darcy bowed. Mrs Bennet fluttered. Dr Lydgate frowned. Mr Bingley smiled.";
  const both = american + " " + british;
  assert.ok(scoreDialectEvidence(american).americanMarkers.has("Mr. with a period"));
  assert.ok(scoreDialectEvidence(british).britishMarkers.has("Mr without a period"));
  const mixed = scoreDialectEvidence(both);
  assert.ok(!mixed.americanMarkers.has("Mr. with a period") && !mixed.britishMarkers.has("Mr without a period"));
});

test("an American manuscript in a modern voice is read as American", () => {
  const text = `
    Mr. Alvarez had gotten the call at the gas station on Route 9. Mom was
    in the hospital again. He grabbed the flashlight from the truck, walked
    the sidewalk to the elevator, and rode up to the seventh floor. The
    color of the hallway was the gray of old defense paint; the neighbors
    had traveled from the center of town. Afterward he sat in the parking
    lot and realized he had forgotten his sweater in the apartment.
  `;
  assert.equal(value(detectEnglishDialect(text)), "american");
});

test("a British manuscript in a modern voice is read as British", () => {
  const text = `
    Mr Okafor had learnt the news at the petrol station whilst queuing.
    Mum was in hospital again. He grabbed the torch from the lorry, walked
    the pavement to the lift and rode up to the seventh storey. The colour
    of the corridor was the grey of old defence paint; the neighbours had
    travelled from the centre of town. He realised he had forgotten his
    jumper in the flat, and it was a fortnight before he found it.
  `;
  assert.equal(value(detectEnglishDialect(text)), "british");
});

test("detectDialect and detectEnglishDialect reach the same verdict", () => {
  const text = "Mom had gotten the flashlight from the truck. The color of the harbor was gray. ".repeat(3);
  assert.equal(detectDialect(text).dialect, "american");
  assert.equal(value(detectEnglishDialect(text)), "american");
});
