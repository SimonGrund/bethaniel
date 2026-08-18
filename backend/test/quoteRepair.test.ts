// The publication scan finds unbalanced quotes; copy edit was expected to fix
// them and mostly did not. Measured on the three real defects from a live book:
//
//   “We can try.        (missing close)      → fixed by the model
//   “Good.“             (close typed as open) → missed
//   To save you,"       (straight among curly) → missed
//
// The two it misses are unambiguous, which makes them deterministic work rather
// than a prompt to argue with — the copy-edit prompt deliberately discourages
// the model from touching quotation marks at all, because it used to insert
// duplicates next to existing ones.

import { test } from "node:test";
import assert from "node:assert/strict";

import { getQuoteCorrections } from "../src/quoteRepair.ts";

/**
 * Enough curly quotes that the prevailing style is unambiguous.
 *
 * Sized like a real manuscript rather than a snippet: the rule declines to
 * judge when marks are genuinely mixed, so a fixture with three curly pairs and
 * two strays tests the refusal, not the repair.
 */
const CURLY_CONTEXT = Array.from(
  { length: 12 },
  (_, i) => `“Line ${i} of quiet dialogue by the harbour,” she said.`,
).join("\n\n");

test("a closing mark typed as an opening one is corrected", () => {
  const text = `${CURLY_CONTEXT}\n\nAnima smiled gently. “Good.“ She grabbed Bria's hand.`;
  const cs = getQuoteCorrections(text);
  assert.equal(cs.length, 1, JSON.stringify(cs));
  assert.match(cs[0].corrected, /“Good\.”/);
});

test("a straight quote in a curly manuscript is corrected to the right curl", () => {
  const text = `${CURLY_CONTEXT}\n\n“I am here to… To save you," Bria finished quietly.`;
  const cs = getQuoteCorrections(text);
  assert.equal(cs.length, 1, JSON.stringify(cs));
  assert.match(cs[0].corrected, /save you,”/);
  assert.doesNotMatch(cs[0].corrected, /"/, "a straight mark must not survive");
});

test("both marks of a line are fixed in ONE correction, not two overlapping ones", () => {
  // Two marks, one paragraph. Emitted separately their spans overlapped, and
  // applying the first left the second unable to match the text it was cut from.
  const text = `${CURLY_CONTEXT}\n\n"We can try," Aaron said with a shrug.`;
  const cs = getQuoteCorrections(text);
  assert.equal(cs.length, 1, JSON.stringify(cs));
  assert.match(cs[0].corrected, /“We can try,”/);
});

test("corrections never overlap, so they can all be applied", () => {
  const text = `${CURLY_CONTEXT}\n\n"First," she said.\n\n"Second,“ he replied.`;
  const cs = getQuoteCorrections(text);
  let applied = text;
  for (const c of cs) {
    assert.ok(applied.includes(c.original), `span lost: ${c.original}`);
    applied = applied.replace(c.original, c.corrected);
  }
  assert.doesNotMatch(applied, /"/, "a straight mark survived");
  assert.match(applied, /“Second,”/);
});

test("a manuscript written in straight quotes is left alone", () => {
  // Style is the author's choice. Only inconsistency is an error.
  const straight = `
"The harbour is quiet tonight," she said.

"Too quiet," he answered.

"We should go," she added.
`;
  assert.deepEqual(getQuoteCorrections(straight), []);
});

test("interrupted dialogue keeps its closing mark", () => {
  // “But sir—” is standard for speech cut off mid-sentence. An earlier rule
  // decided open-vs-close by the PRECEDING character, saw the em-dash, and
  // flipped every one of these to an opening mark — 61 of them across one book,
  // all of them correct before it started.
  const text = `${CURLY_CONTEXT}
“But sir—”

“Just let me go, and—”

“You mean you found—” he said, setting down his tea.`;
  assert.deepEqual(getQuoteCorrections(text), []);
});

test("an ellipsis before a closing mark is also left alone", () => {
  const text = `${CURLY_CONTEXT}\n\n“I am here to… To save you…”`;
  assert.deepEqual(getQuoteCorrections(text), []);
});

test("apostrophes are never touched", () => {
  const text = `${CURLY_CONTEXT}\n\nBria's hand closed on Karim's sleeve, and the boy's eyes went wide.`;
  assert.deepEqual(getQuoteCorrections(text), []);
});

test("correctly quoted dialogue produces nothing", () => {
  assert.deepEqual(getQuoteCorrections(CURLY_CONTEXT), []);
});

test("a missing closing quote is NOT invented", () => {
  // Where the closing mark belongs is a judgement — end of sentence, end of
  // paragraph, before or after the tag — and the model already handles it.
  // Guessing here would splice a quote into the middle of someone's prose.
  const text = `${CURLY_CONTEXT}\n\nAaron shrugged. “We can try.\n\nBack at the Kettle, he sat down.`;
  assert.deepEqual(getQuoteCorrections(text), []);
});

test("every correction is a real change", () => {
  const text = `${CURLY_CONTEXT}\n\nShe said “Good.“ and left.`;
  for (const c of getQuoteCorrections(text)) {
    assert.notEqual(c.original, c.corrected);
    assert.ok(text.includes(c.original), `original not found: ${c.original}`);
  }
});

test("a mark the surrounding text contradicts is left alone", () => {
  // Two opening marks in a row is malformed. Alternation would make the second
  // a closing mark pressed against a word — “…change of plans. ”You are going…
  // — which is worse than the fault, and not ours to guess at.
  const text = `${CURLY_CONTEXT}\n\n“Well, there's been a change of plans. “You are going to the college.”`;
  const cs = getQuoteCorrections(text);
  for (const c of cs) {
    assert.doesNotMatch(
      c.corrected,
      /”[\p{L}]/u,
      `placed a closing mark against a word: ${c.corrected}`,
    );
  }
});

test("an unbalanced paragraph is reported, not repaired", () => {
  // Duplicated text leaves a stray mark: “…We just escape?” Bria asked.” Bria
  // asked. Three marks, and alternation cannot tell which is the faulty one —
  // on a real book it flipped the wrong one every time. The publication scan
  // reports these with the passage attached; guessing here would make the
  // sentence worse while looking like a fix.
  const text = `${CURLY_CONTEXT}\n\n“And us? We just escape?” Bria asked.” Bria asked.`;
  assert.deepEqual(getQuoteCorrections(text), []);
});

test("a paragraph needing several marks turned round is left alone", () => {
  // “…change of plans. “You are going…criminals.” Couldn't very well…”
  // The fault is a mark that should be DELETED. Alternation wanted two flips
  // and would have put an opening mark in the middle of a sentence.
  const text =
    `${CURLY_CONTEXT}\n\n` +
    `“Well, there's been a change of plans. “You are going to the colosseum, ` +
    `to fight amongst the criminals.” Couldn't very well have someone with ` +
    `your scars walk around, could we?”`;
  assert.deepEqual(getQuoteCorrections(text), []);
});

test("many straight marks in one paragraph still convert together", () => {
  // Style conversion is safe in bulk — the manuscript's style is not in doubt —
  // so the one-fix limit must apply only to marks facing the wrong way.
  const text = `${CURLY_CONTEXT}\n\n"No!" Laura said. "That's what we were told, and I believed it."`;
  const cs = getQuoteCorrections(text);
  assert.equal(cs.length, 1, JSON.stringify(cs));
  assert.doesNotMatch(cs[0].corrected, /"/);
});
