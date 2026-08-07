"""Small HTTP client shell with mandatory secret redaction."""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import ssl
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

from .auth.provider import is_allowed_target
from .config import Config


class AuthSessionLike(Protocol):
    def cookie_header(self, url: str | None = None, *, now: float | None = None) -> str: ...

    def metadata(self) -> dict[str, Any]: ...


class AuthResolverLike(Protocol):
    def resolve(self, target_url: str, force_refresh: bool = False) -> AuthSessionLike: ...


class ClientError(RuntimeError):
    def __init__(self, code: str, message: str, recoverable: bool = True):
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable


def _tls_context() -> ssl.SSLContext:
    """Verifying TLS context that survives an empty system CA store.

    A bare Python install (python.org builds before ``Install
    Certificates.command`` runs) points at a CA file that does not exist, so
    valid certificates still fail with ``CERTIFICATE_VERIFY_FAILED``.
    Verification stays ON; when the default store loads no certificates we fall
    back to ``certifi``. ``SSL_CERT_FILE``/``SSL_CERT_DIR`` keep precedence.
    """

    context = ssl.create_default_context()
    try:
        loaded = context.cert_store_stats().get("x509_ca", 0)
    except Exception:
        loaded = 0
    if loaded == 0 and not (os.environ.get("SSL_CERT_FILE") or os.environ.get("SSL_CERT_DIR")):
        try:
            import certifi

            context.load_verify_locations(cafile=certifi.where())
        except Exception:
            pass
    return context


class RedactingFilter(logging.Filter):
    _HEADER_PATTERN = re.compile(r"(?i)\b(authorization|cookie|token)(\s*[:=]\s*)[^\r\n]*")

    def __init__(self, secrets: tuple[str, ...] = ()):
        super().__init__()
        self.secrets = tuple(secret for secret in secrets if secret)

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        for secret in self.secrets:
            message = message.replace(secret, "[REDACTED]")
        message = self._HEADER_PATTERN.sub(r"\1\2[REDACTED]", message)
        record.msg = message
        record.args = ()
        return True


def redacting_logger(secrets: tuple[str, ...] = ()) -> logging.Logger:
    logger = logging.getLogger("browser_forge_generated.client")
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
        logger.addHandler(handler)
        logger.setLevel(logging.WARNING)
        logger.propagate = False
    for handler in logger.handlers:
        handler.filters.clear()
        handler.addFilter(RedactingFilter(secrets))
    return logger


class _SafeBusinessRedirects(HTTPRedirectHandler):
    """Validate every redirect and reconstruct URL-scoped credentials."""

    def __init__(self, client: "Client"):
        self.client = client
        super().__init__()

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        target_url = urljoin(request.full_url, newurl)
        self.client._validate_target(target_url)
        if urlsplit(request.full_url).scheme.lower() != urlsplit(target_url).scheme.lower():
            raise ClientError(
                "TARGET_NOT_ALLOWED",
                "Redirects may not change URL scheme while credentials are attached.",
                recoverable=False,
            )
        redirected = super().redirect_request(request, fp, code, msg, headers, target_url)
        if redirected is None:
            return None
        for collection in (redirected.headers, redirected.unredirected_hdrs):
            for name in tuple(collection):
                if name.lower() in {"authorization", "cookie", "proxy-authorization"}:
                    collection.pop(name, None)
        for name, value in self.client._credential_headers(target_url).items():
            redirected.add_unredirected_header(name, value)
        return redirected


class Client:
    def __init__(
        self,
        config: Config,
        *,
        auth_resolver: AuthResolverLike | None = None,
        force_refresh_auth: bool = False,
    ):
        self.config = config
        self.auth_resolver = auth_resolver
        self.force_refresh_auth = force_refresh_auth
        self.logger = redacting_logger(config.secrets)
        self.auth_metadata: dict[str, Any] = config.auth_status

    def _validate_target(self, target_url: str) -> None:
        parsed = urlsplit(target_url)
        host = parsed.hostname or ""
        try:
            loopback = host.lower() == "localhost" or ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = False
        if (
            parsed.scheme.lower() not in {"http", "https"}
            or (parsed.scheme.lower() != "https" and not loopback)
            or parsed.username
            or parsed.password
            or not is_allowed_target(target_url, self.config.allowed_domains)
        ):
            raise ClientError(
                "TARGET_NOT_ALLOWED",
                "The request target is outside the manifest allowlist.",
                recoverable=False,
            )

    def _credential_headers(self, target_url: str) -> dict[str, str]:
        if self.auth_resolver is None:
            return {}
        try:
            session = self.auth_resolver.resolve(
                target_url,
                force_refresh=self.force_refresh_auth,
            )
            self.force_refresh_auth = False
            cookie_header = session.cookie_header(target_url)
            self.auth_metadata = session.metadata()
        except Exception as error:
            raise ClientError(
                getattr(error, "code", "AUTH_UNAVAILABLE"),
                str(error),
                getattr(error, "recoverable", True),
            ) from None
        return {"Cookie": cookie_header} if cookie_header else {}

    def request(self, method: str, path: str, body: Any = None) -> Any:
        if os.environ.get("BROWSER_FORGE_" "DISABLE_NETWORK") == "1":
            raise ClientError("NETWORK_DISABLED", "Network access is disabled by BROWSER_FORGE_" "DISABLE_NETWORK.")
        if not self.config.base_url:
            raise ClientError("INVALID_CONFIGURATION", "BROWSER_FORGE_BASE_URL is required.")

        target_url = urljoin(self.config.base_url.rstrip("/") + "/", path.lstrip("/"))
        self._validate_target(target_url)
        headers = {"Accept": "application/json"}
        headers.update(self._credential_headers(target_url))
        encoded_body = None
        if body is not None:
            encoded_body = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(target_url, data=encoded_body, headers=headers, method=method)
        self.logger.debug("Requesting %s %s", method, request.full_url)
        try:
            with build_opener(HTTPSHandler(context=_tls_context()), _SafeBusinessRedirects(self)).open(request, timeout=30) as response:
                payload = response.read().decode("utf-8")
        except HTTPError as error:
            raise ClientError("HTTP_ERROR", f"Remote service returned HTTP {error.code}.") from error
        except URLError as error:
            raise ClientError("NETWORK_ERROR", f"Network request failed: {error.reason}") from error
        except TimeoutError as error:
            raise ClientError("REQUEST_TIMEOUT", "Network request timed out.") from error
        except UnicodeDecodeError as error:
            raise ClientError("INVALID_RESPONSE", "Remote service returned invalid UTF-8.") from error
        try:
            return json.loads(payload) if payload else None
        except json.JSONDecodeError as error:
            raise ClientError("INVALID_RESPONSE", "Remote service returned invalid JSON.") from error
