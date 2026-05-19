# 📖 Bethaniel — Private Copy Editor

A fully local, offline-capable AI copy editor for pre-print manuscripts.
Powered by a bundled [llama.cpp](https://github.com/ggml-org/llama.cpp) inference engine running entirely on your machine —
no internet, no cloud, no data leaves your computer.

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
hardware and lets you download the right model:

| Tier          | Model                          | Size   | Min RAM                        |
| ------------- | ------------------------------ | ------ | ------------------------------ |
| Baby Betty    | Gemma 3n E4B (Q4_K_M)          | ~3 GB  | 8 GB                           |
| Basic Betty   | Mistral Small 3.2 24B (Q4_K_M) | ~14 GB | 24 GB (16 GB on Apple Silicon) |
| Big Bad Betty | Qwen3 32B (Q4_K_M)             | ~20 GB | 32 GB (24 GB on Apple Silicon) |

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

## Configuration

| Env variable     | Default        | Notes                         |
| ---------------- | -------------- | ----------------------------- |
| `BETHANIEL_PORT` | `4000`         | Port for the unified server   |
| `LLAMA_BASE_URL` | _(empty)_      | llama-server URL (Electron)   |
| `LLAMA_BIN`      | `llama-server` | Path to llama-server binary   |
| `MODELS_DIR`     | `./models`     | GGUF model storage            |
| `DATA_DIR`       | `./data`       | SQLite + uploaded manuscripts |
| `RESULTS_DIR`    | `./results`    | Edit results on disk          |

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
