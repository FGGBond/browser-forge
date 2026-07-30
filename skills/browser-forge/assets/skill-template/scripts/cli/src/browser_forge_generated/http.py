"""HTTP client with mandatory secret redaction, allowlist, and default headers.

The client centralises three concerns generated skills all care about:

* Attach the manifest's ``transport.default_headers`` (and ``transport.per_host``)
  to every outbound request — recording-derived infrastructure metadata such as
  ``x-proxy-opts`` on JD BFF routes lives here so business commands do not have
  to know about it.
* Attach the session cookie header produced by :mod:`.auth` and detect
  ``sso_redirect_url``-style HTTP 200 responses that signal a broken session.
* Enforce an allowlist derived from ``manifest.auth.target_urls`` so a
  redirected or user-supplied path can never leak credentials to a foreign host.
"""

from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .auth import AuthError, AuthResolver
from .config import Config


class ClientError(RuntimeError):
    def __init__(self, code: str, message: str, recoverable: bool = True):
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable


class RedactingFilter(logging.Filter):
    _HEADER_PATTERN = re.compile(r"(?i)\b(authorization|cookie|x-auth-token|set-cookie)(\s*[:=]\s*)[^\r\n]*")

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


def _host_matches_allowlist(host: str, allowed: tuple[str, ...]) -> bool:
    if not host:
        return False
    host = host.lower().rstrip(".")
    for entry in allowed:
        entry = entry.lower().rstrip(".")
        if host == entry or host.endswith("." + entry):
            return True
    return False


class _SafeRedirectHandler(HTTPRedirectHandler):
    def __init__(self, client: "Client"):
        self.client = client
        super().__init__()

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        target_url = urljoin(request.full_url, newurl)
        self.client._validate_target(target_url)
        if urlsplit(request.full_url).scheme.lower() != urlsplit(target_url).scheme.lower():
            raise ClientError("TARGET_NOT_ALLOWED", "Redirect changes scheme while credentials are attached.", recoverable=False)
        redirected = super().redirect_request(request, fp, code, msg, headers, target_url)
        if redirected is None:
            return None
        for collection in (redirected.headers, redirected.unredirected_hdrs):
            for name in tuple(collection):
                if name.lower() in {"authorization", "cookie", "proxy-authorization"}:
                    collection.pop(name, None)
        for name, value in self.client._credential_headers(target_url).items():
            redirected.add_unredirected_header(name, value)
        for name, value in self.client._default_headers_for(target_url).items():
            redirected.add_unredirected_header(name, value)
        return redirected


class Client:
    def __init__(
        self,
        config: Config,
        *,
        auth_resolver: AuthResolver | None = None,
        force_refresh_auth: bool = False,
        extra_headers: dict[str, str] | None = None,
    ):
        self.config = config
        self.auth_resolver = auth_resolver
        self.force_refresh_auth = force_refresh_auth
        self.extra_headers = dict(extra_headers or {})
        self.logger = redacting_logger(config.secrets)
        self.auth_metadata: dict[str, Any] = dict(config.auth_status)

    # ------------------------------------------------------------------
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
        ):
            raise ClientError("TARGET_NOT_ALLOWED", "Target URL is not permitted.", recoverable=False)
        if self.config.allowed_hosts and not (loopback or _host_matches_allowlist(host, self.config.allowed_hosts)):
            raise ClientError(
                "TARGET_NOT_ALLOWED",
                f"Target host {host!r} is not in manifest.auth.target_urls allowlist {list(self.config.allowed_hosts)}.",
                recoverable=False,
            )

    def _credential_headers(self, target_url: str) -> dict[str, str]:
        if self.auth_resolver is None or self.config.auth_strategy == "none":
            return {}
        try:
            session = self.auth_resolver.resolve(target_url, force_refresh=self.force_refresh_auth)
            self.force_refresh_auth = False
            self.auth_metadata = session.metadata()
        except AuthError as error:
            raise ClientError(error.code, str(error), recoverable=error.recoverable) from None
        return {"Cookie": session.cookie_header} if session.cookie_header else {}

    def _default_headers_for(self, target_url: str) -> dict[str, str]:
        merged: dict[str, str] = {}
        merged.update(self.config.default_headers)
        host = (urlsplit(target_url).hostname or "").lower()
        for candidate_host, headers in self.config.per_host_headers.items():
            if host == candidate_host or host.endswith("." + candidate_host):
                merged.update(headers)
        merged.update(self.extra_headers)
        return merged

    # ------------------------------------------------------------------
    def request(
        self,
        method: str,
        path_or_url: str,
        body: Any = None,
        *,
        headers: dict[str, str] | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        if os.environ.get("BROWSER_FORGE_DISABLE_NETWORK") == "1":
            raise ClientError("NETWORK_DISABLED", "Network access is disabled by BROWSER_FORGE_DISABLE_NETWORK.")

        target_url = path_or_url if path_or_url.startswith(("http://", "https://")) else _join(self.config.base_url, path_or_url)
        if not target_url:
            raise ClientError("INVALID_CONFIGURATION", "BROWSER_FORGE_BASE_URL is required for relative paths.")
        if params:
            from urllib.parse import urlencode, urlsplit, urlunsplit
            parts = urlsplit(target_url)
            existing = parts.query
            extra = urlencode({str(k): str(v) for k, v in params.items()})
            new_query = "&".join(filter(None, [existing, extra]))
            target_url = urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))

        self._validate_target(target_url)

        request_headers: dict[str, str] = {"Accept": "application/json"}
        request_headers.update(self._default_headers_for(target_url))
        request_headers.update(self._credential_headers(target_url))
        if headers:
            request_headers.update({str(k): str(v) for k, v in headers.items()})

        encoded_body = None
        if body is not None:
            encoded_body = json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
            request_headers.setdefault("Content-Type", "application/json")

        req = Request(target_url, data=encoded_body, headers=request_headers, method=method)
        self.logger.debug("Requesting %s %s", method, req.full_url)
        try:
            with build_opener(_SafeRedirectHandler(self)).open(req, timeout=30) as response:
                payload = response.read().decode("utf-8")
        except HTTPError as error:
            body_snippet = _safe_read(error)
            if error.code == 401 or error.code == 403:
                raise ClientError("AUTH_REFRESH_REQUIRED", f"HTTP {error.code}: {body_snippet[:200]}") from error
            raise ClientError("HTTP_ERROR", f"HTTP {error.code}: {body_snippet[:200]}") from error
        except URLError as error:
            raise ClientError("NETWORK_ERROR", f"Network request failed: {error.reason}") from error
        except TimeoutError as error:
            raise ClientError("REQUEST_TIMEOUT", "Network request timed out.") from error
        except UnicodeDecodeError as error:
            raise ClientError("INVALID_RESPONSE", "Remote service returned invalid UTF-8.") from error

        parsed = _parse_json(payload)

        if isinstance(parsed, dict) and "sso_redirect_url" in parsed and "code" not in parsed:
            if self.auth_resolver is not None:
                self.auth_resolver.invalidate(target_url)
            raise ClientError(
                "AUTH_REFRESH_REQUIRED",
                "Backend BFF returned an SSO redirect stub; the session cookie is expired.",
            )

        return parsed


def _join(base: str, path: str) -> str:
    if not base:
        return ""
    return urljoin(base.rstrip("/") + "/", path.lstrip("/"))


def _safe_read(error: HTTPError) -> str:
    try:
        return error.read().decode("utf-8", "replace")
    except Exception:
        return ""


def _parse_json(payload: str) -> Any:
    if not payload:
        return None
    try:
        return json.loads(payload)
    except json.JSONDecodeError as error:
        raise ClientError("INVALID_RESPONSE", "Remote service returned invalid JSON.") from error
