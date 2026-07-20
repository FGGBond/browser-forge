"""URL-scoped cookie selection without global name collapsing."""

from __future__ import annotations

import time
from dataclasses import dataclass
from urllib.parse import urlsplit


@dataclass(frozen=True)
class CookieRecord:
    """The cookie attributes required to decide whether a request may use it."""

    name: str
    value: str
    domain: str
    path: str = "/"
    secure: bool = False
    expires_at: float | None = None
    host_only: bool = False


def _normalized_domain(domain: str) -> str:
    return domain.strip().lstrip(".").rstrip(".").lower()


def _domain_matches(record: CookieRecord, request_host: str) -> bool:
    cookie_domain = _normalized_domain(record.domain)
    if not cookie_domain:
        return False
    if record.host_only:
        return request_host == cookie_domain
    return request_host == cookie_domain or request_host.endswith("." + cookie_domain)


def _normalized_path(path: str) -> str:
    return path if path.startswith("/") else "/"


def _path_matches(cookie_path: str, request_path: str) -> bool:
    if request_path == cookie_path:
        return True
    if not request_path.startswith(cookie_path):
        return False
    return cookie_path.endswith("/") or request_path[len(cookie_path) :].startswith("/")


def _specificity(record: CookieRecord) -> tuple[int, int, int]:
    return (
        len(_normalized_path(record.path)),
        len(_normalized_domain(record.domain)),
        int(record.host_only),
    )


def cookies_for_url(
    records: list[CookieRecord] | tuple[CookieRecord, ...],
    url: str,
    *,
    now: float | None = None,
) -> list[CookieRecord]:
    """Return one URL-valid record per name, ordered by cookie specificity."""

    parsed = urlsplit(url)
    request_host = (parsed.hostname or "").rstrip(".").lower()
    request_path = parsed.path or "/"
    current_time = time.time() if now is None else now
    winners: dict[str, CookieRecord] = {}

    for record in records:
        cookie_path = _normalized_path(record.path)
        if not record.name or not request_host:
            continue
        if record.expires_at is not None and record.expires_at <= current_time:
            continue
        if record.secure and parsed.scheme.lower() != "https":
            continue
        if not _domain_matches(record, request_host):
            continue
        if not _path_matches(cookie_path, request_path):
            continue
        current = winners.get(record.name)
        if current is None or _specificity(record) > _specificity(current):
            winners[record.name] = record

    return sorted(
        winners.values(),
        key=lambda record: (
            -len(_normalized_path(record.path)),
            -len(_normalized_domain(record.domain)),
            -int(record.host_only),
            record.name,
        ),
    )


def cookie_header_for_url(
    records: list[CookieRecord] | tuple[CookieRecord, ...],
    url: str,
    *,
    now: float | None = None,
) -> str:
    """Build a Cookie request header only after URL-specific selection."""

    return "; ".join(
        f"{record.name}={record.value}"
        for record in cookies_for_url(records, url, now=now)
    )
