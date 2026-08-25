// Tests for false-positive suppression in getSpellCorrections: a dictionary
// doesn't enumerate every valid hyphenated compound ("iron-clad") or every
// plausible inflection ("storages"), so flagging them with the same
// confidence as an outright non-word ("amd", "teh") produces bad-looking
// "corrections" a reviewer can end up confidently endorsing.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getSpellCorrections } from "../src/spellcheck.ts";

test("a valid hyphenated compound is not flagged at all", () => {
  const text = "He gripped it with his iron-clad hands.";
  const originals = getSpellCorrections(text, "en_US", {}).map((c) => c.original);
  assert.ok(
    !originals.includes("iron-clad"),
    `"iron-clad" must not be flagged, got ${JSON.stringify(originals)}`,
  );
});

test("a hyphenated word whose parts are NOT both real is still flagged", () => {
  const text = "He wore a zqxbork-clad coat.";
  const originals = getSpellCorrections(text, "en_US", {}).map((c) => c.original);
  assert.ok(
    originals.includes("zqxbork-clad"),
    `expected the bogus compound flagged, got ${JSON.stringify(originals)}`,
  );
});

test("an unrecognized plural whose singular is real is flagged as low-confidence (spell-check-uncommon)", () => {
  const text = "They packed the last of their winter storages.";
  const hit = getSpellCorrections(text, "en_US", {}).find((c) => c.original === "storages");
  assert.ok(hit, "expected 'storages' to be flagged");
  assert.equal(hit?.reason, "spell-check-uncommon");
});

test("an outright non-word gets no special reason tag (ordinary spell-check severity)", () => {
  const text = "Teh cat sat.";
  const hit = getSpellCorrections(text, "en_US", {}).find((c) => c.original === "Teh");
  assert.ok(hit, "expected 'Teh' to be flagged");
  assert.equal(hit?.reason, undefined);
});
