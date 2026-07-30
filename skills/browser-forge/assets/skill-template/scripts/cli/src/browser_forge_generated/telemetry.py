"""Best-effort usage telemetry for generated Browser Forge skills.

Telemetry is disabled unless SLS WebTracking environment variables are present.
It never raises to callers and never writes to stdout/stderr.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import time
import uuid
from dataclasses import dataclass
from typing import Any
from urllib import request


def _truthy(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def _erp() -> tuple[str, str]:
    for name in ("JD_ERP", "ERP", "USER"):
        value = os.environ.get(name, "").strip()
        if value and value.lower() not in {"root", "unknown"}:
            return value, name.lower()
    return "unknown", "unknown"


def _machine_hash() -> str:
    raw = f"{platform.node()}|{platform.platform()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def _clean_host(value: str) -> str:
    return value.strip().removeprefix("https://").removeprefix("http://").rstrip("/")


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int, float)):
        return str(value)
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


@dataclass(frozen=True)
class UsageTelemetry:
    enabled: bool
    host: str
    project: str
    logstore: str
    topic: str
    source: str
    skill_id: str
    skill_name: str
    app_session_id: str

    @classmethod
    def from_environment(cls, manifest: dict[str, Any]) -> "UsageTelemetry":
        host = _clean_host(os.environ.get("BROWSER_FORGE_" "SLS_HOST", ""))
        project = os.environ.get("BROWSER_FORGE_" "SLS_PROJECT", "").strip()
        logstore = os.environ.get("BROWSER_FORGE_" "SLS_LOGSTORE", "").strip()
        disabled = _truthy(os.environ.get("BROWSER_FORGE_" "TELEMETRY_DISABLED"))
        enabled = bool(host and project and logstore and not disabled)
        return cls(
            enabled=enabled,
            host=host,
            project=project,
            logstore=logstore,
            topic=os.environ.get("BROWSER_FORGE_" "SLS_TOPIC", "browser-forge-" "generated-skill").strip() or "browser-forge-" "generated-skill",
            source=os.environ.get("BROWSER_FORGE_" "SLS_SOURCE", "browser-forge-" "generated-cli").strip() or "browser-forge-" "generated-cli",
            skill_id=str(manifest.get("id", "unknown")),
            skill_name=str(manifest.get("name", "unknown")),
            app_session_id=str(uuid.uuid4()),
        )

    def track_command(self, command_id: str | None, *, ok: bool, status: str, duration_ms: int, error_code: str | None = None) -> None:
        if not self.enabled:
            return
        erp, erp_source = _erp()
        event = {
            "event_id": str(uuid.uuid4()),
            "event_name": "generated_" "skill_used",
            "event_time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "schema_version": "1",
            "app_name": "browser-forge-" "generated-skill",
            "channel": "jd-internal",
            "erp": erp,
            "erp_source": erp_source,
            "app_session_id": self.app_session_id,
            "machine_hash": _machine_hash(),
            "platform": platform.system().lower(),
            "arch": platform.machine(),
            "skill_id": self.skill_id,
            "skill_name": self.skill_name,
            "command_id": command_id or "unknown",
            "ok": ok,
            "status": status,
            "duration_ms": duration_ms,
        }
        if error_code:
            event["error_code"] = error_code
        self._send(event)

    def _send(self, event: dict[str, Any]) -> None:
        try:
            payload = json.dumps({"__logs__": [{key: _stringify(value) for key, value in event.items()}], "__topic__": self.topic, "__source__": self.source}, ensure_ascii=False).encode("utf-8")
            url = f"https://{self.project}.{self.host}/logstores/{self.logstore}/track?APIVersion=0.6.0"
            req = request.Request(url, data=payload, method="POST", headers={"Content-Type": "application/json"})
            request.urlopen(req, timeout=1.0).close()
        except Exception:
            return
