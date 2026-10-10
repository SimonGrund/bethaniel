// ── Betty's house-style questions, on this side ──
//
// Before a copy edit, line edit or Final readthrough Betty asks where the
// manuscript disagrees with itself (backend/src/houseStyle.ts) and about the
// settings its detection could not decide (from the document's own
// `detected`). The answers settle house style: a setting with a control is
// set, everything else becomes a line in the style guide under one heading,
// so the edit follows it and later runs do not ask again.
//
// Pure; tested from backend/test/houseStyleAnswers.test.ts.

import {
  DEFAULT_COPY_EDIT_OPTIONS,
  type CopyEditOptions,
  type DetectedSettings,
} from "./types";

export type ConsistencyKind = "spelling" | "compound" | "numbers" | "dashes";
export type SettingKind = "dialect" | "oxfordComma" | "danishComma" | "quoteStyle";

export interface ConsistencyQuestion {
  id: string;
  kind: ConsistencyKind;
  forms: { form: string; count: number }[];
}

export interface SettingQuestion {
  id: SettingKind;
  kind: "setting";
  setting: SettingKind;
  options: string[];
}

export type EditQuestion = ConsistencyQuestion | SettingQuestion;

/** The settings detection could not decide, that the author has not set by
 *  hand: still at the default, and the manuscript said "unsure". `settled`
 *  holds the ones already answered for this manuscript — an answer that
 *  happened to be the default leaves no other trace. */
export function settingQuestions(
  detected: DetectedSettings | undefined,
  opts: CopyEditOptions,
  settled: string[] = [],
): SettingQuestion[] {
  if (!detected) return [];
  const out: SettingQuestion[] = [];
  const ask = (setting: SettingKind, options: string[]) => {
    if (!settled.includes(setting)) out.push({ id: setting, kind: "setting", setting, options });
  };
  const d = DEFAULT_COPY_EDIT_OPTIONS;
  if (detected.englishDialect?.status === "unsure" && opts.englishDialect === d.englishDialect)
    ask("dialect", ["american", "british"]);
  if (detected.oxfordComma?.status === "unsure" && opts.oxfordComma === d.oxfordComma)
    ask("oxfordComma", ["yes", "no"]);
  if (detected.danishComma?.status === "unsure" && opts.danishComma === d.danishComma)
    ask("danishComma", ["grammatisk", "nyt"]);
  if (detected.quoteStyle?.status === "unsure" && opts.quoteStyle === d.quoteStyle)
    ask("quoteStyle", ["curly", "straight"]);
  return out;
}

/** What the author can answer. A consistency question can always be left
 *  mixed; numbers also offer the common split rule. */
export function editQuestionOptions(q: EditQuestion): string[] {
  if (q.kind === "setting") return q.options;
  if (q.kind === "numbers") return ["words", "digits", "underTen", "mixed"];
  return [...q.forms.map((f) => f.form), "mixed"];
}

/** A rule in the interface language: (i18n key, {placeholders}) → text. */
export type RuleText = (key: string, params?: Record<string, string>) => string;

const quoted = (s: string) => `“${s}”`;

/** The answers as option changes and style-guide lines. "Leave it mixed" is
 *  a line too: it tells the editor to leave both forms alone, and it is what
 *  keeps the question from being asked again — the backend skips a conflict
 *  whose form or topic the style guide already names. */
export function applyEditAnswers(
  questions: EditQuestion[],
  answers: Record<string, string>,
  rule: RuleText,
): { options: Partial<CopyEditOptions>; lines: string[] } {
  const options: Partial<CopyEditOptions> = {};
  const lines: string[] = [];
  for (const q of questions) {
    const a = answers[q.id];
    if (!a) continue;
    if (q.kind === "setting") {
      if (q.setting === "dialect") options.englishDialect = a as CopyEditOptions["englishDialect"];
      if (q.setting === "oxfordComma") options.oxfordComma = a === "yes";
      if (q.setting === "danishComma") options.danishComma = a as CopyEditOptions["danishComma"];
      if (q.setting === "quoteStyle") options.quoteStyle = a as CopyEditOptions["quoteStyle"];
    } else if (a === "mixed") {
      if (q.kind === "numbers") lines.push(rule("hs_rule_numbers_mixed"));
      else if (q.kind === "dashes") lines.push(rule("hs_rule_dash_mixed"));
      else lines.push(rule("hs_rule_form_mixed", { forms: q.forms.map((f) => quoted(f.form)).join(", ") }));
    } else if (q.kind === "spelling" || q.kind === "compound") {
      const others = q.forms.filter((f) => f.form !== a).map((f) => quoted(f.form));
      lines.push(rule("hs_rule_form", { form: quoted(a), others: others.join(", ") }));
    } else if (q.kind === "numbers") {
      lines.push(rule(`hs_rule_numbers_${a}`));
    } else if (q.kind === "dashes") {
      lines.push(rule(`hs_rule_dash_${a.replace(/-/g, "_")}`));
    }
  }
  return { options, lines };
}

/** The style guide with `lines` under one "## heading" section: appended to
 *  it when it exists, a line already there not repeated. */
export function mergeHouseStyle(guide: string, lines: string[], heading: string): string {
  const fresh = lines.filter((l) => !guide.includes(l));
  if (fresh.length === 0) return guide;
  const items = fresh.map((l) => `- ${l}`).join("\n");
  const marker = `## ${heading}`;
  const at = guide.indexOf(marker);
  if (at < 0) return guide.trim() ? `${guide.trimEnd()}\n\n${marker}\n${items}` : `${marker}\n${items}`;
  // Insert at the end of that section: before the next heading, or the end.
  const after = at + marker.length;
  const next = guide.slice(after).search(/\n#{1,6} /);
  const end = next < 0 ? guide.length : after + next;
  return `${guide.slice(0, end).trimEnd()}\n${items}${guide.slice(end)}`;
}
