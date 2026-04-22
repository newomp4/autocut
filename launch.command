#!/usr/bin/env bash
# Double-click this file in Finder to launch AutoCut.
# Runs setup if needed, starts the local server, opens the browser.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

VENV="$HERE/.venv"
PORT="${AUTOCUT_PORT:-8765}"

if [[ ! -f "$VENV/bin/activate" ]]; then
  echo "First-time setup — installing dependencies..."
  bash "$HERE/setup.sh"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"

# Open browser after a brief delay so the server has time to bind.
( sleep 1.2 && open "http://127.0.0.1:${PORT}" ) &

echo ""
echo "────────────────────────────────────────"
echo "  AutoCut by @newomp4"
echo "  Running at http://127.0.0.1:${PORT}"
echo "  Press Ctrl+C in this window to stop."
echo "────────────────────────────────────────"
echo ""

exec python -m uvicorn app.server:app --host 127.0.0.1 --port "$PORT" --log-level warning
