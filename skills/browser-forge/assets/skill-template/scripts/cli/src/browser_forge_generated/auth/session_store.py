"""Isolated, short-lived authentication session cache."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from .cookie_jar import CookieRecord, cookie_header_for_url

DEFAULT_TTL_SECONDS = 4 * 60 * 60


def _safe_component(value: str, fallback: str) -> str:
    component = re.sub(r"[^A-Za-z0-9._-]+", "-", value).strip("._-")
    component = re.sub(r"(?:\.\.)+", "-", component).strip("._-")
    return component or fallback


@dataclass(frozen=True)
class AuthSession:
    provider: str
    target_url: str
    cookie_jar: tuple[CookieRecord, ...]
    fallback_used: bool
    expires_at: float
    cached: bool = field(default=False, compare=False)

    def cookie_header(self, url: str | None = None, *, now: float | None = None) -> str:
        return cookie_header_for_url(self.cookie_jar, url or self.target_url, now=now)

    def metadata(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "target_host": urlsplit(self.target_url).hostname,
            "fallback_used": self.fallback_used,
            "expires_at": self.expires_at,
            "cookie_count": len(self.cookie_jar),
            "cached": self.cached,
        }


class SessionStore:
    def __init__(
        self,
        skill_id: str,
        settings: dict[str, Any],
        *,
        root: str | Path | None = None,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        now: Callable[[], float] = time.time,
    ):
        self.skill_id = _safe_component(skill_id, "skill")
        self.settings = settings
        self.root = Path(root) if root is not None else Path.home() / ".config" / "browser-forge"
        self.ttl_seconds = ttl_seconds
        self.now = now
        encoded = json.dumps(settings, sort_keys=True, separators=(",", ":")).encode("utf-8")
        self.settings_hash = hashlib.sha256(encoded).hexdigest()[:12]

    def cache_path(self, target_url: str) -> Path:
        host = urlsplit(target_url).hostname or "host"
        safe_host = _safe_component(host.lower(), "host")
        return self.root / self.skill_id / "auth" / f"{safe_host}-{self.settings_hash}.json"

    def load(self, target_url: str) -> AuthSession | None:
        path = self.cache_path(target_url)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict) or float(payload["expires_at"]) <= self.now():
                return None
            cached_host = urlsplit(str(payload["target_url"])).hostname
            target_host = urlsplit(target_url).hostname
            if not cached_host or cached_host.lower() != (target_host or "").lower():
                return None
            records = tuple(CookieRecord(**item) for item in payload.get("cookies", []))
            return AuthSession(
                provider=str(payload["provider"]),
                target_url=target_url,
                cookie_jar=records,
                fallback_used=bool(payload.get("fallback_used", False)),
                expires_at=float(payload["expires_at"]),
                cached=True,
            )
        except (OSError, ValueError, TypeError, KeyError):
            return None

    def save(self, session: AuthSession) -> Path:
        path = self.cache_path(session.target_url)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "provider": session.provider,
            "target_url": session.target_url,
            "fallback_used": session.fallback_used,
            "expires_at": session.expires_at,
            "cookies": [asdict(record) for record in session.cookie_jar],
        }
        descriptor, temporary_name = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
        temporary_path = Path(temporary_name)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                descriptor = -1
                json.dump(payload, stream, separators=(",", ":"), ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, path)
            os.chmod(path, 0o600)
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass
        return path

    def delete(self, target_url: str) -> None:
        try:
            self.cache_path(target_url).unlink()
        except FileNotFoundError:
            pass
