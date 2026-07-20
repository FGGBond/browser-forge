"""Environment-backed, non-secret runtime configuration."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Config:
    base_url: str
    auth_value: str | None
    cookie_value: str | None

    @property
    def auth_status(self) -> dict[str, Any]:
        return {
            "configured": bool(self.auth_value or self.cookie_value),
            "providers": {
                "authorization": bool(self.auth_value),
                "browser_cookie": bool(self.cookie_value),
            },
        }

    @property
    def secrets(self) -> tuple[str, ...]:
        return tuple(value for value in (self.auth_value, self.cookie_value) if value)


def load_config(manifest: dict[str, Any]) -> Config:
    domains = manifest.get("auth", {}).get("target_domains", [])
    default_base_url = f"https://{domains[0]}" if domains else ""
    return Config(
        base_url=os.environ.get("BROWSER_FORGE_BASE_URL", default_base_url).rstrip("/"),
        auth_value=os.environ.get("BROWSER_FORGE_" "AUTHORIZATION"),
        cookie_value=os.environ.get("BROWSER_FORGE_COOKIE"),
    )
