"""Loads and validates presets from presets.json."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

PRESETS_FILE = Path(__file__).resolve().parent.parent / "presets.json"


def load_presets() -> list[dict[str, Any]]:
    with PRESETS_FILE.open() as f:
        data = json.load(f)
    return data["presets"]


def get_preset(preset_id: str) -> dict[str, Any] | None:
    for p in load_presets():
        if p["id"] == preset_id:
            return p
    return None
