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
| Baby Betty    | Qwen3.5 4B (Q4_K_M)            | ~3 GB  | 8 GB                           |
| Basic Betty   | Qwen3.5 9B (Q4_K_M)            | ~6 GB  | 16 GB (12 GB on Apple Silicon) |
| Big Bad Betty | Mistral Small 3.2 24B (Q4_K_M) | ~14 GB | 24 GB (16 GB on Apple Silicon) |

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

The AI models used by Bethaniel (Qwen3.5 4B, Qwen3.5 9B, and Mistral Small 3.2 24B) are open-weight models distributed under the **Apache License 2.0** by their respective authors. Full provenance details, copyright notices, and the complete license text are provided in [MODEL_LICENSES.md](MODEL_LICENSES.md).

---

_© 2025–2026 Bethaniel. All rights reserved._
