"""Runtime for the generated Browser Forge skill.

Imports a stable alias ``browser_forge_generated`` regardless of the actual
package name, so handler modules and reference docs can use::

    from browser_forge_generated.handler import command

without knowing the skill's package name.
"""

import sys as _sys

from .cli import build_parser, main
from .envelope import failure, success

_sys.modules.setdefault("browser_forge_generated", _sys.modules[__name__])
for _sub in ("cli", "envelope", "manifest", "config", "http", "auth", "handler", "telemetry"):
    _mod_name = f"{__name__}.{_sub}"
    if _mod_name in _sys.modules:
        _sys.modules.setdefault(f"browser_forge_generated.{_sub}", _sys.modules[_mod_name])

__all__ = ["build_parser", "failure", "main", "success"]
__version__ = "0.1.0"
