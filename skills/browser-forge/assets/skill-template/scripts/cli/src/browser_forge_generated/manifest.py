"""Manifest discovery for installed and source-tree executions."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


def _candidate_paths() -> list[Path]:
    configured = os.environ.get("BROWSER_FORGE_MANIFEST_" "PATH")
    if configured:
        return [Path(configured).expanduser()]

    starts = [Path(__file__).resolve(), Path(sys.argv[0]).resolve(), Path.cwd().resolve()]
    candidates: list[Path] = []
    for start in starts:
        directory = start if start.is_dir() else start.parent
        for parent in (directory, *directory.parents):
            candidate = parent / "manifest.json"
            if candidate not in candidates:
                candidates.append(candidate)
    return candidates


def manifest_path() -> Path:
    for candidate in _candidate_paths():
        if candidate.is_file():
            return candidate
    locations = ", ".join(str(path) for path in _candidate_paths())
    raise FileNotFoundError(f"manifest.json was not found; checked: {locations}")


def load_manifest() -> dict[str, Any]:
    path = manifest_path()
    with path.open(encoding="utf-8") as stream:
        manifest = json.load(stream)
    if not isinstance(manifest, dict):
        raise ValueError(f"Manifest must contain a JSON object: {path}")
    return manifest
