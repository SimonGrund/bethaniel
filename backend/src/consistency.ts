// ── Consistency checker — ported from consistency_checker.py ──
// Pure deterministic checks, no LLM.

import type { ConsistencyReport } from "./types.js";

const WORD_RE = /[A-Za-z][A-Za-z'\-]*/g;

// ── Check 1: case variants ──
function checkCaseVariants(text: string, minOccurrences: number): string[] {
  const words = text.match(WORD_RE) ?? [];
  const byLower: Record<string, Record<string, number>> = {};

  for (const word of words) {
    const lower = word.toLowerCase();
    if (!byLower[lower]) byLower[lower] = {};
    byLower[lower][word] = (byLower[lower][word] ?? 0) + 1;
  }

  const issues: string[] = [];
  for (const [lower, variants] of Object.entries(byLower)) {
    const keys = Object.keys(variants);
    if (keys.length < 2) continue;
    const total = Object.values(variants).reduce((s, c) => s + c, 0);
    if (total < minOccurrences) continue;
    const significant = Object.entries(variants).filter(([, c]) => c >= 2);
    if (significant.length < 2) continue;
    const breakdown = Object.entries(variants)
      .sort((a, b) => b[1] - a[1])
      .map(([v, c]) => `\`${v}\` (${c}×)`)
      .join(", ");
    issues.push(`- **${lower}**: ${breakdown}`);
  }
  return issues.sort();
}

// ── Check 2: spelling variant pairs ──
const VARIANT_PAIRS: [string, string][] = [
  ["grey", "gray"],
  ["colour", "color"],
  ["favour", "favor"],
  ["honour", "honor"],
  ["centre", "center"],
  ["theatre", "theater"],
  ["realise", "realize"],
  ["recognise", "recognize"],
  ["organisation", "organization"],
  ["travelled", "traveled"],
  ["travelling", "traveling"],
  ["cancelled", "canceled"],
  ["modelling", "modeling"],
  ["defence", "defense"],
  ["offence", "offense"],
  ["licence", "license"],
  ["practise", "practice"],
  ["aluminium", "aluminum"],
  ["ok", "okay"],
  ["email", "e-mail"],
  ["goodbye", "good-bye"],
  ["today", "to-day"],
  ["alright", "all right"],
  ["anymore", "any more"],
  ["awhile", "a while"],
];

function checkSpellingPairs(text: string): string[] {
  const issues: string[] = [];
  const lower = text.toLowerCase();
  for (const [a, b] of VARIANT_PAIRS) {
    const aCount = (lower.match(new RegExp(`\\b${escapeRe(a)}\\b`, "g")) ?? [])
      .length;
    const bCount = (lower.match(new RegExp(`\\b${escapeRe(b)}\\b`, "g")) ?? [])
      .length;
    if (aCount > 0 && bCount > 0) {
      issues.push(`- \`${a}\` (${aCount}×) vs \`${b}\` (${bCount}×)`);
    }
  }
  return issues;
}

// ── Check 3: hyphenation inconsistencies ──
function checkHyphenation(text: string): string[] {
  const hyphenated = new Set(text.match(/\b[a-zA-Z]+-[a-zA-Z]+\b/g) ?? []);
  const issues: string[] = [];
  for (const term of [...hyphenated].sort()) {
    const unhyphenated = term.replace(/-/g, " ");
    const unhyphenCount = (
      text.match(new RegExp(`\\b${escapeRe(unhyphenated)}\\b`, "gi")) ?? []
    ).length;
    const hyphenCount = (
      text.match(new RegExp(`\\b${escapeRe(term)}\\b`, "gi")) ?? []
    ).length;
    if (unhyphenCount > 0 && hyphenCount > 0) {
      issues.push(
        `- \`${term}\` (${hyphenCount}×) vs \`${unhyphenated}\` (${unhyphenCount}×)`,
      );
    }
  }
  return issues;
}

// ── Check 4: typography mixing ──
function checkTypography(text: string): string[] {
  const issues: string[] = [];

  const straightDq = (text.match(/"/g) ?? []).length;
  const curlyDq = (text.match(/[\u201c\u201d]/g) ?? []).length;
  if (straightDq > 0 && curlyDq > 0) {
    issues.push(
      `- Double quotes: straight \`"\` (${straightDq}×) vs curly \`\u201c \u201d\` (${curlyDq}×)`,
    );
  }

  const straightSq = (text.match(/'/g) ?? []).length;
  const curlySq = (text.match(/[\u2018\u2019]/g) ?? []).length;
  if (straightSq > 5 && curlySq > 5) {
    issues.push(
      `- Single quotes / apostrophes: straight \`'\` (${straightSq}×) vs curly \`\u2018 \u2019\` (${curlySq}×)`,
    );
  }

  const emDash = (text.match(/\u2014/g) ?? []).length;
  const enDash = (text.match(/\u2013/g) ?? []).length;
  const doubleHyphen = (text.match(/--/g) ?? []).length;
  const dashStyles = [emDash, enDash, doubleHyphen].filter((v) => v > 0).length;
  if (dashStyles > 1) {
    const parts: string[] = [];
    if (emDash) parts.push(`em \`\u2014\` (${emDash}×)`);
    if (enDash) parts.push(`en \`\u2013\` (${enDash}×)`);
    if (doubleHyphen) parts.push(`\`--\` (${doubleHyphen}×)`);
    issues.push(`- Dashes: ${parts.join(" vs ")}`);
  }

  const tripleDot = (text.match(/\.\.\./g) ?? []).length;
  const ellipsisChar = (text.match(/\u2026/g) ?? []).length;
  if (tripleDot > 0 && ellipsisChar > 0) {
    issues.push(
      `- Ellipses: \`...\` (${tripleDot}×) vs \`\u2026\` (${ellipsisChar}×)`,
    );
  }

  return issues;
}

// ── Check 5: duplicate consecutive words ──
function checkDuplicateWords(text: string): string[] {
  const flattened = text.replace(/\s+/g, " ");
  const seen: Record<string, number> = {};
  const re = /\b([A-Za-z']+)\s+\1\b/gi;
  const skip = new Set(["that", "had", "is", "do", "no", "very", "so", "now"]);
  let m: RegExpExecArray | null;
  while ((m = re.exec(flattened)) !== null) {
    const word = m[1].toLowerCase();
    if (skip.has(word)) continue;
    seen[word] = (seen[word] ?? 0) + 1;
  }
  return Object.entries(seen)
    .sort((a, b) => b[1] - a[1])
    .map(([word, count]) => `- \`${word} ${word}\` (${count}×)`);
}

// ── Check 6: number style mixing ──
const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

function checkNumberStyle(text: string): string[] {
  const lower = text.toLowerCase();
  const issues: string[] = [];
  for (const [word, digit] of Object.entries(NUMBER_WORDS)) {
    const wordCount = (lower.match(new RegExp(`\\b${word}\\b`, "g")) ?? [])
      .length;
    const digitCount = (
      text.match(new RegExp(`(?<!\\d)${digit}(?!\\d)`, "g")) ?? []
    ).length;
    if (wordCount > 0 && digitCount > 0) {
      issues.push(
        `- \`${word}\` (${wordCount}×) vs \`${digit}\` (${digitCount}×)`,
      );
    }
  }
  return issues;
}

// ── Check 7: proper noun misspellings ──
function checkProperNouns(text: string, minOccurrences: number): string[] {
  const candidates: Record<string, number> = {};
  const re = /\b([A-Z][a-z]{2,})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    candidates[m[1]] = (candidates[m[1]] ?? 0) + 1;
  }

  const items = Object.entries(candidates)
    .filter(([, c]) => c >= 2)
    .map(([w]) => w);

  function editDistanceOne(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 1) return false;
    if (a === b) return false;
    if (a.length === b.length) {
      let diff = 0;
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) diff++;
      }
      return diff === 1;
    }
    const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
    for (let i = 0; i < longer.length; i++) {
      if (shorter === longer.slice(0, i) + longer.slice(i + 1)) return true;
    }
    return false;
  }

  const seenPairs = new Set<string>();
  const issues: string[] = [];

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const w1 = items[i],
        w2 = items[j];
      if (w1.toLowerCase() === w2.toLowerCase()) continue;
      if (!editDistanceOne(w1, w2)) continue;
      const key = [w1, w2].sort().join("|");
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      if (candidates[w1] + candidates[w2] >= minOccurrences) {
        issues.push(
          `- \`${w1}\` (${candidates[w1]}×) vs \`${w2}\` (${candidates[w2]}×) — possible misspelling?`,
        );
      }
    }
  }
  return issues.sort();
}

// ── Report builder ──
export function buildConsistencyReport(
  fileName: string,
  text: string,
  minOccurrences = 2,
): ConsistencyReport {
  const sections: { title: string; items: string[] }[] = [
    {
      title: "Spelling variant pairs (American/British/style)",
      items: checkSpellingPairs(text),
    },
    {
      title: "Possibly misspelled proper nouns",
      items: checkProperNouns(text, minOccurrences),
    },
    {
      title: "Case variants (same word, different capitalization)",
      items: checkCaseVariants(text, minOccurrences),
    },
    { title: "Hyphenation inconsistencies", items: checkHyphenation(text) },
    {
      title: "Typography mixing (quotes / dashes / ellipses)",
      items: checkTypography(text),
    },
    { title: "Numbers: digits vs spelled out", items: checkNumberStyle(text) },
    { title: "Duplicate consecutive words", items: checkDuplicateWords(text) },
  ];

  const totalIssues = sections.reduce((s, sec) => s + sec.items.length, 0);

  return {
    title: `Consistency report for ${fileName}`,
    totalIssues,
    sections,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
