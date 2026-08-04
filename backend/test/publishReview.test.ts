import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanPublishArtifacts,
  curlifyStrayQuotes,
  detectQuoteStyle,
} from "../src/publishReview.ts";

test("strips underscores wrapping only a question mark", () => {
  const { cleaned, fixes } = cleanPublishArtifacts('you okay_?_”');
  assert.equal(cleaned, 'you okay?”');
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].before, "_?_");
  assert.equal(fixes[0].after, "?");
});

test("strips underscores wrapping only a period", () => {
  const { cleaned } = cleanPublishArtifacts("him_._");
  assert.equal(cleaned, "him.");
});

test("strips asterisks wrapping only punctuation", () => {
  const { cleaned } = cleanPublishArtifacts("wait*!*");
  assert.equal(cleaned, "wait!");
});

test("leaves a real italic span untouched", () => {
  const text = "She wrote _the knife lay on the table_ in the margin.";
  const { cleaned, fixes } = cleanPublishArtifacts(text);
  assert.equal(cleaned, text);
  assert.equal(fixes.length, 0);
});

test("leaves a real bold span untouched", () => {
  const text = "This is **very** important.";
  const { cleaned, fixes } = cleanPublishArtifacts(text);
  assert.equal(cleaned, text);
  assert.equal(fixes.length, 0);
});

test("preserves a valid ellipsis", () => {
  const text = "Well… I suppose. And so it goes…";
  const { cleaned, fixes } = cleanPublishArtifacts(text);
  assert.equal(cleaned, text);
  assert.equal(fixes.length, 0);
});

test("repairs an introduced doubled period", () => {
  const { cleaned } = cleanPublishArtifacts("She left.. He stayed.");
  assert.equal(cleaned, "She left. He stayed.");
});

test("repairs a period jammed against a comma", () => {
  const { cleaned } = cleanPublishArtifacts("He waited., then left.");
  assert.equal(cleaned, "He waited, then left.");
});

test("does not touch a literal three-dot ellipsis", () => {
  const text = "Wait... what?";
  const { cleaned, fixes } = cleanPublishArtifacts(text);
  assert.equal(cleaned, text);
  assert.equal(fixes.length, 0);
});

test("clean text yields no fixes", () => {
  const text = "A perfectly ordinary sentence, nothing to fix here.";
  const { cleaned, fixes } = cleanPublishArtifacts(text);
  assert.equal(cleaned, text);
  assert.equal(fixes.length, 0);
});

// ── Typographic quote normalization (publish-ready, dominant-style) ──

test("curls a straight possessive apostrophe to U+2019", () => {
  const { cleaned, fixes } = curlifyStrayQuotes("his comrades' grip", {
    singles: true,
    doubles: false,
  });
  assert.equal(cleaned, "his comrades’ grip");
  assert.equal(fixes.length, 1);
});

test("curls a straight contraction apostrophe to U+2019", () => {
  const { cleaned } = curlifyStrayQuotes("Keenan's Inn", {
    singles: true,
    doubles: false,
  });
  assert.equal(cleaned, "Keenan’s Inn");
});

test("a straight single after whitespace becomes an opening curly quote", () => {
  const { cleaned } = curlifyStrayQuotes("he said 'hello'", {
    singles: true,
    doubles: false,
  });
  assert.equal(cleaned, "he said ‘hello’");
});

test("curls stray straight double quotes by context", () => {
  const { cleaned } = curlifyStrayQuotes('say "hi" now', {
    singles: false,
    doubles: true,
  });
  assert.equal(cleaned, "say “hi” now");
});

test("leaves quotes alone when the class is not selected", () => {
  const { cleaned, fixes } = curlifyStrayQuotes("comrades' grip", {
    singles: false,
    doubles: false,
  });
  assert.equal(cleaned, "comrades' grip");
  assert.equal(fixes.length, 0);
});

test("already-curly text yields no fixes", () => {
  const { cleaned, fixes } = curlifyStrayQuotes("Dinner’s ready", {
    singles: true,
    doubles: true,
  });
  assert.equal(cleaned, "Dinner’s ready");
  assert.equal(fixes.length, 0);
});

test("detectQuoteStyle counts curly vs straight for both classes", () => {
  const s = detectQuoteStyle("“a” b's c’s \"d\"");
  assert.equal(s.doubleCurly, 2);
  assert.equal(s.doubleStraight, 2);
  assert.equal(s.singleCurly, 1);
  assert.equal(s.singleStraight, 1);
});

// ── Leading-elision handling (apostrophe, not opening quote) ──

test("a leading elision takes an apostrophe, not an opening quote", () => {
  const { cleaned } = curlifyStrayQuotes("'tis the season", {
    singles: true,
    doubles: false,
  });
  assert.equal(cleaned, "’tis the season");
});

test("a decade elision ('90s) takes an apostrophe", () => {
  const { cleaned } = curlifyStrayQuotes("back in the '90s", {
    singles: true,
    doubles: false,
  });
  assert.equal(cleaned, "back in the ’90s");
});

test("'em after a space takes an apostrophe", () => {
  const { cleaned } = curlifyStrayQuotes("get 'em all", {
    singles: true,
    doubles: false,
  });
  assert.equal(cleaned, "get ’em all");
});

test("rock 'n' roll gets apostrophes on both sides", () => {
  const { cleaned } = curlifyStrayQuotes("rock 'n' roll", {
    singles: true,
    doubles: false,
  });
  assert.equal(cleaned, "rock ’n’ roll");
});

test("a genuine quoted word still opens with U+2018", () => {
  const { cleaned } = curlifyStrayQuotes("he said 'hello' softly", {
    singles: true,
    doubles: false,
  });
  assert.equal(cleaned, "he said ‘hello’ softly");
});
