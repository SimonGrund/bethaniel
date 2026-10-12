// ── The house-style lines, applied by code ──
//
// "Write “traveled”, not “travelled”." is a rule with one right answer, and
// the author wrote it down by answering Betty's house-style questions
// (frontend/src/houseStyleAnswers.ts). It used to be enforced by the style-
// sheet agent, a model asked to find violations of the sheet. On Local
// Betty that agent produced 251 of 834 cards on a real novel and was right
// about one time in ten: "pelts." → "traveled pelts.", "marched" →
// "traveled", "bolt" → "Take" — it wrote the sheet's words into sentences
// that had nothing to do with them. The few things it got right were these
// lines. So the lines are applied here, as find-and-replace, and the agent
// no longer runs on a local model (routes.ts).
//
// The line is read in whichever interface language wrote it. The templates
// below are copies of `hs_rule_form` in frontend/src/i18n.ts; the test
// (backend/test/houseStyleRules.test.ts) fails if the two drift.
//
// Pure.

import type { Correction } from "./types.js";
import { isSentenceInitial } from "./spellcheck.js";
import { widenToWords } from "./retextChecks.js";

export interface HouseStyleRule {
  prefer: string;
  avoid: string[];
}

/** `hs_rule_form` in every interface language. */
export const HOUSE_STYLE_FORM_TEMPLATES: Record<string, string> = {
  en: "Write {form}, not {others}.",
  da: "Skriv {form}, ikke {others}.",
  de: "Schreibe {form}, nicht {others}.",
  es: "Escribe {form}, no {others}.",
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const LINE_PATTERNS = Object.values(HOUSE_STYLE_FORM_TEMPLATES).map(
  (tpl) =>
    new RegExp(
      "^" +
        escape(tpl)
          .replace(escape("{form}"), "“([^”]+)”")
          .replace(escape("{others}"), "((?:“[^”]+”(?:, )?)+)") +
        "$",
    ),
);

/** The "write X, not Y" lines of a style guide, in any interface language. */
export function parseHouseStyleRules(guide: string): HouseStyleRule[] {
  const rules: HouseStyleRule[] = [];
  for (const raw of guide.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s+/, "");
    for (const re of LINE_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const avoid = [...m[2].matchAll(/“([^”]+)”/g)].map((x) => x[1]).filter((f) => f && f !== m[1]);
      if (m[1] && avoid.length) rules.push({ prefer: m[1], avoid });
      break;
    }
  }
  return rules;
}

/** The preferred form in the case the text wrote: "Travelled" → "Traveled". */
function inCaseOf(found: string, prefer: string): string {
  if (found === found.toUpperCase() && found !== found.toLowerCase()) return prefer.toUpperCase();
  if (found[0] !== found[0].toLowerCase() && prefer[0] === prefer[0].toLowerCase()) {
    return prefer[0].toUpperCase() + prefer.slice(1);
  }
  return prefer;
}

/**
 * One correction per avoided form found in the text, anchored to the words
 * either side. The form as written, and — for a lowercase form — its
 * capitalised twin at the start of a sentence only: mid-sentence, a
 * capital is a name ("Mr Grey"), and the rule is about the word.
 */
export function getHouseStyleCorrections(text: string, rules: HouseStyleRule[]): Correction[] {
  const out: Correction[] = [];
  const seen = new Set<string>();
  for (const { prefer, avoid } of rules) {
    for (const form of avoid) {
      const re = new RegExp(
        `(?<![\\p{L}\\p{N}'’-])(${escape(form)})(?![\\p{L}\\p{N}'’-])`,
        form === form.toLowerCase() ? "giu" : "gu",
      );
      for (const m of text.matchAll(re)) {
        const found = m[1];
        const start = m.index!;
        if (found !== form) {
          // Only the capitalised twin, and only opening a sentence.
          const twin = form[0].toUpperCase() + form.slice(1);
          if (found !== twin || !isSentenceInitial(text, start)) continue;
        }
        const end = start + found.length;
        const [s, e] = widenToWords(text, start, end);
        const original = text.slice(s, e);
        const corrected = text.slice(s, start) + inCaseOf(found, prefer) + text.slice(end, e);
        const key = `${original}\u0000${corrected}`;
        if (original === corrected || seen.has(key)) continue;
        seen.add(key);
        out.push({
          original,
          corrected,
          reason: "house-style",
          kind: "copy",
          preApproved: true,
        } as Correction);
      }
    }
  }
  return out;
}
