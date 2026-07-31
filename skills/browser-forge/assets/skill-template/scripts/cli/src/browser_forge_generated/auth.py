"""Cookie/session authentication — self-contained, opinionated defaults.

This module is bundled into every generated Browser Forge skill so the
resulting CLI is **open-the-box runnable**: no private packages, no manual
environment variables to export. The runtime resolves cookies through two
independent providers:

* ``erp-sso-login`` — obtains a target site's ``ssa.<app>`` session cookie by
  walking the JD internal SSA/OIDC flow with a ``me_token`` extracted from the
  JDME desktop client. Preferred for ``.jd.com`` targets. Auto-discovered from
  common install locations if ``ERP_SSO_LOGIN_HOME`` / ``ERP_SSO_LOGIN_PATH``
  are not set.
* Browser-jar reader — loads cookies from the user's currently-logged-in
  browser (Edge / Chrome / Firefox / Safari / Chromium / Brave / Opera /
  Vivaldi) via the PyPI ``browser-cookie3`` package. Universal fallback.

Provider selection is decided by ``manifest.auth.strategy``:

* ``jd-internal``   — try ``erp-sso-login`` first, fall back to browser jar.
* ``browser-cookie`` — browser jar only.
* ``none``          — do not attach cookies.

The generated ``Client`` calls :meth:`AuthResolver.resolve` with the exact
target URL of every request. A short-lived in-process cache avoids repeated
subprocess/library calls within a single command invocation.
"""

from __future__ import annotations

import ipaddress
import os
import re
import shlex
import subprocess
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.cookiejar import Cookie, CookieJar
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request


class AuthError(RuntimeError):
    def __init__(self, code: str, message: str, *, recoverable: bool = True, remediation: str | None = None):
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable
        self.remediation = remediation


@dataclass
class AuthSession:
    cookie_header: str
    provider: str
    strategy: str
    target_url: str
    obtained_at: float
    warnings: tuple[str, ...] = field(default_factory=tuple)

    def metadata(self) -> dict[str, Any]:
        return {
            "strategy": self.strategy,
            "provider": self.provider,
            "target_url": self.target_url,
            "obtained_at": self.obtained_at,
            "resolved": True,
            "cookie_names": tuple(sorted({
                part.split("=", 1)[0].strip()
                for part in self.cookie_header.split(";")
                if "=" in part
            })),
            "warnings": list(self.warnings),
        }


# ----------------------------------------------------------------------
# Well-known locations to auto-discover erp-sso-login without exporting env vars.
# Users still may set ERP_SSO_LOGIN_HOME to override.

_ERP_SSO_WELL_KNOWN = (
    "~/.claude/skills/erp-sso-login",
    "~/CodeSpace/claude-workspace/browser-forge-workspace/erp-sso-login",
    "~/browser-forge-workspace/erp-sso-login",
    "~/.oxygen/cli/erp-sso-login",
    "~/.local/share/erp-sso-login",
)


def _first_existing(paths: tuple[str, ...]) -> str | None:
    for raw in paths:
        expanded = os.path.expanduser(raw)
        for candidate in (
            os.path.join(expanded, "assets", "scripts", "run.sh"),
            os.path.join(expanded, "run.sh"),
        ):
            if os.path.isfile(candidate):
                return expanded
    return None


# ----------------------------------------------------------------------
# Minimal browser-cookie loader. Wraps browser-cookie3 (PyPI, MIT) directly
# so generated skills need no private dependency.

_BROWSER_LOADERS = ("edge", "chrome", "firefox", "safari", "chromium", "brave", "opera", "vivaldi")


class _BrowserCookieError(RuntimeError):
    pass


def _load_jar(browser: str, domain_hint: str) -> CookieJar:
    try:
        import browser_cookie3  # type: ignore
    except ImportError as error:  # pragma: no cover - dependency missing
        raise _BrowserCookieError("browser-cookie3 is not installed") from error
    loader = getattr(browser_cookie3, browser, None)
    if loader is None:
        raise _BrowserCookieError(f"unsupported browser: {browser}")
    try:
        return loader(domain_name=domain_hint)
    except Exception as error:
        raise _BrowserCookieError(f"{browser}: {error}") from error


_HOST_LABEL = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", re.IGNORECASE)


def _normalize_target(value: str) -> tuple[str, str]:
    raw = value.strip()
    if "://" not in raw:
        raw = f"https://{raw}"
    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise AuthError("INVALID_TARGET", "only http/https targets are supported.")
    host = (parsed.hostname or "").lower()
    try:
        ipaddress.ip_address(host)
        is_ip = True
    except ValueError:
        is_ip = False
    if not host or (not is_ip and host != "localhost" and not ("." in host and all(_HOST_LABEL.fullmatch(l) for l in host.split(".")))):
        raise AuthError("INVALID_TARGET", f"invalid host in {value!r}.")
    netloc = host if parsed.port is None else f"{host}:{parsed.port}"
    return (urlunsplit((scheme, netloc, parsed.path or "/", parsed.query, "")), host)


def _domain_hint(host: str) -> str:
    """Return the last two labels (registrable-ish). No public-suffix magic —
    good enough for JD internal targets and the common corp/personal use cases
    the skill sees."""
    labels = host.split(".")
    return ".".join(labels[-2:]) if len(labels) >= 2 else host


def _select_cookies_for_url(jar: CookieJar, target_url: str) -> tuple[str, tuple[Cookie, ...]]:
    request = Request(target_url)
    jar.add_cookie_header(request)
    header = request.get_header("Cookie") or ""
    if not header:
        return "", ()
    remaining: list[Cookie] = list(jar)
    selected: list[Cookie] = []
    for pair in header.split("; "):
        if "=" not in pair:
            continue
        name, value = pair.split("=", 1)
        matches = [c for c in remaining if c.name == name and (c.value or "") == value]
        if not matches:
            continue
        pick = max(matches, key=lambda c: len(c.path or "/"))
        remaining.remove(pick)
        selected.append(pick)
    return header, tuple(selected)


# ----------------------------------------------------------------------

class AuthResolver:
    def __init__(
        self,
        strategy: str,
        *,
        required_cookies: tuple[str, ...] = (),
        cache_ttl_seconds: int = 600,
    ):
        self.strategy = strategy
        self.required_cookies = tuple(required_cookies)
        self.cache_ttl_seconds = cache_ttl_seconds
        self._cache: dict[str, tuple[float, AuthSession]] = {}
        self._doctor_cache: dict[str, Any] | None = None

    # ------------------------------------------------------------------
    # public surface

    def resolve(self, target_url: str, *, force_refresh: bool = False) -> AuthSession:
        if self.strategy == "none":
            return AuthSession("", "none", "none", target_url, time.time())

        cached = None if force_refresh else self._cache.get(target_url)
        if cached is not None:
            obtained, session = cached
            if time.time() - obtained <= self.cache_ttl_seconds:
                return session
            del self._cache[target_url]

        errors: list[dict[str, Any]] = []

        if self.strategy == "jd-internal":
            try:
                session = self._resolve_erp_sso(target_url, force_refresh=force_refresh)
                self._cache[target_url] = (time.time(), session)
                return session
            except AuthError as error:
                errors.append({"provider": "erp-sso-login", "code": error.code, "message": str(error)})
                if not error.recoverable:
                    raise

        try:
            session = self._resolve_browser_cookie(target_url, force_refresh=force_refresh)
            self._cache[target_url] = (time.time(), session)
            return session
        except AuthError as error:
            errors.append({"provider": "browser-cookie3", "code": error.code, "message": str(error)})

        detail = "; ".join(f"{item['provider']}={item['code']}: {item['message']}" for item in errors)
        raise AuthError(
            "AUTH_UNAVAILABLE",
            f"No provider produced a session for {target_url}. Attempts: {detail or 'none'}",
            recoverable=True,
            remediation=(
                "The skill's install.sh installs browser-cookie3 automatically into the local .venv. "
                "If that failed, run `bash scripts/install.sh` from the skill directory. "
                "Make sure you're logged into the target site in Edge/Chrome. "
                "For JD internal targets, install the erp-sso-login skill under one of the well-known "
                "locations (or set ERP_SSO_LOGIN_HOME) and keep JDME desktop client signed in."
            ),
        )

    def invalidate(self, target_url: str) -> None:
        self._cache.pop(target_url, None)

    def doctor(self) -> dict[str, Any]:
        if self._doctor_cache is not None:
            return self._doctor_cache
        info: dict[str, Any] = {"strategy": self.strategy, "providers": []}
        info["providers"].append(self._doctor_erp_sso())
        info["providers"].append(self._doctor_browser_cookie())
        self._doctor_cache = info
        return info

    # ------------------------------------------------------------------
    # erp-sso-login (JD internal SSA/OIDC via JDME desktop client)

    def _erp_sso_home(self) -> str | None:
        for env_var in ("ERP_SSO_LOGIN_HOME", "ERP_SSO_LOGIN_PATH"):
            value = os.environ.get(env_var, "").strip()
            if value and os.path.isdir(value):
                return value
        auto = _first_existing(_ERP_SSO_WELL_KNOWN)
        return auto

    def _erp_sso_script(self) -> str | None:
        home = self._erp_sso_home()
        if not home:
            return None
        for candidate in ("assets/scripts/run.sh", "run.sh"):
            path = os.path.join(home, candidate)
            if os.path.isfile(path):
                return path
        return None

    def _doctor_erp_sso(self) -> dict[str, Any]:
        home = self._erp_sso_home()
        script = self._erp_sso_script()
        available = bool(script)
        return {
            "name": "erp-sso-login",
            "available": available,
            "home": home,
            "hint": None if available else (
                "Install erp-sso-login (e.g. `o2 install erp-sso-login`) or set "
                "ERP_SSO_LOGIN_HOME to its skill directory. JDME desktop client must be signed in."
            ),
        }

    def _resolve_erp_sso(self, target_url: str, *, force_refresh: bool) -> AuthSession:
        script = self._erp_sso_script()
        if not script:
            raise AuthError(
                "ERP_SSO_UNAVAILABLE",
                "erp-sso-login is not installed at any well-known location and ERP_SSO_LOGIN_HOME is not set.",
                recoverable=True,
                remediation=(
                    "Install erp-sso-login (`o2 install erp-sso-login`) or set ERP_SSO_LOGIN_HOME."
                ),
            )
        cmd = ["bash", script, "--url", target_url, "--cookie-header"]
        if force_refresh:
            cmd.append("--no-cache")
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=30, check=False, text=True)
        except FileNotFoundError as error:
            raise AuthError("ERP_SSO_MISSING_BASH", f"bash not found: {error}", recoverable=True) from None
        except subprocess.TimeoutExpired:
            raise AuthError("ERP_SSO_TIMEOUT", "erp-sso-login timed out.", recoverable=True) from None
        if result.returncode != 0:
            snippet = (result.stderr or result.stdout or "").strip().splitlines()[-1:] or [""]
            raise AuthError(
                "ERP_SSO_FAILED",
                f"erp-sso-login exited {result.returncode}: {snippet[0][:200]}",
                recoverable=True,
                remediation="Reopen the target URL in JDME/browser and retry, or unset ERP_SSO_LOGIN_HOME to skip.",
            )
        cookie_header = (result.stdout or "").strip()
        if not cookie_header:
            raise AuthError("ERP_SSO_EMPTY", "erp-sso-login returned no cookie header.", recoverable=True)
        _validate_required(cookie_header, self.required_cookies)
        return AuthSession(
            cookie_header=cookie_header,
            provider="erp-sso-login",
            strategy=self.strategy,
            target_url=target_url,
            obtained_at=time.time(),
        )

    # ------------------------------------------------------------------
    # browser-cookie3 (universal fallback, inlined)

    def _doctor_browser_cookie(self) -> dict[str, Any]:
        try:
            import browser_cookie3  # type: ignore  # noqa: F401
            available = True
            hint = None
        except ImportError:
            available = False
            hint = "pip install browser-cookie3 (or run scripts/install.sh)"
        return {
            "name": "browser-cookie3",
            "available": available,
            "hint": hint,
            "browsers_order": _configured_browsers(),
        }

    def _resolve_browser_cookie(self, target_url: str, *, force_refresh: bool) -> AuthSession:
        override = os.environ.get("BROWSER_FORGE_COOKIE_HEADER", "").strip()
        if override:
            _validate_required(override, self.required_cookies)
            return AuthSession(override, "env", self.strategy, target_url, time.time())

        try:
            normalized_url, host = _normalize_target(target_url)
        except AuthError:
            raise

        hint = _domain_hint(host)
        errors: list[str] = []
        for browser in _configured_browsers():
            try:
                jar = _load_jar(browser, hint)
            except _BrowserCookieError as error:
                errors.append(str(error))
                if "browser-cookie3 is not installed" in str(error):
                    raise AuthError(
                        "BROWSER_COOKIE_UNAVAILABLE",
                        "browser-cookie3 is not installed in the CLI environment.",
                        recoverable=True,
                        remediation="Run `bash scripts/install.sh` from the skill directory.",
                    ) from None
                continue
            header, cookies = _select_cookies_for_url(jar, normalized_url)
            if not header:
                errors.append(f"{browser}: no cookies matched {host}")
                continue
            _validate_required(header, self.required_cookies)
            return AuthSession(
                cookie_header=header,
                provider=f"browser-cookie3[{browser}]",
                strategy=self.strategy,
                target_url=target_url,
                obtained_at=time.time(),
            )
        raise AuthError(
            "BROWSER_COOKIE_EMPTY",
            f"no browser cookies matched {host} (tried {', '.join(_configured_browsers())}). Details: {'; '.join(errors) or 'none'}",
            recoverable=True,
            remediation="Log into the target site in one of Edge/Chrome/Firefox/Safari.",
        )


def _configured_browsers() -> tuple[str, ...]:
    raw = os.getenv("BROWSER_AUTH_BROWSERS", "edge,chrome")
    ordered = tuple(dict.fromkeys(item.strip().lower() for item in raw.split(",") if item.strip()))
    return tuple(name for name in ordered if name in _BROWSER_LOADERS) or ("edge", "chrome")


def _validate_required(cookie_header: str, required: tuple[str, ...]) -> None:
    if not required:
        return
    names = {part.split("=", 1)[0].strip() for part in cookie_header.split(";") if "=" in part}
    missing = [name for name in required if name not in names]
    if missing:
        raise AuthError(
            "REQUIRED_COOKIE_MISSING",
            f"required cookies missing: {', '.join(missing)}",
            recoverable=True,
            remediation="Refresh the target site in your browser (or JDME) and retry.",
        )


# ----------------------------------------------------------------------
# CLI-oriented helpers

def summarize_error(error: AuthError) -> dict[str, Any]:
    return {
        "resolved": False,
        "code": error.code,
        "message": str(error),
        "recoverable": error.recoverable,
        "remediation": error.remediation,
    }


def format_shell_env(pairs: dict[str, str]) -> str:
    return " ".join(f"{key}={shlex.quote(value)}" for key, value in pairs.items())


__all__ = ["AuthError", "AuthResolver", "AuthSession", "summarize_error", "format_shell_env"]
