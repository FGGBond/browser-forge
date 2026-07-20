"""Small HTTP client shell with mandatory secret redaction."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .config import Config


class AuthSessionLike(Protocol):
    def cookie_header(self, url: str | None = None, *, now: float | None = None) -> str: ...


class AuthResolverLike(Protocol):
    def resolve(self, target_url: str, force_refresh: bool = False) -> AuthSessionLike: ...


class ClientError(RuntimeError):
    def __init__(self, code: str, message: str, recoverable: bool = True):
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable


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

    def request(self, method: str, path: str) -> Any:
        if os.environ.get("BROWSER_FORGE_" "DISABLE_NETWORK") == "1":
            raise ClientError("NETWORK_DISABLED", "Network access is disabled by BROWSER_FORGE_" "DISABLE_NETWORK.")
        if not self.config.base_url:
            raise ClientError("INVALID_CONFIGURATION", "BROWSER_FORGE_BASE_URL is required.")

        target_url = f"{self.config.base_url}/{path.lstrip('/')}"
        headers = {"Accept": "application/json"}
        if self.config.auth_value:
            headers["Authorization"] = self.config.auth_value
        if self.config.cookie_value:
            headers["Cookie"] = self.config.cookie_value
        if self.auth_resolver is not None:
            try:
                session = self.auth_resolver.resolve(
                    target_url,
                    force_refresh=self.force_refresh_auth,
                )
                self.force_refresh_auth = False
                cookie_header = session.cookie_header(target_url)
            except Exception as error:
                raise ClientError(
                    getattr(error, "code", "AUTH_UNAVAILABLE"),
                    str(error),
                    getattr(error, "recoverable", True),
                ) from None
            if cookie_header:
                headers["Cookie"] = cookie_header
        request = Request(target_url, headers=headers, method=method)
        self.logger.debug("Requesting %s %s", method, request.full_url)
        try:
            with urlopen(request, timeout=30) as response:  # noqa: S310 - generated allowlisted client shell
                payload = response.read().decode("utf-8")
        except HTTPError as error:
            raise ClientError("HTTP_ERROR", f"Remote service returned HTTP {error.code}.") from error
        except URLError as error:
            raise ClientError("NETWORK_ERROR", f"Network request failed: {error.reason}") from error
        try:
            return json.loads(payload) if payload else None
        except json.JSONDecodeError as error:
            raise ClientError("INVALID_RESPONSE", "Remote service returned invalid JSON.") from error
