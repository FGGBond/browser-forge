"""Environment-backed, non-secret runtime configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Config:
    base_url: str
    allowed_domains: tuple[str, ...]
    providers: tuple[str, ...]

    @property
    def auth_status(self) -> dict[str, Any]:
        return {
            "configured": bool(self.base_url and self.providers),
            "resolved": False,
            "providers": list(self.providers),
        }

    @property
    def secrets(self) -> tuple[str, ...]:
        return ()


def load_config(manifest: dict[str, Any]) -> Config:
    domains = manifest.get("auth", {}).get("target_domains", [])
    default_base_url = f"https://{domains[0]}" if domains else ""
    return Config(
        base_url=os.environ.get("BROWSER_FORGE_BASE_URL", default_base_url).rstrip("/"),
        allowed_domains=tuple(str(domain) for domain in domains),
        providers=tuple(str(provider) for provider in manifest.get("auth", {}).get("providers", [])),
    )
