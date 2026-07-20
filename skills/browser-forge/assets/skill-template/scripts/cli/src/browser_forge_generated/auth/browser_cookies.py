"""Lazy browser-cookie provider with redacted failures."""

from __future__ import annotations

import importlib
import time
from collections.abc import Iterable
from typing import Any, Callable
from urllib.parse import urlsplit

from .cookie_jar import CookieRecord, cookies_for_host, cookies_for_url
from .session_store import DEFAULT_TTL_SECONDS, AuthSession, SessionStore


class BrowserCookieError(RuntimeError):
    def __init__(self, attempts: list[dict[str, str]]):
        super().__init__("Configured browsers did not provide cookies for the target host.")
        self.code = "BROWSER_COOKIE_" "UNAVAILABLE"
        self.attempts = tuple(attempts)


def _record(item: Any) -> CookieRecord:
    domain_specified = bool(getattr(item, "domain_specified", False))
    return CookieRecord(
        name=str(item.name),
        value=str(item.value),
        domain=str(item.domain),
        path=str(getattr(item, "path", "/") or "/"),
        secure=bool(getattr(item, "secure", False)),
        expires_at=getattr(item, "expires", None),
        host_only=not domain_specified,
    )


class BrowserCookieProvider:
    def __init__(
        self,
        skill_id: str,
        *,
        browsers: tuple[str, ...] = ("edge", "chrome"),
        cache_root: str | None = None,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        now: Callable[[], float] = time.time,
    ):
        self.browsers = tuple(browsers)
        self.ttl_seconds = ttl_seconds
        self.now = now
        self.store = SessionStore(
            skill_id,
            {"browsers": list(self.browsers)},
            root=cache_root,
            ttl_seconds=ttl_seconds,
            now=now,
        )

    def _load_module(self):
        return importlib.import_module("browser_cookie3")

    def _records(self, cookies: Iterable[Any]) -> list[CookieRecord]:
        return [_record(item) for item in cookies]

    def resolve(self, target_url: str, force_refresh: bool = False) -> AuthSession:
        if force_refresh:
            self.store.delete(target_url)
        else:
            cached = self.store.load(target_url)
            if cached is not None:
                return cached

        attempts: list[dict[str, str]] = []
        try:
            browser_cookie3 = self._load_module()
        except Exception as error:
            attempts.extend(
                {"browser": browser, "error": type(error).__name__}
                for browser in self.browsers
            )
            raise BrowserCookieError(attempts) from None

        hostname = urlsplit(target_url).hostname
        for browser in self.browsers:
            try:
                loader = getattr(browser_cookie3, browser)
                records = cookies_for_host(
                    self._records(loader(domain_name=hostname)),
                    target_url,
                    now=self.now(),
                )
                if not cookies_for_url(records, target_url, now=self.now()):
                    raise LookupError("no matching cookies")
                cookie_expiries = [record.expires_at for record in records if record.expires_at is not None]
                expires_at = self.now() + self.ttl_seconds
                if cookie_expiries:
                    expires_at = min(expires_at, *cookie_expiries)
                session = AuthSession(
                    provider="browser_cookie",
                    target_url=target_url,
                    cookie_jar=tuple(records),
                    fallback_used=False,
                    expires_at=expires_at,
                )
                self.store.save(session)
                return session
            except Exception as error:
                attempts.append({"browser": browser, "error": type(error).__name__})

        raise BrowserCookieError(attempts)
