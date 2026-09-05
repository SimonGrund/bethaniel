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
| `enginePort.ts` | Picks the port the engine (and LanguageTool) listens on. Keeps it out of the OS ephemeral range, which the kernel hands to any process at any time, and recognises a lost bind race so the caller can retry elsewhere |
| `modelCatalog.ts` | Single source of truth for all models (tiers, URLs, defaults). Edit here to add/change models. |
| `modelConfig.ts` | Per-model JSON sidecars (user overrides layered on top of catalog defaults) |
| `db.ts` | better-sqlite3 — documents, style guides, completed task states |
| `prompts.ts` | All LLM system prompts (copy-edit, line-edit, analysis, review, translation) |
| `chunking.ts` | Split manuscript into word-count chunks with paragraph overlap |
| `translationUpgrade.ts` | Post-translation target-language polish pass + fluency review loop (stages 3–4 of translate mode) |
| `analysisMerge.ts` | Merge per-chapter analysis results (characters, locations, timeline) across chunks |
| `chapters.ts` | Detect chapter headings, split manuscript into `EditUnit[]`; folds sub-50-word sections (title pages, stray headings) into the chapter they belong to |
| `pdfToMarkdown.ts` | PDF → Markdown via pdfjs — reconstructs paragraphs, emphasis and headings from glyph geometry. Import only; refuses scans |
| `conversion.ts` | DOCX ↔ Markdown (mammoth for import, `mdToDocx.ts` for export) |
| `mdBlocks.ts` | Markdown → block structure, shared by the DOCX and EPUB/HTML paths so they cannot drift |
| `mdToDocx.ts` | Markdown → DOCX, built programmatically on the `docx` library (replaced html-to-docx) |
| `imageDimensions.ts` | Pixel dimensions from PNG/JPEG/GIF/WEBP headers. Deliberately does **not** parse ICNS/JXL/HEIF — the two `image-size` advisories were unbounded loops in exactly those parsers |
| `diff.ts` | Word-level diff → inline HTML; extract corrections from rewrites |
| `consistency.ts` | Heuristic name/hyphen consistency checks (no LLM) |
| `spellcheck.ts` | nspell wrapper — exhaustive spell detection + suspect hints for the editor |
| `retextChecks.ts` | Deterministic retext prose checks (a/an, contractions, doubled words, redundant acronyms, sentence spacing); English-only |
| `languageTool.ts` | LanguageTool client — POST `/v2/check`, map matches → corrections (pure parser + network call) |
| `languageToolServer.ts` | LanguageTool Java server supervisor (spawn/health/shutdown); degrades to no-op when the jar/Java is absent |
| `logBus.ts` | Ring-buffer log bus — broadcasts engine messages to Socket.IO |
| `sceneBreaks.ts` | Detect and normalize scene-break markers on upload |
| `storage.ts` | Disk usage accounting + purge (models / documents / settings); backs `/api/storage/*`, the "Storage & data" panel and the uninstall flow |

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
- `"api"` — an external OpenAI-compatible API. `api-config.json` (`modelConfig.ts`) is keyed by catalog entry id so multiple `"api"` providers can be configured at once (e.g. "External Betty" = the user's own DeepSeek key, "Betty in the Cloud" = a Bethaniel-issued credential) without colliding. `llm.ts`'s `chatStream` resolves each entry's base URL from `apiConfig.baseUrl` (per-install override) → `entry.defaultBaseUrl` → the legacy `DEEPSEEK_API_BASE` env fallback.
- `"custom_gguf"` — user-provided GGUF file path

### Betty in the Cloud (pay-per-job cloud processing)

The `"bethaniel-cloud"` catalog entry lets a user pay Bethaniel (markup over token cost) to run one job against OVHcloud AI Endpoints (Qwen3.5-397B-A17B) instead of locally or via their own key — no local hardware or BYO API key required. It reuses the `"api"` source's existing plumbing end-to-end; nothing in `queue.ts`/`llm.ts`'s core pipeline needed to change.

- `backend/src/cloudEstimate.ts` — pre-run token/cost estimator (`estimateCloudJob`), built on `llm.ts`'s `estimateTokens` heuristic and the real prompt builders in `prompts.ts`. Mirrors `routes.ts`'s `/queue/add` mode-merge logic (copy_edit+line_edit → combined_edit; any analysis mode selection → one combined_analysis task) so it never double-counts work the real job doesn't do.
- `POST /api/cloud/estimate` and `POST /api/cloud/checkout` (`routes.ts`) — compute the estimate and proxy to the Cloudflare Worker's `/v1/quote` / `/v1/checkout`, keeping the Worker URL out of the renderer.
- `worker/` — a **separate deployable package** (own `package.json`/`wrangler.toml`, not part of the root npm workspaces) implementing the Worker: Stripe Checkout, a per-credential Durable Object ledger (`worker/src/ledger.ts`) that hard-caps total exposure via reserve/commit/release, and a metering proxy in front of OVHcloud AI Endpoints that returns a 402 on budget exhaustion — which `llm.ts`'s existing `ApiAccountError` already surfaces gracefully. See `worker/README.md` for deployment.
- `electron/main.ts` registers `bethaniel://` and handles the paid-credential handoff (`claimCloudCredential`) once the Worker's hosted success page redirects there after a completed Stripe Checkout; the app's own `PUT /api/models/custom/config` (now `entryId`-aware) saves it exactly like an External Betty key.

### Electron packaging

`electron/main.ts` forks the compiled backend at a random free port, sets `LLAMA_BASE_URL` so the backend knows how to reach llama-server (managed by the backend's own supervisor), and opens a BrowserWindow at the backend URL. `electron-builder.yml` configures platform targets. The bundled `llama-server` binary lives under `electron/resources/llama/<platform-arch>/`.

### Uninstall & user data

All runtime data lives under `app.getPath("userData")` — `~/Library/Application Support/Bethaniel` (macOS), `%APPDATA%\Bethaniel` (Windows), `~/.config/Bethaniel` (Linux) — with `data/` and `models/` subdirs. Downloaded GGUFs make this large: a full catalog exceeds 20 GB.

Uninstalling never removes it silently. Each platform asks first:

- **Windows** — `build/installer.nsh` defines `customUnInstall`, which prompts and then `RMDir /r`s the app-data dir. `deleteAppDataOnUninstall` stays `false` so this macro owns the decision. **The `${isUpdated}` / `${Silent}` guard is load-bearing**: with `oneClick: true` the auto-updater runs this same uninstaller silently on every update, so without it a routine version bump would wipe the user's models.
- **macOS / Linux** — the OS gives no usable hook (drag-to-Trash has none; deb `postrm` runs as root and non-interactively). The **Uninstall Bethaniel…** menu item in `electron/main.ts` covers both: it prompts with a checkbox, deletes the userData dirs, and on macOS trashes the app bundle. `build/deb-postrm.sh` only prints where the data lives.

`StorageSettings.tsx` (opened from the sidebar) is the in-app equivalent, available on every platform.

### Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | Backend port |
| `LLAMA_BASE_URL` | _(empty)_ | Point at an external llama-server. Ignored once the backend has launched an engine of its own — that engine's actual port is the only truth |
| `LLAMA_BIN` | `llama-server` | Path override for the llama-server binary |
| `MODELS_DIR` | `./models` | GGUF model storage |
| `DATA_DIR` | `./data` | SQLite DB + uploaded manuscripts |
| `LANGUAGETOOL_JAR` | _(empty)_ | Path to `languagetool-server.jar`; set by Electron main when bundled. Absent → grammar checks skipped |
| `JAVA_BIN` | `java` | Path to a Java runtime (bundled JRE preferred) |
| `LANGUAGETOOL_PORT` | `8081` | Preferred LanguageTool port; the server moves to a free one if it is taken |
| `LANGUAGETOOL_BASE_URL` | _(empty)_ | Point at an external LanguageTool server and skip spawning one |
| `LANGUAGETOOL_DISABLED` | _(empty)_ | Set to `1` to force grammar checks off globally, even if a distribution is bundled |
| `BETHANIEL_FAKE_RAM_GB` | — | Dev override for hardware tier detection |

### Adding or changing models

Edit `backend/src/modelCatalog.ts` — specifically the `MODEL_CATALOG` array and `BASE_SYSTEM_PROMPT`. No other file needs to change; defaults flow from `ModelCatalogEntry.defaults` and user overrides are layered on top via per-model JSON sidecars.
