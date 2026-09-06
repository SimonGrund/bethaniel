# Task Selector v2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-category task step with three cards — the three things Betty is sold for — and move developmental edit, analysis and feedback into a grouped "Experimental" disclosure.

**Architecture:** `ModeSelector.tsx` shrinks to the three primary cards plus the controls that render *below* the card row; a new `BetaFeatures.tsx` owns the experimental groups. Mode groupings move to `types.ts` so both derive from one source. No backend behaviour changes — the backend already merges `copy_edit + line_edit` into `combined_edit` and multiple analysis modes into `combined_analysis`.

**Tech Stack:** React 18 + TypeScript, Zustand (`store.ts`, with `persist`), hand-written i18n table (`i18n.ts`), plain CSS (`global.css`). Backend tests are `node:test` via the tsx loader.

**Spec:** `docs/superpowers/specs/2026-09-06-task-selector-v2-design.md`

## Global Constraints

- **The three front cards must be exactly `CLOUD_ALLOWED_MODES` minus `combined_edit`**: `copy_edit`, `line_edit`, `proofread`, `publication_scan`, `translate`. The front of this screen is the paid product.
- **Every new user-visible string needs all four languages**: `en`, `da`, `de`, `es`. The i18n table has no fallback — a missing language renders the key.
- **Cards have no inside.** Controls belonging to a card render below the card row, never within the card element.
- **Selection stays mutually exclusive** across cards and Beta groups.
- **Copy edit cannot be switched off** from the Edit card. Only line edit toggles.
- **No repaint.** Reuse existing CSS custom properties and class conventions; this is a structure change, not a restyle.
- **The frontend has no test runner.** Do not write frontend tests or claim to. Verification for frontend tasks is `npm run build:frontend` plus the manual check listed in the task.

---

### Task 1: Pin the paid-mode list and add the shared groupings

**Files:**
- Create: `backend/test/cloudModes.test.ts`
- Modify: `frontend/src/types.ts` (append after `FINAL_READTHROUGH_MODES`, currently ends line 41)

**Interfaces:**
- Consumes: `CLOUD_ALLOWED_MODES` from `backend/src/cloudEstimate.ts`
- Produces: `FRONT_CARD_MODES: TaskMode[]`, `BETA_GROUPS: BetaGroup[]`, `type BetaGroupId`, `type FrontCard` — used by Tasks 3 and 4.

- [ ] **Step 1: Write the failing test**

Create `backend/test/cloudModes.test.ts`:

```ts
// The three cards on the task step are the paid product. If this list and
// that card set ever disagree, we are either advertising something we will
// not sell or hiding something we would.
//
// The card set cannot be imported here: the frontend has no test runner and
// the backend deliberately does not depend on frontend types (see the same
// note in cloudEstimate.test.ts). So this pins the backend half — the half
// that costs money if it is wrong — and names the frontend constant that
// must move with it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CLOUD_ALLOWED_MODES } from "../src/cloudEstimate.ts";

test("the sellable modes are exactly the three front cards, plus the merge target", () => {
  // Mirrors FRONT_CARD_MODES in frontend/src/types.ts. combined_edit is the
  // backend's merge of copy_edit + line_edit; no user ever selects it.
  const expected = [
    "copy_edit",
    "line_edit",
    "combined_edit",
    "proofread",
    "publication_scan",
    "translate",
  ];
  assert.deepEqual([...CLOUD_ALLOWED_MODES].sort(), expected.sort());
});

test("no experimental mode is sellable", () => {
  // These live behind the Experimental disclosure and are not benchmarked
  // well enough to charge for.
  for (const mode of [
    "developmental_edit",
    "character_catalog",
    "location_catalog",
    "timeline",
    "combined_analysis",
    "text_evaluator",
  ]) {
    assert.ok(
      !CLOUD_ALLOWED_MODES.includes(mode),
      `${mode} must not be sellable while it sits under Experimental`,
    );
  }
});
```

- [ ] **Step 2: Run it and watch it pass**

```bash
cd backend && npm test 2>&1 | grep -E "cloudModes|ℹ (tests|pass|fail)"
```

Expected: both tests PASS, `fail 0`. This test documents current behaviour rather than driving new behaviour — it fails only when someone later changes the allowlist without changing the cards.

- [ ] **Step 3: Add the groupings to `frontend/src/types.ts`**

Append after the `modeLabelKeys` function (currently ends line 58):

```ts
// ── Task-step grouping ──
//
// The three front cards are the paid product: FRONT_CARD_MODES must stay
// equal to CLOUD_ALLOWED_MODES (backend/src/cloudEstimate.ts) minus
// combined_edit, which the backend synthesises from copy_edit + line_edit and
// no user ever selects. backend/test/cloudModes.test.ts pins the other side.

export type FrontCard = "edit" | "readthrough" | "translate";

/** Modes each front card selects. The Edit card's line_edit is removable via
 *  its own toggle; copy_edit is not — without it the card means nothing. */
export const FRONT_CARD_MODES: Record<FrontCard, TaskMode[]> = {
  edit: ["copy_edit", "line_edit"],
  readthrough: FINAL_READTHROUGH_MODES,
  translate: ["translate"],
};

export type BetaGroupId = "developmental" | "analysis" | "feedback";

export interface BetaGroup {
  id: BetaGroupId;
  modes: TaskMode[];
  /** A whole-manuscript pass that cannot be combined with anything else. */
  exclusive: boolean;
}

export const BETA_GROUPS: BetaGroup[] = [
  { id: "developmental", modes: ["developmental_edit"], exclusive: true },
  {
    id: "analysis",
    modes: ["character_catalog", "location_catalog", "timeline"],
    exclusive: false,
  },
  { id: "feedback", modes: ["text_evaluator"], exclusive: true },
];

/** Which front card, if any, a selection belongs to. */
export function frontCardFor(modes: TaskMode[]): FrontCard | null {
  if (modes.some((m) => FRONT_CARD_MODES.translate.includes(m))) return "translate";
  if (modes.some((m) => FRONT_CARD_MODES.readthrough.includes(m))) return "readthrough";
  if (modes.some((m) => FRONT_CARD_MODES.edit.includes(m))) return "edit";
  return null;
}

/** Which Beta group a selection belongs to, if any. Drives whether the
 *  disclosure starts open so a saved choice is never invisible. */
export function betaGroupFor(modes: TaskMode[]): BetaGroupId | null {
  for (const group of BETA_GROUPS) {
    if (modes.some((m) => group.modes.includes(m))) return group.id;
  }
  return null;
}
```

Note the order in `frontCardFor`: translate and readthrough are checked before edit because `FINAL_READTHROUGH_MODES` contains `proofread`, which is not in the edit card, but a stale persisted selection could contain modes from more than one card. First match wins, most specific first.

- [ ] **Step 4: Typecheck**

```bash
npm run build:frontend
```

Expected: builds clean. `types.ts` exports are unused so far — that is fine, `tsc` does not error on unused exports.

- [ ] **Step 5: Commit**

```bash
git add backend/test/cloudModes.test.ts frontend/src/types.ts
git commit -m "feat(tasks): shared front-card and Beta groupings, and a guard on what is sellable"
```

---

### Task 2: Add the i18n strings

**Files:**
- Modify: `frontend/src/i18n.ts` (add to the `TRANSLATIONS` object)

**Interfaces:**
- Produces: the translation keys used by Tasks 3 and 4. Exact key names below — Tasks 3 and 4 call `t()` with these and nothing else.

- [ ] **Step 1: Add the keys**

Add to the `TRANSLATIONS` object in `frontend/src/i18n.ts`. Every key needs all four languages; a missing one renders the key itself.

```ts
  // ── Task step v2: "I want to…" heading, three cards, Beta disclosure ──
  tasks_heading: {
    en: "I want to…",
    da: "Jeg vil gerne…",
    de: "Ich möchte…",
    es: "Quiero…",
  },
  card_edit_title: {
    en: "Edit my manuscript",
    da: "Redigere mit manuskript",
    de: "Mein Manuskript bearbeiten",
    es: "Editar mi manuscrito",
  },
  card_edit_desc: {
    en: "Copy and line edit",
    da: "Korrektur og stilredigering",
    de: "Korrektur und Stilbearbeitung",
    es: "Corrección de texto y de estilo",
  },
  card_readthrough_title: {
    en: "Final readthrough",
    da: "Sidste gennemlæsning",
    de: "Letzter Durchgang",
    es: "Lectura final",
  },
  card_readthrough_desc: {
    en: "A last surface pass before publishing",
    da: "Et sidste overfladisk tjek før udgivelse",
    de: "Ein letzter Oberflächencheck vor der Veröffentlichung",
    es: "Una última revisión superficial antes de publicar",
  },
  card_translate_title: {
    en: "Translate my manuscript",
    da: "Oversætte mit manuskript",
    de: "Mein Manuskript übersetzen",
    es: "Traducir mi manuscrito",
  },
  card_translate_desc: {
    en: "Into another language",
    da: "Til et andet sprog",
    de: "In eine andere Sprache",
    es: "A otro idioma",
  },
  opt_also_line_edit: {
    en: "Also run a line edit",
    da: "Kør også en stilredigering",
    de: "Auch eine Stilbearbeitung durchführen",
    es: "Ejecutar también una edición de estilo",
  },
  opt_also_line_edit_hint: {
    en: "Rewrites for flow and phrasing. Slower, and more of what it suggests is a matter of taste.",
    da: "Omskrivninger for flow og formuleringer. Langsommere, og mere af det er en smagssag.",
    de: "Umformulierungen für Fluss und Ausdruck. Langsamer, und vieles davon ist Geschmackssache.",
    es: "Reescrituras de fluidez y expresión. Más lento, y más sujeto al gusto personal.",
  },
  beta_disclosure: {
    en: "Experimental — less tested",
    da: "Eksperimentelt — mindre testet",
    de: "Experimentell — weniger getestet",
    es: "Experimental — menos probado",
  },
  beta_disclosure_hint: {
    en: "These passes work, but they have had far less benchmarking than the three above. Expect rougher results.",
    da: "Disse funktioner virker, men de er testet langt mindre end de tre ovenfor. Forvent grovere resultater.",
    de: "Diese Durchgänge funktionieren, wurden aber weit weniger getestet als die drei oben. Erwarte gröbere Ergebnisse.",
    es: "Estas funciones sirven, pero se han probado mucho menos que las tres anteriores. Espera resultados más bastos.",
  },
  beta_group_developmental: {
    en: "Developmental edit",
    da: "Strukturredigering",
    de: "Strukturlektorat",
    es: "Edición de desarrollo",
  },
  beta_group_analysis: {
    en: "Analysis",
    da: "Analyse",
    de: "Analyse",
    es: "Análisis",
  },
  beta_group_feedback: {
    en: "Feedback",
    da: "Feedback",
    de: "Feedback",
    es: "Comentarios",
  },
```

- [ ] **Step 2: Verify every new key has four languages**

```bash
npx tsx -e '
import fs from "fs";
const src = fs.readFileSync("frontend/src/i18n.ts", "utf-8");
const keys = ["tasks_heading","card_edit_title","card_edit_desc","card_readthrough_title","card_readthrough_desc","card_translate_title","card_translate_desc","opt_also_line_edit","opt_also_line_edit_hint","beta_disclosure","beta_disclosure_hint","beta_group_developmental","beta_group_analysis","beta_group_feedback"];
let bad = 0;
for (const k of keys) {
  const m = new RegExp(`\\\\b${k}: \\\\{([^}]*)\\\\}`).exec(src);
  if (!m) { console.log(`MISSING key: ${k}`); bad++; continue; }
  for (const lang of ["en","da","de","es"]) {
    if (!new RegExp(`\\\\b${lang}:`).test(m[1])) { console.log(`${k} missing ${lang}`); bad++; }
  }
}
console.log(bad === 0 ? "all 14 keys complete in 4 languages" : `${bad} problems`);
'
```

Expected: `all 14 keys complete in 4 languages`

- [ ] **Step 3: Typecheck**

```bash
npm run build:frontend
```

Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/i18n.ts
git commit -m "feat(i18n): strings for the v2 task step, in all four languages"
```

---

### Task 3: Extract the experimental modes into `BetaFeatures`

**Files:**
- Create: `frontend/src/components/BetaFeatures.tsx`
- Read for reference: `frontend/src/components/ModeSelector.tsx` lines 467–543 (the developmental, analysis and feedback panels being moved)

**Interfaces:**
- Consumes: `BETA_GROUPS`, `BetaGroupId`, `betaGroupFor` from Task 1; `beta_group_*` keys from Task 2.
- Produces: `export default function BetaFeatures()` — takes no props; reads and writes the store directly, as `ModeSelector` does. Task 4 renders `<BetaFeatures />`.

- [ ] **Step 1: Create the component**

```tsx
// ── Experimental task modes ──
//
// Everything Betty can do that is not one of the three paid passes. Kept in
// its own file on purpose: the front card set in ModeSelector is the paid
// product, and this drawer is where new work lands before it earns a card.
// One file holds what we sell, this one holds what we are still testing.

import { useState } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import { BETA_GROUPS, betaGroupFor } from "../types";
import type { BetaGroupId, TaskMode } from "../types";

export default function BetaFeatures() {
  const lang = useStore((s) => s.lang);
  const selectedModes = useStore((s) => s.selectedModes);
  const setSelectedModes = useStore((s) => s.setSelectedModes);
  const markStepComplete = useStore((s) => s.markStepComplete);
  const t = useTranslation(lang);

  // Open when the saved selection already lives in here, so an existing
  // developmental-edit or analysis user does not find their choice hidden.
  const [open, setOpen] = useState(() => betaGroupFor(selectedModes) !== null);

  const activeGroup = betaGroupFor(selectedModes);

  function selectGroup(id: BetaGroupId) {
    const group = BETA_GROUPS.find((g) => g.id === id);
    if (!group) return;
    // Selection is one intent: picking a Beta group replaces the front-card
    // selection entirely, exactly as picking a card clears this.
    setSelectedModes([...group.modes]);
    markStepComplete("edits");
  }

  function toggleMode(mode: TaskMode, group: (typeof BETA_GROUPS)[number]) {
    if (group.exclusive) {
      selectGroup(group.id);
      return;
    }
    const withinGroup = selectedModes.filter((m) => group.modes.includes(m));
    const next = withinGroup.includes(mode)
      ? withinGroup.filter((m) => m !== mode)
      : [...withinGroup, mode];
    // Never leave the panel with nothing selected — mirrors toggleMode in
    // the store and toggleEditingChoice in the old selector.
    if (next.length === 0) return;
    // Keep declaration order regardless of click order.
    setSelectedModes(group.modes.filter((m) => next.includes(m)));
    markStepComplete("edits");
  }

  return (
    <section className="beta-features">
      <button
        type="button"
        className={`beta-disclosure${open ? " beta-disclosure-open" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="beta-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        {t("beta_disclosure")}
        {activeGroup && !open && (
          <span className="beta-active-badge">
            {t(`beta_group_${activeGroup}`)}
          </span>
        )}
      </button>

      {open && (
        <div className="beta-panel">
          <p className="beta-hint">{t("beta_disclosure_hint")}</p>
          {BETA_GROUPS.map((group) => (
            <div key={group.id} className="beta-group">
              <span className="beta-group-name">
                {t(`beta_group_${group.id}`)}
              </span>
              <div className="beta-group-modes">
                {group.modes.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`mode-tab${selectedModes.includes(mode) ? " active" : ""}`}
                    onClick={() => toggleMode(mode, group)}
                  >
                    {t(`mode_${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run build:frontend
```

Expected: builds clean. The component is not rendered yet — Task 4 wires it in.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/BetaFeatures.tsx
git commit -m "feat(tasks): BetaFeatures component owning the experimental modes"
```

---

### Task 4: Rebuild `ModeSelector` as three cards

**Files:**
- Modify: `frontend/src/components/ModeSelector.tsx`

This is the largest task. It replaces lines 1–588 wholesale. Blocks that move rather than change are called out with their current line numbers so they can be copied verbatim.

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: no new exports; still `export default function ModeSelector()`.

- [ ] **Step 1: Replace the head of the file (lines 1–74) with the new imports and constants**

```tsx
// ── Task selector — three cards, one intent ──
//
// The three cards here are the paid product (FRONT_CARD_MODES in types.ts,
// pinned against the backend allowlist by backend/test/cloudModes.test.ts).
// Everything experimental lives in BetaFeatures.
//
// Cards have no inside: a card that needs a control renders it below the card
// row, never within the card element. Keeps all three the same shape however
// much configuration hangs off one of them.

import { useEffect } from "react";
import { useStore } from "../store";
import { useTranslation } from "../i18n";
import BetaFeatures from "./BetaFeatures";
import { FRONT_CARD_MODES, frontCardFor } from "../types";
import type { FrontCard, TaskMode, CopyEditOptions, LineEditOptions } from "../types";

// Declared here, not imported — it is a local constant in the current file
// (line 64) and stays one. Step 3 reuses it in the manuscript-language row.
const KNOWN_MANUSCRIPT_LANGS = ["en", "da", "de", "es"];

const COPY_EDIT_KEYS: (keyof CopyEditOptions)[] = [
  "spelling",
  "punctuation",
  "capitalization",
  "duplicateWords",
  "dialogueTags",
];

const LINE_EDIT_KEYS: (keyof LineEditOptions)[] = [
  "awkwardPhrasing",
  "redundancy",
  "weakVerbs",
  "cliches",
  "showDontTell",
  "sentenceRhythm",
  "dialogueNaturalness",
  "tightenProse",
];

const CARDS: { id: FrontCard; titleKey: string; descKey: string }[] = [
  { id: "edit", titleKey: "card_edit_title", descKey: "card_edit_desc" },
  {
    id: "readthrough",
    titleKey: "card_readthrough_title",
    descKey: "card_readthrough_desc",
  },
  {
    id: "translate",
    titleKey: "card_translate_title",
    descKey: "card_translate_desc",
  },
];
```

- [ ] **Step 2: Replace the component body's state and handlers (old lines 75–171)**

```tsx
export default function ModeSelector() {
  const {
    lang,
    selectedModes,
    setSelectedModes,
    copyEditOptions,
    setCopyEditOption,
    lineEditOptions,
    setLineEditOption,
    targetLang,
    setTargetLang,
    manuscriptLang,
    setManuscriptLang,
    markStepComplete,
    lineEditEnabled,
    setLineEditEnabled,
  } = useStore();
  const t = useTranslation(lang);

  // Dropped from the destructure deliberately: `advanceWizard`,
  // `editSubOptionsOpen`, `setEditSubOptionsOpen`, `wizardStep`, `model` and
  // `toggleMode` are all unused once the five-category panels are gone.
  // `advanceWizard` was already dead in the current file — destructured at
  // line 90 and never called.

  const activeCard = frontCardFor(selectedModes);
  // Truth for the current selection. `lineEditEnabled` is the remembered
  // preference used when the Edit card is re-selected; while the card is
  // active the selection itself is authoritative.
  const lineEditOn = selectedModes.includes("line_edit");
  const isEnglishManuscript = manuscriptLang === "en";

  // Reconcile a selection saved before `lineEditEnabled` existed (or by an
  // older UI): if the Edit card is showing copy-only, the remembered
  // preference must say so too, or the next visit to this card silently turns
  // the line pass back on. Runs once; the two agree from then on.
  useEffect(() => {
    if (activeCard === "edit" && lineEditOn !== lineEditEnabled) {
      setLineEditEnabled(lineEditOn);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectCard(id: FrontCard) {
    // Re-clicking the active card is a no-op rather than a deselect: the step
    // must always have an answer, and "nothing selected" is not one.
    if (activeCard === id) return;
    // The Edit card restores the remembered line-edit preference, so turning
    // the line pass off survives a trip to another card and back.
    const modes: TaskMode[] =
      id === "edit" && !lineEditEnabled
        ? ["copy_edit"]
        : [...FRONT_CARD_MODES[id]];
    setSelectedModes(modes);
    markStepComplete("edits");
  }

  function toggleLineEdit(on: boolean) {
    setSelectedModes(on ? ["copy_edit", "line_edit"] : ["copy_edit"]);
    setLineEditEnabled(on);
    markStepComplete("edits");
  }
```

Note the `selectCard` guard: a persisted `["copy_edit"]` (line edit deliberately off) must survive a click on a different card and back again, so the Edit card only resets to both when it was not already the active card.

- [ ] **Step 3: Keep the manuscript-language row unchanged**

Copy the `manuscriptLangRow` block verbatim from the current file, **lines 173–208** (`const isKnownManuscriptLang = …` through the closing `);`). It is unchanged. It uses `KNOWN_MANUSCRIPT_LANGS`, which Step 1 re-declares — it is a local `const` at line 64 today, not an import.

- [ ] **Step 4: Replace the render (old lines 209–588)**

```tsx
  return (
    <section className="mode-selector">
      <h2 className="tasks-heading">{t("tasks_heading")}</h2>

      <div className="task-cards">
        {CARDS.map((card) => (
          <button
            key={card.id}
            type="button"
            className={`task-card${activeCard === card.id ? " task-card-active" : ""}`}
            aria-pressed={activeCard === card.id}
            onClick={() => selectCard(card.id)}
          >
            <span className="task-card-title">{t(card.titleKey)}</span>
            <span className="task-card-desc">{t(card.descKey)}</span>
          </button>
        ))}
      </div>

      {activeCard && <div className="task-controls">{renderControls()}</div>}

      <BetaFeatures />
    </section>
  );

  function renderControls() {
    if (activeCard === "translate") {
      return (
        <>
          {manuscriptLangRow}
          {/* Target-language picker, moved verbatim from the old
              translation panel (lines 553–566). */}
        </>
      );
    }
    if (activeCard === "readthrough") {
      return manuscriptLangRow;
    }
    return (
      <>
        <label className="line-edit-toggle">
          <input
            type="checkbox"
            checked={lineEditOn}
            onChange={(e) => toggleLineEdit(e.target.checked)}
          />
          <span className="line-edit-toggle-label">{t("opt_also_line_edit")}</span>
          <span className="line-edit-toggle-hint">
            {t("opt_also_line_edit_hint")}
          </span>
        </label>

        {manuscriptLangRow}

        {/* Copy-edit option panel: moved verbatim from lines 364–446. */}
        {/* Line-edit option panel: moved verbatim from lines 449–465,
            rendered only while lineEditOn. */}
      </>
    );
  }
}
```

Three blocks are moved verbatim rather than reproduced here, because they are long and unchanged — copying them avoids transcription errors:

- **Target-language picker** — current lines 553–566, into the `translate` branch.
- **Copy-edit option panel** — current lines 364–446 (the whole `{isSelected("copy_edit") && (…)}` body, without the `isSelected` guard: on the Edit card copy edit is always on). Keep the `isEnglishManuscript` guards inside it exactly as they are.
- **Line-edit option panel** — current lines 449–465 (the `{isSelected("line_edit") && (…)}` body). Keep its guard, changing `isSelected("line_edit")` to `lineEditOn`.

Everything else in the old file is deleted: the five card buttons, `Category`, `CATEGORY_COLOR`, `EDITING_CHOICES`, `EDITING_CHOICE_MODES`, `EXCLUSIVE_CHOICES`, `toggleEditingChoice`, `selectCategory`, `openCat`, and the analysis, feedback, developmental and readthrough panels (the last of which had no controls at all).

- [ ] **Step 4b: Add the remembered line-edit preference to the store**

In `frontend/src/store.ts`, add to the state interface alongside
`selectedModes`:

```ts
  /** Whether the Edit card includes the line pass. Remembered separately from
   *  `selectedModes` so that switching to another card and back does not
   *  silently re-arm a pass the user deliberately turned off. */
  lineEditEnabled: boolean;
  setLineEditEnabled: (on: boolean) => void;
```

and to the store body, next to `setSelectedModes`:

```ts
      lineEditEnabled: true,
      setLineEditEnabled: (lineEditEnabled) => set({ lineEditEnabled }),
```

It must be persisted. Check how persistence is declared — if there is a
`partialize` list, add `lineEditEnabled` to it; if persistence is
opt-out, no change is needed. Verify with:

```bash
grep -n "partialize" -A 30 frontend/src/store.ts | grep -n "selectedModes"
```

If `selectedModes` appears there, `lineEditEnabled` must too.

- [ ] **Step 5: Remove the now-dead store fields if nothing else uses them**

```bash
grep -rn "editSubOptionsOpen" frontend/src --include=*.tsx --include=*.ts
```

If the only remaining hits are the store definition itself, delete `editSubOptionsOpen` and `setEditSubOptionsOpen` from `frontend/src/store.ts` and from the persist partialize list if present. If any other component still uses them, leave them alone and note it in the commit message.

- [ ] **Step 6: Build**

```bash
npm run build:frontend
```

Expected: builds clean, no unused-import errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/ModeSelector.tsx frontend/src/store.ts
git commit -m "feat(tasks): three-card task step with a line-edit toggle"
```

---

### Task 5: Style the card row, controls and disclosure

**Files:**
- Modify: `frontend/src/styles/global.css`

**Interfaces:**
- Consumes: the class names emitted by Tasks 3 and 4 — `tasks-heading`, `task-cards`, `task-card`, `task-card-active`, `task-card-title`, `task-card-desc`, `task-controls`, `line-edit-toggle`, `line-edit-toggle-label`, `line-edit-toggle-hint`, `beta-features`, `beta-disclosure`, `beta-disclosure-open`, `beta-chevron`, `beta-active-badge`, `beta-panel`, `beta-hint`, `beta-group`, `beta-group-name`, `beta-group-modes`.

- [ ] **Step 1: Find the existing mode-card styles to match**

```bash
grep -n "mode-cat-card\|mode-sub-panel\|mode-tab" frontend/src/styles/global.css | head -20
```

Reuse their border, radius, shadow and transition values. This is a structure change, not a restyle — the new cards should read as the same family as the rest of the app.

- [ ] **Step 2: Add the styles**

Append near the existing `.mode-cat-card` rules so related styles stay together:

```css
/* ── Task step v2: three cards, one intent ── */
.tasks-heading {
  font-family: "Cormorant Garamond", Georgia, serif;
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0 0 0.75rem;
  color: #2a2419;
}

/* Equal columns, so no card reads as the default by being wider. */
.task-cards {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
}

.task-card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  text-align: left;
  padding: 1rem 1.1rem;
  border: 1px solid #c9b896;
  border-radius: 4px;
  background: #fdfaf0;
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}

.task-card:hover {
  border-color: #8a7050;
}

.task-card-active {
  border-color: #8a7050;
  border-width: 2px;
  /* Compensate the extra border so the row does not shift on selection. */
  padding: calc(1rem - 1px) calc(1.1rem - 1px);
  box-shadow: 0 1px 3px rgba(42, 36, 25, 0.12);
}

.task-card-title {
  font-family: "Cormorant Garamond", Georgia, serif;
  font-size: 1.15rem;
  font-weight: 600;
  color: #2a2419;
}

.task-card-desc {
  font-size: 0.82rem;
  color: #5a4f3f;
}

.task-controls {
  margin-top: 0.9rem;
  padding: 0.9rem 1.1rem;
  border: 1px solid #ded2b8;
  border-radius: 4px;
  background: #efe6d0;
}

.line-edit-toggle {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.15rem 0.5rem;
  align-items: baseline;
  cursor: pointer;
  margin-bottom: 0.8rem;
}

.line-edit-toggle-label {
  font-weight: 600;
  color: #2a2419;
}

.line-edit-toggle-hint {
  grid-column: 2;
  font-size: 0.8rem;
  color: #8b7355;
}

/* ── Experimental disclosure ── */
.beta-features {
  margin-top: 1.1rem;
  border-top: 1px solid #ded2b8;
  padding-top: 0.8rem;
}

.beta-disclosure {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.85rem;
  font-weight: 600;
  color: #8b7355;
  letter-spacing: 0.02em;
}

.beta-chevron {
  font-size: 0.7rem;
}

.beta-active-badge {
  margin-left: 0.4rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: #e8dfc8;
  color: #4a3f2f;
  font-size: 0.7rem;
  font-weight: 600;
}

.beta-panel {
  margin-top: 0.7rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.beta-hint {
  margin: 0;
  font-size: 0.8rem;
  color: #8b7355;
  max-width: 44rem;
}

.beta-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.beta-group-name {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #8b7355;
}

.beta-group-modes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

/* Narrow windows: the three cards stack rather than squeezing. */
@media (max-width: 900px) {
  .task-cards {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 3: Build**

```bash
npm run build:frontend
```

Expected: builds clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/styles/global.css
git commit -m "feat(tasks): styles for the three-card task step and Beta disclosure"
```

---

### Task 6: Change the default selection and verify in the running app

**Files:**
- Modify: `frontend/src/store.ts:460`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Change the default**

At `frontend/src/store.ts:460`, change:

```ts
      selectedModes: ["copy_edit"],
```

to:

```ts
      // Both passes: the Edit card is pre-selected and means what its label
      // says. Turning the line pass off is a visible toggle, not a default.
      selectedModes: ["copy_edit", "line_edit"],
```

`lineEditEnabled` was defaulted to `true` in Task 4 Step 4b; the two defaults
must agree or the toggle contradicts the selection on a fresh profile.

- [ ] **Step 2: Start the dev stack**

```bash
npm run dev
```

Wait for `http://localhost:4000/health` to answer and Vite to serve `:5173`.

**Only one backend may run at a time.** Two Bethaniel backends on one machine each supervise llama-server and kill what each takes to be the other's orphan; it surfaces as "editor agent failed after retries" and points at the model rather than the cause. Check with `lsof -ti:4000 -sTCP:LISTEN | wc -l` — it must print `1`.

- [ ] **Step 3: Walk the manual checklist**

With a manuscript uploaded, on the task step:

1. Edit card is selected on a fresh profile, line toggle on.
2. Turning the line toggle off leaves the Edit card selected; the line-edit option panel disappears; the copy-edit options stay.
3. Click Translate, then Edit again — the line toggle is **still off**, and the line-edit option panel is still hidden. This is `lineEditEnabled` doing its job; deriving the toggle from the selection alone would flip it back on here.
4. Final readthrough selects and shows only the manuscript-language row.
5. The Experimental disclosure is collapsed, opens on click, and its three groups select correctly.
6. Selecting an analysis mode clears the front card; selecting a card clears the Beta selection.
7. Analysis allows more than one mode; developmental and feedback replace the selection.
8. Reload the page — the selection and the toggle state survive. Then, with line edit off, quit and reopen the app: still off (this is what the persisted preference buys over a component-local one).
9. Switch the interface language to Danish and confirm no raw keys (`card_edit_title`) render.
10. Narrow the window below 900px — the cards stack.

- [ ] **Step 4: Run a real job**

Select Edit with the line toggle **off**, run it on a short chapter, and confirm the run summary reports a copy edit only — no line-edit corrections appear.

- [ ] **Step 5: Full test suite**

```bash
cd backend && npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"
```

Expected: `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/store.ts
git commit -m "feat(tasks): default to copy and line edit together"
```

---

## Notes for the implementer

- **Do not add frontend tests.** There is no runner. Verification is the build plus the manual checklist in Task 6.
- **`combined_edit` is never selected by the UI.** The backend merges `copy_edit + line_edit` in `routes.ts`. If you find yourself adding `combined_edit` to a card, stop — that is the invariant in Task 1 breaking.
- **Beta modes must not become sellable.** `backend/test/cloudModes.test.ts` fails loudly if one is added to `CLOUD_ALLOWED_MODES`.
