"""Handler registry for business commands.

Business commands live in ``commands/<module>.py`` and register themselves via
the :func:`command` decorator::

    from browser_forge_generated.handler import command

    @command("swap-rota")
    def run(inputs, ctx):
        job = ctx.http("GET", f"/api/foo/{inputs['job_id']}")
        ...
        return {"status": "updated"}

``ctx`` is an :class:`HandlerContext` exposing an HTTP client bound to the
manifest's auth and default headers, a redacting logger, plus a ``dry_run``
flag. The return value becomes the ``data`` field of the JSON envelope.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from dataclasses import dataclass
from typing import Any, Callable

from .http import Client, ClientError

Handler = Callable[[dict[str, Any], "HandlerContext"], Any]

_REGISTRY: dict[str, Handler] = {}


def command(command_id: str) -> Callable[[Handler], Handler]:
    def decorator(fn: Handler) -> Handler:
        _REGISTRY[command_id] = fn
        return fn
    return decorator


def get(command_id: str) -> Handler | None:
    return _REGISTRY.get(command_id)


def registered_ids() -> tuple[str, ...]:
    return tuple(sorted(_REGISTRY.keys()))


def load_all(package_name: str) -> None:
    """Import every submodule of ``<package>.commands`` so decorators run."""

    try:
        package = importlib.import_module(f"{package_name}.commands")
    except ModuleNotFoundError:
        return
    if not hasattr(package, "__path__"):
        return
    for module_info in pkgutil.iter_modules(package.__path__):
        importlib.import_module(f"{package_name}.commands.{module_info.name}")


@dataclass
class HandlerContext:
    client: Client
    logger: logging.Logger
    dry_run: bool = False
    inputs: dict[str, Any] | None = None
    auth_metadata: dict[str, Any] | None = None

    def http(self, method: str, path_or_url: str, body: Any = None, **kwargs: Any) -> Any:
        try:
            return self.client.request(method, path_or_url, body, **kwargs)
        finally:
            self.auth_metadata = self.client.auth_metadata


class HandlerError(RuntimeError):
    def __init__(self, code: str, message: str, *, recoverable: bool = True, data: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable
        self.data = data


__all__ = ["command", "get", "registered_ids", "load_all", "HandlerContext", "HandlerError", "ClientError"]
