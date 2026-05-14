#!/usr/bin/env bash
# ── Bethaniel — One-time installer ──
# Checks for system prerequisites and offers to install missing ones.
# Then installs npm dependencies and builds the frontend.
#
# Usage: ./install.sh

set -euo pipefail
cd "$(dirname "$0")"

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
err()   { echo -e "${RED}[✗]${NC} $1"; }
info()  { echo -e "[*] $1"; }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📖 Bethaniel — Installer"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

OS="$(uname -s)"
HAS_BREW=false
if command -v brew > /dev/null 2>&1; then
  HAS_BREW=true
fi

check_or_install() {
  local name="$1"
  local check_cmd="$2"
  local brew_pkg="$3"
  local manual_url="$4"

  if eval "$check_cmd" > /dev/null 2>&1; then
    ok "$name installed"
    return 0
  fi

  warn "$name not found"
  if [ "$OS" = "Darwin" ] && [ "$HAS_BREW" = true ]; then
    read -p "    Install $name via Homebrew? [Y/n] " ans
    ans=${ans:-Y}
    if [[ "$ans" =~ ^[Yy] ]]; then
      brew install "$brew_pkg"
      ok "$name installed"
      return 0
    fi
  fi
  err "Please install $name manually: $manual_url"
  return 1
}

# ── 1. System prerequisites ──
info "Checking system prerequisites..."
echo ""

MISSING=0
check_or_install "Node.js (≥ 20)" \
  "node --version | grep -qE 'v(2[0-9]|[3-9][0-9])'" \
  "node" \
  "https://nodejs.org/" || MISSING=1

check_or_install "Pandoc" \
  "command -v pandoc" \
  "pandoc" \
  "https://pandoc.org/installing.html" || MISSING=1

check_or_install "Ollama" \
  "command -v ollama" \
  "ollama" \
  "https://ollama.com/download" || MISSING=1

if [ $MISSING -ne 0 ]; then
  err "Some prerequisites are missing. Please install them and re-run."
  exit 1
fi

echo ""
info "Installing JavaScript dependencies..."
echo ""

# ── 2. Backend npm install ──
(cd backend && npm install --silent)
ok "Backend dependencies installed"

# ── 3. Frontend npm install + build ──
(cd frontend && npm install --silent)
ok "Frontend dependencies installed"

(cd frontend && npm run build > /dev/null 2>&1)
ok "Frontend built"

# ── 4. Wire up backend → built frontend ──
mkdir -p backend/public
rm -rf backend/public/*
cp -R frontend/dist/. backend/public/
ok "Frontend wired into backend/public/"

# ── 5. Build backend ──
(cd backend && npx tsc)
ok "Backend compiled"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "Installation complete!"
echo ""
echo "  Run:  ./bethaniel"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
