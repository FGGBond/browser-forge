"""Manifest-scoped authentication provider selection."""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Callable, Protocol
from urllib.parse import urlsplit

from .browser_cookies import BrowserCookieError, BrowserCookieProvider
from .cookie_jar import CookieRecord
from .jdme_sso import JdmeSsoError, JdmeSsoProvider
from .session_store import AuthSession

RECOVERABLE_JDME_CODES = frozenset({
    "JDME_NOT_LOGGED_IN",
    "SSO_EXCHANGE_FAILED",
    "TARGET_SESSION_FAILED",
    "TLS_ERROR",
})


class Provider(Protocol):
    def resolve(self, target_url: str, force_refresh: bool = False) -> AuthSession: ...


def _domain(value: str) -> str:
    text = str(value).strip().lower()
    parsed = urlsplit(text if "://" in text else "//" + text)
    return (parsed.hostname or "").strip(".")


def _within(host: str, domain: str) -> bool:
    return bool(domain) and (host == domain or host.endswith("." + domain))


def is_jd_target(target_url: str, allowed_domains: tuple[str, ...] | list[str]) -> bool:
    """Return whether a target is both manifest-allowlisted and within jd.com."""

    host = (urlsplit(target_url).hostname or "").rstrip(".").lower()
    return is_allowed_target(target_url, allowed_domains) and _within(host, "jd.com")


def is_allowed_target(target_url: str, allowed_domains: tuple[str, ...] | list[str]) -> bool:
    host = (urlsplit(target_url).hostname or "").rstrip(".").lower()
    return bool(host) and any(_within(host, _domain(item)) for item in allowed_domains)


class AuthTargetError(RuntimeError):
    def __init__(self):
        super().__init__("The authentication target is outside the manifest allowlist.")
        self.code = "TARGET_NOT_ALLOWED"
        self.recoverable = False


class AuthProviderError(RuntimeError):
    def __init__(self):
        super().__init__("An authentication provider failed unexpectedly.")
        self.code = "AUTH_PROVIDER_ERROR"
        self.recoverable = False


class AuthUnavailableError(RuntimeError):
    def __init__(self, attempted_providers: list[str] | tuple[str, ...]):
        super().__init__("Authentication is unavailable. Sign in to 京ME or a configured browser and retry.")
        self.code = "AUTH_" "UNAVAILABLE"
        self.recoverable = True
        self.attempted_providers = tuple(attempted_providers)
        self.remediation = "Sign in to 京ME or a configured browser, then retry with --refresh-auth."


class AuthResolver:
    def __init__(
        self,
        skill_id: str,
        allowed_domains: tuple[str, ...] | list[str],
        *,
        providers: tuple[str, ...] | list[str] = ("jdme_sso", "browser_cookie"),
        browser_factory: Callable[[], Provider] | None = None,
        jdme_factory: Callable[[], Provider] | None = None,
    ):
        self.skill_id = skill_id
        self.allowed_domains = tuple(allowed_domains)
        self.providers = tuple(providers)
        self._browser = browser_factory or (lambda: BrowserCookieProvider(skill_id))
        self._jdme = jdme_factory or (
            lambda: JdmeSsoProvider(skill_id, allowed_domains=self.allowed_domains)
        )

    @staticmethod
    def _session(
        value: Any,
        *,
        expected_provider: str,
        target_url: str,
        fallback_used: bool,
    ) -> AuthSession:
        if (
            not isinstance(value, AuthSession)
            or value.provider != expected_provider
            or value.target_url != target_url
            or not isinstance(value.cookie_jar, tuple)
            or not all(isinstance(item, CookieRecord) for item in value.cookie_jar)
            or not isinstance(value.expires_at, (int, float))
        ):
            raise AuthProviderError()
        try:
            return replace(value, fallback_used=fallback_used)
        except Exception:
            raise AuthProviderError() from None

    def _strategies(self) -> dict[str, dict[str, Any]]:
        """Declarative provider registry keyed by manifest provider name.

        Each entry pairs an applicability predicate (does this provider apply
        to the target at all) with a factory, the provider's own error type,
        and a predicate for which of its failures are recoverable (fall
        through to the next provider) versus fatal (propagate). resolve() walks
        self.providers in declared order against this table, so the base makes
        no hard assumption about which providers exist or their sequence:
        adding a provider means registering a strategy and listing it in the
        manifest, not editing the resolve control flow.
        """

        return {
            "jdme_sso": {
                "applies": lambda url: is_jd_target(url, self.allowed_domains),
                "factory": self._jdme,
                "error_type": JdmeSsoError,
                "recoverable": lambda error: getattr(error, "code", None) in RECOVERABLE_JDME_CODES,
            },
            "browser_cookie": {
                "applies": lambda url: True,
                "factory": self._browser,
                "error_type": BrowserCookieError,
                # A browser-cookie miss is never fatal on its own: fall through
                # so a later provider can try, or the chain ends AUTH_UNAVAILABLE.
                "recoverable": lambda error: True,
            },
        }

    def resolve(self, target_url: str, force_refresh: bool = False) -> AuthSession:
        if not is_allowed_target(target_url, self.allowed_domains):
            raise AuthTargetError()
        strategies = self._strategies()
        attempted: list[str] = []
        used_fallback = False
        for name in self.providers:
            strategy = strategies.get(name)
            if strategy is None or not strategy["applies"](target_url):
                continue
            attempted.append(name)
            try:
                session = strategy["factory"]().resolve(target_url, force_refresh=force_refresh)
                return self._session(
                    session,
                    expected_provider=name,
                    target_url=target_url,
                    fallback_used=used_fallback,
                )
            except strategy["error_type"] as error:
                if not strategy["recoverable"](error):
                    raise
                used_fallback = True
                continue
            except AuthProviderError:
                raise
            except Exception:
                raise AuthProviderError() from None
        raise AuthUnavailableError(attempted)

    def doctor(self) -> dict[str, Any]:
        return {
            "attempted_providers": list(self.providers),
            "remediation": "Sign in to 京ME or a configured browser before an authenticated command.",
        }
