#!/usr/bin/env bash
# First-time setup. Creates an isolated Python environment inside this folder
# and installs all dependencies into it. Safe to re-run (idempotent).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

PYTHON_BIN="${PYTHON_BIN:-python3}"
VENV="$HERE/.venv"

if [[ ! -d "$VENV" ]]; then
  echo "→ Creating isolated Python environment in .venv/"
  "$PYTHON_BIN" -m venv "$VENV"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "→ Upgrading pip"
python -m pip install --quiet --upgrade pip

echo "→ Installing dependencies (auto-editor, fastapi, uvicorn)"
python -m pip install --quiet -r requirements.txt

echo "✓ Setup complete."
