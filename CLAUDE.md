# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
npm run dev           # Start all three processes concurrently (Vite :5173, Express :4000, Electron)
```

### Build
```bash
npm run build:all     # Frontend → wire → backend → electron TypeScript (in that order)
npm run build:frontend
npm run build:backend   # tsc in backend/
npm run build:electron  # tsc -p electron/tsconfig.json
```

### Package & distribute
```bash
npm run dist          # Build installers for current OS
npm run dist:mac      # macOS .dmg + .zip (arm64 + x64)
npm run dist:win      # Windows NSIS .exe
npm run dist:linux    # Linux .AppImage + .deb
npm run release       # Build + publish (electron-builder --publish always)
```

### Backend dev (standalone)
```bash
# In backend/
npm run dev    # tsx src/index.ts — NO file watching; restart manually to pick up changes
npm run build  # tsc
```

### Frontend dev (standalone)
```bash
# In frontend/
npm run dev    # vite --host 0.0.0.0 on :5173
npm run build  # tsc -b && vite build
```

### Tests
```bash
# In backend/
npm test   # node:test via the tsx loader (test/**/*.test.ts) — no extra deps
```

The automated tests cover the copy/line-edit correction pipeline
(`backend/test/` — apply/spell/word-boundary safeguards, quote hygiene &
export auto-repair, reviewer retry/aggregation, second-pass merge). The
frontend has no automated tests.

## Architecture

Bethaniel is an Electron desktop app that bundles a fully local AI copy-editor. Everything runs offline — no data leaves the user's machine.

### Process topology

```
Electron (electron/main.ts)
  └── forks → Node.js Express server (backend/src/index.ts)
                 ├── REST API at /api
                 ├── Socket.IO at /socket.io  (real-time queue updates & logs)
                 ├── Static React frontend served at /
                 └── spawns → llama-server child process (bundled GGUF runner)
```

In development, Vite runs separately on :5173; the backend on :4000 still serves the API. The frontend talks to `VITE_API_URL` (defaults to same-origin, so `:4000` in prod).

### Backend (`backend/src/`)

| File | Responsibility |
|---|---|
| `index.ts` | Express + Socket.IO setup, graceful shutdown |
| `routes.ts` | All REST endpoints (`/api/*`), model download manager |
| `queue.ts` | In-memory task queue, concurrency control, per-chunk LLM orchestration |
| `llm.ts` | OpenAI-compatible client wrapping llama-server; streaming SSE parser |
| `llamaServer.ts` | llama-server process supervisor (spawn, health-poll, hot-swap models) |
| `modelCatalog.ts` | Single source of truth for all models (tiers, URLs, defaults). Edit here to add/change models. |
| `modelConfig.ts` | Per-model JSON sidecars (user overrides layered on top of catalog defaults) |
| `db.ts` | better-sqlite3 — documents, style guides, completed task states |
| `prompts.ts` | All LLM system prompts (copy-edit, line-edit, analysis, review, translation) |
| `chunking.ts` | Split manuscript into word-count chunks with paragraph overlap |
| `analysisMerge.ts` | Merge per-chapter analysis results (characters, locations, timeline) across chunks |
| `chapters.ts` | Detect chapter headings, split manuscript into `EditUnit[]` |
| `conversion.ts` | DOCX ↔ Markdown (mammoth for import, html-to-docx for export) |
| `diff.ts` | Word-level diff → inline HTML; extract corrections from rewrites |
| `consistency.ts` | Heuristic name/hyphen consistency checks (no LLM) |
| `spellcheck.ts` | nspell wrapper for pre-LLM spell check |
| `logBus.ts` | Ring-buffer log bus — broadcasts engine messages to Socket.IO |
| `sceneBreaks.ts` | Detect and normalize scene-break markers on upload |

### Frontend (`frontend/src/`)

**State**: single Zustand store (`store.ts`) with `persist` middleware — all wizard settings, model selection, and edit options survive page refresh. Transient data (tasks, logs, document text) is not persisted.

**Wizard flow** (controlled by `wizardStep` in store):
`model` → `edits` → `upload` → `style` → `run` → `done` → `folded`

Key components map 1-to-1 to wizard steps:
- `ModelSelector` — hardware detection, catalog, model download/install
- `ModeSelector` — task mode selection (copy edit / line edit / analysis / translate)
- `ManuscriptUpload` — DOCX/MD upload, chapter detection, scope selection
- `StyleGuideEditor` — optional style guide upload or text entry
- `EditTrigger` — launch jobs, chapter scoping, advanced settings
- `ReviewExport` — correction accept/dismiss, diff view, Markdown/DOCX export
- `BettyWorking` — live queue progress view
- `QueuePanel` / `LogPanel` / `EngineStatus` — sidebar panels

**Real-time**: `socket.ts` connects Socket.IO; the store updates `tasks` and `logs` on `queue:update` / `log:snapshot` / `log:append` events.

**API calls**: `api.ts` — thin fetch wrappers for all backend endpoints.

### Task/job model

- A **job** is one "run" submission (one `/api/queue/add` call, one `jobId`).
- A **task** is one chapter × one mode (e.g. "Chapter 3" under "copy_edit").
- Tasks are split into **chunks** (~2500 words each with 1-paragraph overlap).
- Per chunk: dual editor agents run in parallel → corrections union-deduped → reviewer agents score each correction → low-confidence corrections flagged.
- Analysis tasks (character, location, timeline) merge per-chunk JSON across all chapters via `analysisMerge.ts`.
- When copy_edit + line_edit are both selected they merge into `combined_edit`. Multiple analysis modes merge into `combined_analysis`.

### Model sources

Models are identified by `source` in `modelCatalog.ts`:
- `"gguf"` — downloaded from HuggingFace to `MODELS_DIR`, loaded by bundled llama-server
- `"ollama"` — pulled via local Ollama API
- `"api"` — External Betty: OpenAI-compatible API (DeepSeek default), key stored locally in `modelConfig.ts`
- `"custom_gguf"` — user-provided GGUF file path

### Electron packaging

`electron/main.ts` forks the compiled backend at a random free port, sets `LLAMA_BASE_URL` so the backend knows how to reach llama-server (managed by the backend's own supervisor), and opens a BrowserWindow at the backend URL. `electron-builder.yml` configures platform targets. The bundled `llama-server` binary lives under `electron/resources/llama/<platform-arch>/`.

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `BETHANIEL_PORT` | `4000` | Backend port |
| `LLAMA_BASE_URL` | _(empty)_ | Set by Electron main to reach llama-server |
| `LLAMA_BIN` | `llama-server` | Path override for the llama-server binary |
| `MODELS_DIR` | `./models` | GGUF model storage |
| `DATA_DIR` | `./data` | SQLite DB + uploaded manuscripts |
| `RESULTS_DIR` | `./results` | Edit results on disk |
| `BETHANIEL_FAKE_RAM_GB` | — | Dev override for hardware tier detection |

### Adding or changing models

Edit `backend/src/modelCatalog.ts` — specifically the `MODEL_CATALOG` array and `BASE_SYSTEM_PROMPT`. No other file needs to change; defaults flow from `ModelCatalogEntry.defaults` and user overrides are layered on top via per-model JSON sidecars.
