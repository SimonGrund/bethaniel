#!/usr/bin/env bash
# launch_ui.sh — start the Streamlit UI in your browser.

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
VENV_DIR="$PROJECT_DIR/.venv"

# Pick a system Python.
if command -v python3 >/dev/null 2>&1; then
  SYS_PY=python3
elif command -v python >/dev/null 2>&1; then
  SYS_PY=python
else
  echo "Error: no python3 found. Install with: brew install python" >&2
  exit 1
fi

# Create venv if it doesn't exist.
if [[ ! -d "$VENV_DIR" ]]; then
  echo "Creating virtual environment at $VENV_DIR ..."
  "$SYS_PY" -m venv "$VENV_DIR"
fi

# Activate it.
source "$VENV_DIR/bin/activate"

# Install deps if missing.
pip install --quiet --upgrade pip
pip install --quiet streamlit ollama

exec streamlit run "$SCRIPT_DIR/ui.py"
