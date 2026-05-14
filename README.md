# 📖 Bethaniel — Private Copy Editor

A fully local, offline-capable AI copy editor for pre-print manuscripts.
Powered by [Ollama](https://ollama.com/) running entirely on your machine —
no internet, no cloud, no data leaves your computer.

## Architecture

A single Node.js process serves both the API and the React UI.

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
│  Ollama (http://127.0.0.1:11434)        │
│  ──> Local LLM inference                │
└─────────────────────────────────────────┘
```

## First-Time Install

```bash
./install.sh
```

This will:

1. Check for Node.js (≥ 20), Pandoc, and Ollama (and offer to install them via Homebrew on macOS)
2. Install JavaScript dependencies for the frontend and backend
3. Build the React frontend
4. Compile the TypeScript backend

After installing, pull an Ollama model:

```bash
ollama pull llama3.1
```

## Run

```bash
./bethaniel
```

This starts the server on `http://localhost:4000` and opens your browser.

### Development Mode

```bash
./bethaniel --dev
```

Runs the Vite dev server on `http://localhost:5173` (with hot reload) and the
backend with `nodemon` on `http://localhost:4000`.

## Configuration

| Env variable     | Default                  | Notes                         |
| ---------------- | ------------------------ | ----------------------------- |
| `BETHANIEL_PORT` | `4000`                   | Port for the unified server   |
| `OLLAMA_HOST`    | `http://127.0.0.1:11434` | Ollama API URL                |
| `DATA_DIR`       | `./data`                 | SQLite + uploaded manuscripts |
| `RESULTS_DIR`    | `./results`              | Edit results on disk          |

## Distributing to Customers

The folder is self-contained. To install on a new machine:

```bash
git clone <this repo>
cd Bethaniel
./install.sh
./bethaniel
```

A future packaging step will wrap this as a double-clickable `.app` (Electron).
