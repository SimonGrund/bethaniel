# 📖 Bethaniel — Private Copy Editor

A fully local, offline-capable AI copy editor for pre-print manuscripts.
Powered by a bundled [llama.cpp](https://github.com/ggml-org/llama.cpp) inference engine running entirely on your machine —
no internet, no cloud, no data leaves your computer. Check out www.bethaniel.eu for mailing list.

## Architecture

A single Node.js process serves both the API and the React UI.
The Electron app bundles `llama-server` for local GGUF model inference.

```
┌─────────────────────────────────────────┐
│  Browser (http://localhost:4000)        │
│  ──> React UI                           │
│  ──> /api  (REST)                       │
│  ──> /socket.io  (live queue updates)   │
├─────────────────────────────────────────┤
│  Node.js + Express                      │
│  ──> In-memory task queue               │
│  ──> SQLite (document persistence)      │
├─────────────────────────────────────────┤
│  llama-server (bundled)                 │
│  ──> Local LLM inference (GGUF models)  │
└─────────────────────────────────────────┘
```

## Editing Modes & Agent Architecture

### Task Modes

| Category   | Modes                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------- |
| **Editing**    | Copy edit (spelling, punctuation, grammar) and line edit (style, rhythm, phrasing). Select specific sub-options or run combined. |
| **Translation** | Full-text translation to any target language. Paragraph-level review catches garbled output and re-translates flagged sections. |
| **Analysis**   | Character catalog, location catalog, timeline. Auto-generates a prose summary and marketing blurb from the structured data. |

### Models

Five ways to run the same pipeline. The wizard's first step picks one; nothing
else about a job changes with the choice.

| Model | Where it runs | What you need |
| --- | --- | --- |
| **Baby Betty** — Qwen3.5 4B (Q4_K_M) | Your machine, via the bundled llama.cpp | ~3 GB disk, 8 GB RAM |
| **Big Bad Betty** — Qwen3.5 9B (Q4_K_M) | Your machine, via the bundled llama.cpp | ~6 GB disk, 16 GB RAM (12 GB on Apple Silicon) |
| **Custom Betty** | Your machine | Any GGUF file you point it at |
| **External Betty** | DeepSeek, or any OpenAI-compatible endpoint | Your own API key |
| **Betty in the Cloud** | Bethaniel's hosted service | A card — pay per job |

The two local models are the default and the only ones that keep the manuscript
on the machine. On the four-language benchmark the two score level overall (46
each); split by language the 9B gains about three points of recall and three of
precision, concentrated in capitalization, German commas and translation — and
it is *worse* than the 4B on Danish wrong words. See
[Quality benchmark](#quality-benchmark).

### External API Support

- **External Betty** — Connect to DeepSeek (or any OpenAI-compatible endpoint) via a local API key stored on your machine. No key leaves your device. Select "External Betty" as the model in the wizard to bypass local inference and use cloud-hosted models instead.

- **Betty in the Cloud** — For a machine that cannot run a local model and a user who does not want to obtain an API key. Pay per job through Stripe; the manuscript is processed by Bethaniel's hosted service and the credential the app stores afterwards is a scoped, prepaid token for that service, never a provider key. A pre-run estimate (`POST /api/cloud/estimate`) prices the job before any money moves, and a per-credential ledger hard-caps total spend. The cloud path reuses the same `"api"` plumbing as External Betty — the editing pipeline itself is identical. See [`worker/README.md`](worker/README.md) for the deployable side and [`docs/cloud-terms.html`](docs/cloud-terms.html) for the terms.

### Multi-Agent Orchestration

- **One editor pass, by measurement** — the pipeline supports 2–4 parallel editor passes per chunk, union-deduplicated for broader coverage, and every run ships with **one**. A heavier preset (3 editors, 2 reviewers, a thorough second pass) was built and benchmarked: it gained +48% applied corrections on a strong API model and *nothing* on either bundled local model, at 2–3× the wall clock. It was removed rather than kept as a trap. The knobs remain in Advanced Settings for anyone who wants to hand-tune them. See [`docs/run-modes.md`](docs/run-modes.md). Failed agents are retried automatically.

- **Reviewer agents** — A skeptical second-reader LLM scores every proposed correction on a 1–5 confidence scale. With multiple reviewer agents, the strictest score wins. Corrections scoring below a configurable threshold are flagged and hidden by default. Reviewers run in parallel with the next chunk's editor to hide latency.

- **Translation review-and-revise** — After translating a chunk, the text is split into paragraphs. Each source→translated paragraph pair is scored by a translation-quality reviewer. Any paragraph flagged as garbled or nonsensical is re-translated with added context about the issue.

### Deterministic Copy-Edit Checks

Alongside the LLM editors, several deterministic passes run per chunk and merge into the same correction set. Each still goes through the reviewer, and a fix that both a deterministic checker and an LLM editor produce identically is auto-applied (cross-source pre-approval):

- **Exhaustive spell-check** — real [Hunspell](https://hunspell.github.io), compiled to WebAssembly (`hunspell-asm`), reading the upstream `.aff`/`.dic` pairs unmodified. It flags every out-of-dictionary word — including capitalized typos at the start of a sentence — with no per-chunk cap, while protecting proper nouns and style-sheet names. Detected words are also fed to the LLM editor as hints, so it corrects them in context (more reliable than Hunspell's own top suggestion).

  Using the real engine rather than a reimplementation is what makes the compounding languages work: Danish `rådhusarkivet` and German `Werkstattfenster` are composed from their parts through `COMPOUNDRULE` instead of read as misspellings, and a novel in either language is full of them. It also removed two bugs that each showed up in exactly one language — 26,232 Danish entries lost to unstripped morphological tags, and 87,955 German lowercase words lost to a case collision with their capitalized noun twins.

- **Confusable word pairs** — real words the dictionary can never catch, injected into the editor prompt only when both members of a pair appear nearby. 59 sets for English (`their`/`there`, `lay`/`lie`), 18 for Danish (`nogen`/`nogle`, `ad`/`af`), 18 for German (`das`/`dass`, `seit`/`seid`), 24 for Spanish — mostly dropped-accent pairs (`si`/`sí`, `el`/`él`) plus homophones (`haber`/`a ver`, `tuvo`/`tubo`).

- **retext prose checks** — deterministic English rules for `a`/`an`, missing contraction apostrophes, doubled words, redundant acronyms ("PIN number" → "PIN"), and sentence spacing. English only; the other languages skip this pass rather than run English rules against them.

- **LanguageTool grammar & punctuation** — a local [LanguageTool](https://languagetool.org) 6.6 server catches deeper grammar and punctuation issues in all four languages, running fully offline at the `picky` rule level. Released installers bundle it (a pinned LanguageTool + a matching Temurin JRE, fetched at build time by `scripts/build.mjs`), so no system Java is required; it degrades to a no-op if absent. Pass `--skip-languagetool` for a lean dev build. See [`electron/resources/languagetool/HOWTO.md`](electron/resources/languagetool/HOWTO.md).

  A short ledger of rules is disabled outright in `languageTool.ts`, each with the measurement that put it there. The bar for disabling one is *zero real errors found, at least one invented* — LanguageTool corrections bypass reviewer scoring, so nothing downstream restrains a rule that misfires. The Spanish `COMILLAS_TIPOGRAFICAS` rule, which rewrote every straight quote to an angle quote, was flagging 248 times across the benchmark corpus and never once on a planted error; removing it moved Spanish copy-edit precision from 31% to 67%.

- **Quotation-mark repair** — deterministic, because the model does not reliably see the difference between an opening and a closing mark. Owns quotation marks outright, which is why LanguageTool is not allowed to.

- **Dialect normalization** — British ↔ American spelling, applied deterministically once the author has named the dialect.

- **Comma-style toggles** — comma conventions differ by language and are house style rather than error, so the author states the convention and only then is it enforced. English: Oxford comma (on by default) and introductory comma (off by default — "Finally she turned" is left as the author wrote it). Danish: *grammatisk komma* vs *nyt komma*, both sanctioned by Retskrivningsordbogen and mutually contradictory, so guessing would be wrong half the time. Spanish: the RAE conventions are stated as prompt directives. Every toggle governs the LLM editor and LanguageTool together.

### Analysis Features

- **Timeline zoom** — Three-level toggle (Major / Medium / All) filters timeline events by significance based on description length and time references. Major events appear by default; click to expand.

- **Key/minor split** — Characters and locations appearing in ≥2 chapters are shown as "key" by default. Single-chapter entries are collapsed under a "minor" toggle.

- **Prose summary + Blurb** — After analysis completes, a ~400-word Markdown prose summary and a ~150-word marketing blurb are auto-generated from the merged character/location/timeline data. Regeneration buttons are available at the job level.

- **Character identity dedup** — Three-level approach for merging duplicate character entries (e.g. "Aaron's mom" + "Bria's mother" + "Kathrine" recognized as one person):
  1. Heuristic merge rules (family-term normalization, alias overlap, chapter-list matching)
  2. Prompt-level dedup instructions baked into the analysis system prompt
  3. Opt-in LLM-powered identity resolution (toggle in Advanced Settings — sends candidate pairs to the model for yes/no verification)

### Wizard-Guided UX

Progressive disclosure across five steps: **Model** → **Modes** → **Upload** → **Style** → **Run**. All settings persist across sessions via local storage. Completed jobs remain accessible for review, correction accept/dismiss, Markdown/DOCX export, and retry.

## Language Support & Quality

Bethaniel copy-edits **English, Danish, German and Spanish** with the full
deterministic stack behind the model; other languages get the LLM editors and
whatever of the stack applies. Translation targets any language.

| | English | Danish | German | Spanish |
| --- | :---: | :---: | :---: | :---: |
| Hunspell dictionary | en_US + en_GB | da_DK | de_DE | es_ES |
| Compound-word support | — | ✅ | ✅ | — |
| Confusable word sets | 59 | 18 | 18 | 24 |
| LanguageTool rules | ✅ | ✅ | ✅ | ✅ |
| retext prose checks | ✅ | — | — | — |
| Comma-convention toggle | Oxford, introductory | grammatisk / nyt | — | RAE directives |
| Dialect normalization | British ↔ American | — | — | — |

The dictionaries are the current upstream releases: German is
hunspell-de_DE_frami byte-for-byte, Danish is Stavekontrolden 2.9.101, and
English and Spanish match their upstream entry counts. There is no dictionary
upgrade available in any of the four, which was worth establishing — it moves
the question from "get better data" to "use the data correctly", and that is
where the last several fixes came from.

### Quality benchmark

`scripts/test-models.ts` runs both bundled models over paired fixtures — a
clean text and the same text with ~100 errors planted at known offsets — and
scores what came back. `scripts/plant-errors.ts` builds the errored half from a
per-language plan and refuses any edit that does not add exactly one span of
the intended category, so the ground truth is constructed rather than
annotated. Fixtures live in `sample_texts/`; results land in
`sample_texts/benchmark_results.json`.

Three things are measured, because the three editing modes fail differently:

- **Copy edit** — recall and precision against the planted errors, broken out
  by category (misspelling, wrong word, comma, capitalization, duplicated
  word), plus false positives on the clean text. A copy editor that invents
  corrections is worse than one that misses them, so the clean-text column is
  read first.
- **Line edit** — recall and precision against planted style errors, the same
  way, though the ask is softer: there is no ground truth for "better prose".
  A reference-free quality score in the shape of the Scribendi Score is
  implemented in `lineEditQuality.ts` — an edit counts as an improvement only
  if it lowers the perplexity of the passage *and* stays close enough to the
  original by Levenshtein and token-sort ratio not to be a rewrite, with
  perplexity from the bundled `llama-perplexity` so it too runs offline. It is
  unit-tested but not yet driven by the benchmark harness; the line-edit rows
  in `benchmark_results.txt` are still the planted-error scores.
- **Translation** — chrF against a human reference translation, plus
  length-ratio and source-leakage checks (`translationQuality.ts`).
  `scripts/test-translation.ts` runs it against the parallel corpus in
  `sample_texts/translation_*.md`.

Current per-language results, what they mean, and what is being worked on next
are in [`docs/language-quality-roadmap.md`](docs/language-quality-roadmap.md).

## First-Time Install

```bash
./install.sh
```

This will:

1. Check for Node.js (≥ 20) and Pandoc (and offer to install them via Homebrew on macOS)
2. Install JavaScript dependencies for the frontend and backend
3. Build the React frontend
4. Compile the TypeScript backend

## Run

### Desktop App (Electron)

Build the desktop application:

```bash
npm run dist          # build for current OS
npm run dist:mac      # macOS .dmg + .zip (arm64 + x64)
npm run dist:win      # Windows .exe (NSIS installer)
npm run dist:linux    # Linux .AppImage + .deb
```

Output lands in `dist/`. The first time you launch, Bethaniel detects your
hardware and recommends one of the models listed under
[Models](#models) — or, if the machine cannot run either local model,
Betty in the Cloud.

### Browser Mode (developer / power-user)

```bash
./bethaniel
```

This starts the server on `http://localhost:4000` and opens your browser.
Requires a GGUF model in the `backend/models/` directory.

### Development Mode

```bash
npm run dev
# or
./bethaniel --dev
```

Runs the Vite dev server on `http://localhost:5173` (with hot reload) and the
backend with `nodemon` on `http://localhost:4000`.

## CLI (`betty`)

`betty` runs the full editing pipeline headlessly — no Electron, no server. It
reads a manuscript, runs one or more modes against a model, **automatically
keeps every change the reviewer agent accepted** (low-confidence changes are
dropped, exactly like the app's review pane), and writes one or more export
formats. Don't run it while the desktop app is open — both compete for the
llama-server port.

```bash
# From the repo root:
npm run betty -- --model Baby-betty --mode copy line \
  --input-doc book.docx --export-format docx md
```

### Flags

| Flag                   | Required          | Notes                                                                                   |
| ---------------------- | ----------------- | --------------------------------------------------------------------------------------- |
| `--model <name>`       | yes               | Friendly name (`Baby Betty`), tier (`small`), id (`qwen3.5-4b`), gguf filename, or `custom:<id>` (case/space/hyphen-insensitive) |
| `--mode <mode>...`     | yes               | One or more of `copy line analysis translation` (space- or comma-separated). `copy`+`line` merge into one combined edit |
| `--input-doc <path>`   | yes               | `.docx`, `.md`, or `.txt`                                                                |
| `--export-format <f>...`| yes              | One or more of `docx md epub`                                                            |
| `--language <lang>`    | for `translation` | Target language                                                                         |
| `--style-guide <path>` | no                | Style-guide text file applied to the run                                                 |
| `--out-dir <dir>`      | no                | Output directory (default: the input file's directory)                                   |
| `--data-dir <dir>`     | no                | Data dir with `api-config.json` / the SQLite db (default: the desktop app's data dir)    |
| `--api-key <key>`      | for External Betty (first run) | API key for External Betty; saved to the data dir so later runs don't need it  |
| `--no-review`          | no                | Disable the reviewer (keep all editor changes)                                           |
| `-h, --help`           | no                | Show full help                                                                           |

Each mode writes its own file named `<input>.<label>.<ext>` — labels are
`edit` (copy+line), `copy`, `line`, `analysis` (synthesized summary), and
`translation`. So the example above produces `book.edit.docx` and
`book.edit.md`.

### More examples

```bash
# Translate to Spanish, export EPUB
npm run betty -- --model Big-bad-betty --mode translation --language Spanish \
  --input-doc book.md --export-format epub

# Character/location/timeline analysis summary, export DOCX
npm run betty -- --model Basic-betty --mode analysis \
  --input-doc book.docx --export-format docx

# External Betty (DeepSeek API) — first run saves the key for next time
npm run betty -- --model "External Betty" --api-key sk-... --mode copy \
  --input-doc book.docx --export-format md
```

### External Betty (API models)

API models read their key from `api-config.json` in the data dir. The CLI looks
for it in the desktop app's data dir first, then the repo's `backend/data`, so
if you've configured External Betty in the app (or the dev server) it works
without extra flags. Otherwise pass `--api-key` once (it's saved) or point
`--data-dir` at a folder that has an `api-config.json`.

> **Tip:** `npm run betty` runs from the `backend/` workspace, so relative
> `--input-doc`/`--out-dir` paths resolve from there. Use absolute paths, or
> install `betty` on your PATH (below) — the launcher runs from your current
> directory.

### Installing `betty` on your PATH (optional)

```bash
cd backend
npm run install:betty      # npm link → global `betty` command
betty --model Baby-betty --mode copy --input-doc book.md -f md   # from anywhere
npm run uninstall:betty    # remove it later
```

You can also call the launcher directly without installing:
`./backend/betty --help`.

## Configuration

| Env variable     | Default        | Notes                         |
| ---------------- | -------------- | ----------------------------- |
| `BETHANIEL_PORT` | `4000`         | Port for the unified server   |
| `LLAMA_BASE_URL` | _(empty)_      | llama-server URL (Electron)   |
| `LLAMA_BIN`      | `llama-server` | Path to llama-server binary   |
| `MODELS_DIR`     | `./models`     | GGUF model storage            |
| `DATA_DIR`       | `./data`       | SQLite + uploaded manuscripts |

## Distributing to Customers

### Option A: Electron Installer (recommended)

Build with `npm run dist`, then distribute the `.dmg` / `.exe` / `.AppImage`.
Users get a native desktop app — no terminal, no Ollama, no manual steps.

### Option B: Developer Install

```bash
git clone <this repo>
cd Bethaniel
./install.sh
./bethaniel
```

Requires Node.js ≥ 20 and Pandoc.

---

## License & Rights of Use

**Bethaniel** is provided under a custom source-available license. Please read the terms below carefully.

### Free Use

You may use Bethaniel **free of charge** if you meet **all** of the following conditions:

1. **Personal / non-commercial use** — any individual using Bethaniel for their own manuscripts, hobby projects, or personal editing needs; **OR**
2. **Small-business commercial use** — a company, team, or sole trader where:
   - The organization has **fewer than 5** employees, contractors, consultants, or regular users; **AND**
   - The organization's annual gross revenue is **less than USD $1,000,000**.

### Commercial License Required

If your organization does **not** meet both of the criteria above (i.e. 5+ people or ≥ $1 M revenue), you must obtain a commercial license before using Bethaniel. Please contact:

📧 **simon@bethaniel.eu**

### Restrictions

Regardless of whether you qualify for free use:

1. **No redistribution** — You may not redistribute, sublicense, sell, or share the Bethaniel source code or compiled binaries to third parties.
2. **No modification** — You may not fork, modify, adapt, or create derivative works of Bethaniel for your own commercial product or service without prior written permission.
3. **No reverse engineering of prompts** — The prompt engineering, system prompts, and editing logic are proprietary. You may not extract them for use in other products.

### Attribution

Attribution is **encouraged but not required**. If Bethaniel helped you ship your book or edit your manuscript, a mention is always appreciated — but you're under no obligation.

### No Warranty

Bethaniel is provided "AS IS", without warranty of any kind, express or implied. The author(s) are not liable for any damages arising from the use of this software.

### AI Model Licenses

The AI models used by Bethaniel (Qwen3.5 4B and Qwen3.5 9B) are open-weight models distributed under the **Apache License 2.0** by their respective authors. Full provenance details, copyright notices, and the complete license text are provided in [MODEL_LICENSES.md](MODEL_LICENSES.md).

### Third-Party Components

- **LanguageTool** (optional grammar/punctuation server) is open source under the **LGPL 2.1**. It is free to bundle and run locally — including in a commercial distribution — at no cost; the paid LanguageTool **Premium/API** service is separate and is **not** used. If you ship LanguageTool with Bethaniel, comply with the LGPL: include its license text and copyright notices, link to the LanguageTool source, and allow users to replace the library. Some bundled language dictionaries carry their own licenses — see the distribution's `third-party-licenses/` folder. (This is a summary, not legal advice.)
- **Hunspell** is used for spell-checking, via `hunspell-asm` (Hunspell compiled to WebAssembly). Hunspell itself is tri-licensed **GPL/LGPL/MPL**; the WebAssembly wrapper is MIT. Bethaniel loads it as a library and ships the dictionaries unmodified.
- **Hunspell dictionaries** retain their upstream licenses, which differ per language and are stated in each dictionary's own `.aff` header: `da_DK` is Stavekontrolden 2.9.101 (GPL 2.0 / LGPL 2.1 / MPL 1.1 tri-license), `de_DE` is hunspell-de_DE_frami, derived from igerman98 (GPLv2 / GPLv3), `en_GB` is released under the LGPL, and `en_US` and `es_ES` carry no license line in the files themselves — check upstream before redistributing. Ship the headers with the dictionaries.
- **retext** and its plugins are MIT-licensed, and are used for the deterministic English prose checks.

---

_© 2025–2026 Bethaniel. All rights reserved._
