"""Environment-backed runtime configuration for a generated skill."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit


@dataclass(frozen=True)
class Config:
    base_url: str
    allowed_hosts: tuple[str, ...]
    target_urls: tuple[str, ...]
    auth_strategy: str
    required_cookies: tuple[str, ...]
    default_headers: dict[str, str] = field(default_factory=dict)
    per_host_headers: dict[str, dict[str, str]] = field(default_factory=dict)

    @property
    def auth_status(self) -> dict[str, Any]:
        return {
            "strategy": self.auth_strategy,
            "target_urls": list(self.target_urls),
            "required_cookies": list(self.required_cookies),
            "resolved": False,
        }

    @property
    def secrets(self) -> tuple[str, ...]:
        return ()


def _host_of(url: str) -> str:
    try:
        parsed = urlsplit(url if url.startswith("http") else f"https://{url}")
        return (parsed.hostname or "").lower()
    except Exception:
        return ""


def _first_base_url(target_urls: list[Any]) -> str:
    for url in target_urls:
        if isinstance(url, str) and url:
            return url if url.startswith("http") else f"https://{url}"
    return ""


def load_config(manifest: dict[str, Any]) -> Config:
    auth = manifest.get("auth", {}) if isinstance(manifest.get("auth"), dict) else {}
    transport = manifest.get("transport", {}) if isinstance(manifest.get("transport"), dict) else {}
    target_urls = auth.get("target_urls") or []
    default_base_url = _first_base_url(target_urls)
    hosts = sorted({_host_of(url) for url in target_urls if _host_of(url)})

    default_headers = transport.get("default_headers") if isinstance(transport.get("default_headers"), dict) else {}
    per_host = transport.get("per_host") if isinstance(transport.get("per_host"), dict) else {}

    return Config(
        base_url=os.environ.get("BROWSER_FORGE_BASE_URL", default_base_url).rstrip("/"),
        allowed_hosts=tuple(hosts),
        target_urls=tuple(str(u) for u in target_urls),
        auth_strategy=str(auth.get("strategy", "none")),
        required_cookies=tuple(str(c) for c in (auth.get("required_cookies") or ())),
        default_headers={str(k): str(v) for k, v in (default_headers or {}).items()},
        per_host_headers={
            str(host).lower(): {str(k): str(v) for k, v in (headers or {}).items()}
            for host, headers in (per_host or {}).items()
        },
    )
