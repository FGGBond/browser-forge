"""Cookie/session authentication using external packages.

This module delegates to two independently-published tools instead of
re-implementing SSO/cookie logic in every generated skill:

* ``erp-sso-login`` — obtains a target site's ``ssa.<app>`` session cookie by
  walking the JD internal SSA/OIDC flow with a ``me_token`` extracted from the
  JDME desktop client. Preferred for ``.jd.com`` targets.
* ``browser-auth-cookie`` — reads cookies from the user's currently-logged-in
  browser (Edge / Chrome / Firefox / Safari / Chromium / Brave / Opera /
  Vivaldi). Universal fallback.

Provider selection is decided by ``manifest.auth.strategy``:

* ``jd-internal``   — try ``erp-sso-login`` first, fall back to
  ``browser-auth-cookie`` on recoverable failures.
* ``browser-cookie`` — ``browser-auth-cookie`` only.
* ``none``          — do not attach cookies.

The generated ``Client`` calls :meth:`AuthResolver.resolve` with the exact
target URL of every request. A short-lived in-process cache avoids repeated
subprocess/library calls within a single command invocation.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any


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
            errors.append({"provider": "browser-auth-cookie", "code": error.code, "message": str(error)})

        detail = "; ".join(f"{item['provider']}={item['code']}: {item['message']}" for item in errors)
        raise AuthError(
            "AUTH_UNAVAILABLE",
            f"No provider produced a session for {target_url}. Attempts: {detail or 'none'}",
            recoverable=True,
            remediation=(
                "Install browser-auth-cookie (`pip install browser-auth-cookie`) and log into the "
                "target in a supported browser. For JD internal targets also keep JDME desktop client "
                "signed in and set ERP_SSO_LOGIN_HOME to the erp-sso-login skill directory."
            ),
        )

    def invalidate(self, target_url: str) -> None:
        self._cache.pop(target_url, None)
        try:
            from browser_auth_cookie import invalidate as _invalidate  # type: ignore
            _invalidate(target_url)
        except Exception:
            pass

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
            if value:
                return value
        return None

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
                "Set ERP_SSO_LOGIN_HOME to the path of the erp-sso-login skill directory "
                "and make sure JDME desktop client is signed in."
            ),
        }

    def _resolve_erp_sso(self, target_url: str, *, force_refresh: bool) -> AuthSession:
        script = self._erp_sso_script()
        if not script:
            raise AuthError(
                "ERP_SSO_UNAVAILABLE",
                "erp-sso-login is not installed or ERP_SSO_LOGIN_HOME is not set.",
                recoverable=True,
                remediation="Set ERP_SSO_LOGIN_HOME to the erp-sso-login directory.",
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
    # browser-auth-cookie (universal fallback)

    def _doctor_browser_cookie(self) -> dict[str, Any]:
        try:
            import browser_auth_cookie  # type: ignore  # noqa: F401
            available = True
            hint = None
        except ImportError:
            available = False
            hint = "pip install browser-auth-cookie"
        return {
            "name": "browser-auth-cookie",
            "available": available,
            "hint": hint,
        }

    def _resolve_browser_cookie(self, target_url: str, *, force_refresh: bool) -> AuthSession:
        override = os.environ.get("BROWSER_FORGE_COOKIE_HEADER", "").strip()
        if override:
            _validate_required(override, self.required_cookies)
            return AuthSession(override, "env", self.strategy, target_url, time.time())

        try:
            from browser_auth_cookie import get_auth  # type: ignore
        except ImportError:
            raise AuthError(
                "BROWSER_COOKIE_UNAVAILABLE",
                "browser-auth-cookie is not installed.",
                recoverable=True,
                remediation="pip install browser-auth-cookie",
            ) from None

        try:
            result = get_auth(
                target_url,
                required_cookies=self.required_cookies,
                force_refresh=force_refresh,
            )
        except Exception as error:
            raise AuthError(
                "BROWSER_COOKIE_UNAVAILABLE",
                str(error) or "browser-auth-cookie failed to produce cookies.",
                recoverable=True,
                remediation=(
                    "Log into the target site in a supported browser (Edge / Chrome / Firefox / Safari / "
                    "Chromium / Brave / Opera / Vivaldi)."
                ),
            ) from None

        cookie_header = getattr(result, "cookie_header", "") or ""
        if not cookie_header:
            raise AuthError("BROWSER_COOKIE_EMPTY", "No cookies returned from any browser.", recoverable=True)
        return AuthSession(
            cookie_header=cookie_header,
            provider=f"browser-auth-cookie[{getattr(result, 'browser', 'unknown')}]",
            strategy=self.strategy,
            target_url=target_url,
            obtained_at=time.time(),
        )


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
