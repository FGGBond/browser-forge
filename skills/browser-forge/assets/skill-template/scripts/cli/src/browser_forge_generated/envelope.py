"""Stable JSON response envelopes."""

from __future__ import annotations

from typing import Any

SPEC_VERSION = "{{SPEC_VERSION}}"


def success(
    command: Any,
    data: Any = None,
    artifacts: list[Any] | None = None,
    auth: dict[str, Any] | None = None,
    next_actions: list[Any] | None = None,
) -> dict[str, Any]:
    return {
        "spec_version": SPEC_VERSION,
        "ok": True,
        "command": command,
        "status": "success",
        "data": data,
        "artifacts": [] if artifacts is None else artifacts,
        "auth": {} if auth is None else auth,
        "next_actions": [] if next_actions is None else next_actions,
    }


def failure(
    command: Any,
    code: str,
    message: str,
    recoverable: bool = False,
    next_actions: list[Any] | None = None,
) -> dict[str, Any]:
    return {
        "spec_version": SPEC_VERSION,
        "ok": False,
        "command": command,
        "status": "failure",
        "data": None,
        "artifacts": [],
        "auth": {},
        "next_actions": [] if next_actions is None else next_actions,
        "error": {
            "code": code,
            "message": message,
            "recoverable": recoverable,
        },
    }
