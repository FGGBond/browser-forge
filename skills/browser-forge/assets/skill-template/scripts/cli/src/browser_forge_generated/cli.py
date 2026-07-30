"""Manifest-driven command-line interface for a generated Browser Forge skill.

Command execution has two paths:

* If a manifest command declares ``handler: "<module>:<function>"``, the CLI
  imports that function from ``commands/<module>.py`` and calls it with
  ``(inputs, ctx)``. This is the path for anything with branching, state
  lookup, or verification.
* Otherwise the CLI runs the declared ``steps`` list — ordered HTTP requests
  with simple ``{placeholder}`` substitution — for straight-through CRUD.

Every non-help invocation prints exactly one JSON envelope to stdout.
Logs go to stderr through a redacting filter.
"""

from __future__ import annotations

import argparse
import importlib
import json
import platform
import re
import sys
import time
from typing import Any, NoReturn

from .auth import AuthError, AuthResolver, summarize_error
from .config import load_config
from .envelope import failure, success
from .handler import HandlerContext, HandlerError, get as get_handler, load_all as load_handlers, registered_ids
from .http import Client, ClientError, redacting_logger
from .manifest import load_manifest, manifest_path
from .telemetry import UsageTelemetry

BUILTIN_COMMANDS = {"doctor", "auth-status", "describe"}
PACKAGE_NAME = __package__ or "browser_forge_generated"


def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))


class EnvelopeArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args: Any, command_id: str | None = None, **kwargs: Any):
        self.command_id = command_id
        super().__init__(*args, **kwargs)

    def error(self, message: str) -> NoReturn:
        _emit(failure(self.command_id, "INVALID_ARGUMENT", message, recoverable=True))
        raise SystemExit(2)


def _command_map(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        c["id"]: c for c in manifest.get("commands", [])
        if isinstance(c, dict) and isinstance(c.get("id"), str)
    }


def _fallback(command_id: str, summary: str) -> dict[str, Any]:
    return {
        "id": command_id,
        "summary": summary,
        "side_effect": False,
        "idempotent": True,
        "inputs": [],
        "outputs": {"schema_ref": "#/$defs/unknown-output"},
        "requires": {"auth": False, "commands": []},
        "next_actions": [],
    }


def _input_converter(type_name: str):
    normalized = type_name.lower()
    if normalized in {"integer", "int"}:
        return int
    if normalized in {"number", "float"}:
        return float
    if normalized in {"object", "array", "json"}:
        return json.loads
    return str


def _source_help(input_spec: dict[str, Any]) -> str:
    sources = []
    for source in input_spec.get("sources", []) or []:
        cmd = source.get("command")
        if not cmd:
            continue
        path = source.get("json_path")
        sources.append(f"{cmd} -> {path}" if path else cmd)
    return f"Obtain from: {', '.join(sources)}" if sources else "Provide directly."


def _epilog(command: dict[str, Any], manifest: dict[str, Any]) -> str:
    requires = command.get("requires", {}) or {}
    dependencies = requires.get("commands", []) or []
    auth = manifest.get("auth", {}) or {}
    strategy = auth.get("strategy", "none")
    inputs = " ".join(f"--{item['name'].replace('_', '-')} VALUE" for item in command.get("inputs", []) or [])
    entrypoint = manifest.get("cli", {}).get("entrypoint", "browser-forge").split("/")[-1]
    handler = command.get("handler")
    exec_mode = "handler" if handler else ("steps" if command.get("steps") else "builtin")
    lines = [
        "Dependencies:",
        f"  {', '.join(dependencies) if dependencies else 'None'}",
        "Authentication:",
        f"  {'Required' if requires.get('auth') else 'Not required'} (strategy={strategy})",
        "Output:",
        f"  {command.get('outputs', {}).get('schema_ref', 'Unspecified')}",
        "Next actions:",
        _format_next_actions(command),
        "Side effects:",
        f"  {'Yes' if command.get('side_effect') else 'No'}"
        + (
            f"; dry-run={command.get('safety', {}).get('dry_run')}; "
            f"retry-risk={command.get('safety', {}).get('retry_risk')}; "
            f"verification={command.get('safety', {}).get('verification')}"
            if command.get("side_effect") else ""
        ),
        "Idempotency:",
        f"  {'Idempotent' if command.get('idempotent') else 'Not idempotent'}",
        "Execution:",
        f"  {exec_mode}" + (f" ({handler})" if handler else ""),
        "Examples:",
        f"  {entrypoint} {command.get('id', '')}{(' ' + inputs) if inputs else ''}",
    ]
    return "\n".join(lines)


def _format_next_actions(command: dict[str, Any]) -> str:
    actions = command.get("next_actions", []) or []
    if not actions:
        return "  None"
    return "\n".join(
        f"  {action.get('command', 'unknown')}"
        + (f" ({', '.join(f'{k}={v}' for k, v in action.get('bindings', {}).items())})" if action.get("bindings") else "")
        for action in actions
    )


def build_parser(manifest: dict[str, Any]) -> EnvelopeArgumentParser:
    parser = EnvelopeArgumentParser(prog=manifest.get("cli", {}).get("entrypoint", "browser-forge").split("/")[-1])
    parser.description = manifest.get("description") or manifest.get("name") or "Generated Browser Forge skill"
    subparsers = parser.add_subparsers(dest="selected_command", required=True, parser_class=EnvelopeArgumentParser)
    commands = _command_map(manifest)
    for command_id, summary in [
        ("doctor", "Checks local prerequisites."),
        ("auth-status", "Reports redacted authentication status."),
        ("describe", "Describes the generated command contract."),
    ]:
        commands.setdefault(command_id, _fallback(command_id, summary))

    for cmd in commands.values():
        command_id = cmd["id"]
        subparser = subparsers.add_parser(
            command_id,
            help=cmd.get("summary"),
            description=cmd.get("summary"),
            epilog=_epilog(cmd, manifest),
            formatter_class=argparse.RawDescriptionHelpFormatter,
            command_id=command_id,
        )
        subparser.set_defaults(command_spec=cmd)
        if command_id == "describe":
            subparser.add_argument("described_command", nargs="?")
            continue
        if cmd.get("requires", {}).get("auth"):
            subparser.add_argument("--refresh-auth", action="store_true",
                                   help="Discard cached authentication before this command.")
        if cmd.get("side_effect") and (cmd.get("safety") or {}).get("dry_run") == "supported":
            subparser.add_argument("--dry-run", action="store_true",
                                   help="Preview changes without performing side effects.")
        for input_spec in cmd.get("inputs", []) or []:
            option = f"--{input_spec['name'].replace('_', '-')}"
            kwargs: dict[str, Any] = {
                "dest": input_spec["name"],
                "required": bool(input_spec.get("required")),
                "help": _source_help(input_spec),
            }
            if not kwargs["required"] and "default" in input_spec:
                kwargs["default"] = input_spec["default"]
            if input_spec.get("type", "").lower() in {"boolean", "bool"}:
                kwargs["action"] = argparse.BooleanOptionalAction
            else:
                kwargs["type"] = _input_converter(input_spec.get("type", "string"))
            subparser.add_argument(option, **kwargs)
    return parser


def _next_actions(command: dict[str, Any]) -> list[dict[str, Any]]:
    return [a for a in command.get("next_actions", []) or [] if isinstance(a, dict)]


def _build_resolver(manifest: dict[str, Any], config) -> AuthResolver | None:
    strategy = manifest.get("auth", {}).get("strategy", "none")
    if strategy == "none":
        return None
    return AuthResolver(strategy, required_cookies=config.required_cookies)


def _substitute(value: Any, values: dict[str, Any]) -> Any:
    if isinstance(value, str):
        for name, replacement in values.items():
            value = value.replace("{" + name + "}", str(replacement))
        return value
    if isinstance(value, list):
        return [_substitute(item, values) for item in value]
    if isinstance(value, dict):
        return {k: _substitute(v, values) for k, v in value.items()}
    return value


def _execute_steps(command: dict[str, Any], values: dict[str, Any], client: Client) -> dict[str, Any]:
    results: dict[str, Any] = {}
    completed: set[str] = set()
    for step in command.get("steps", []) or []:
        step_id = step.get("id")
        if not isinstance(step_id, str) or not step_id or step_id in completed:
            raise ClientError("INVALID_MANIFEST", "Step IDs must be unique.", recoverable=False)
        for dep in step.get("depends_on", []) or []:
            if dep not in completed:
                raise ClientError("INVALID_MANIFEST", f"Step {step_id} depends on unknown step {dep}.", recoverable=False)
        request = step.get("request", "")
        match = re.fullmatch(r"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (/\S*)", request)
        if not match:
            raise ClientError("INVALID_MANIFEST", f"Invalid step request: {request}", recoverable=False)
        method, path = match.groups()
        path = _substitute(path, values)
        body = _substitute(step.get("body"), values) if "body" in step else None
        results[step_id] = client.request(method, path, body)
        completed.add(step_id)
    output = results[next(reversed(results))] if results else None
    return {"steps": results, "output": output}


def _execute_handler(command: dict[str, Any], values: dict[str, Any], client: Client, dry_run: bool) -> Any:
    handler_ref = command.get("handler")
    handler = get_handler(command["id"]) if handler_ref else None
    if handler is None and handler_ref:
        module_name, _, fn_name = handler_ref.partition(":")
        try:
            module = importlib.import_module(f"{PACKAGE_NAME}.commands.{module_name}")
        except ModuleNotFoundError as error:
            raise ClientError("HANDLER_NOT_FOUND",
                              f"handler module '{module_name}' not importable: {error}",
                              recoverable=False) from None
        handler = getattr(module, fn_name, None) or get_handler(command["id"])
    if handler is None:
        raise ClientError("HANDLER_NOT_FOUND", f"No handler registered for {command['id']}", recoverable=False)
    ctx = HandlerContext(
        client=client,
        logger=redacting_logger(client.config.secrets),
        dry_run=dry_run,
        inputs=values,
        auth_metadata=client.auth_metadata,
    )
    return handler(values, ctx)


def _auth_status(manifest: dict[str, Any], config) -> dict[str, Any]:
    resolver = _build_resolver(manifest, config)
    base = dict(config.auth_status)
    if resolver is None:
        base["resolved"] = True
        return base
    target = config.target_urls[0] if config.target_urls else config.base_url
    if not target:
        base["error_code"] = "AUTH_TARGET_UNKNOWN"
        base["message"] = "No target URL configured."
        return base
    try:
        session = resolver.resolve(target)
        return {**base, **session.metadata()}
    except AuthError as error:
        return {**base, **summarize_error(error)}


def main(argv: list[str] | None = None) -> int:
    try:
        manifest = load_manifest()
        load_handlers(PACKAGE_NAME)
        parser = build_parser(manifest)
        args = parser.parse_args(argv)
    except SystemExit:
        raise
    except Exception as error:
        _emit(failure(None, "INVALID_MANIFEST", str(error), recoverable=False))
        return 1

    command_id = args.selected_command
    command = args.command_spec
    telemetry = UsageTelemetry.from_environment(manifest)
    started = time.monotonic()

    try:
        config = load_config(manifest)

        if command_id == "doctor":
            resolver = _build_resolver(manifest, config)
            _emit(success(command_id, {
                "python_version": platform.python_version(),
                "manifest_path": str(manifest_path()),
                "network_disabled": __import__("os").environ.get("BROWSER_FORGE_DISABLE_NETWORK") == "1",
                "auth_strategy": config.auth_strategy,
                "auth_doctor": resolver.doctor() if resolver else {"strategy": "none", "providers": []},
                "default_headers": list(config.default_headers.keys()),
                "target_urls": list(config.target_urls),
                "registered_handlers": list(registered_ids()),
            }))
            telemetry.track_command(command_id, ok=True, status="success", duration_ms=int((time.monotonic() - started) * 1000))
            return 0

        if command_id == "auth-status":
            auth = _auth_status(manifest, config)
            _emit(success(command_id, auth, auth=auth))
            telemetry.track_command(command_id, ok=True, status="success", duration_ms=int((time.monotonic() - started) * 1000))
            return 0

        if command_id == "describe":
            target_id = args.described_command
            if target_id is None:
                _emit(success(command_id, {"manifest": manifest, "registered_handlers": list(registered_ids())}))
                telemetry.track_command(command_id, ok=True, status="success", duration_ms=int((time.monotonic() - started) * 1000))
                return 0
            target = _command_map(manifest).get(target_id)
            if target is None:
                _emit(failure(command_id, "INVALID_ARGUMENT", f"Unknown command: {target_id}", recoverable=True))
                telemetry.track_command(command_id, ok=False, status="failure", duration_ms=int((time.monotonic() - started) * 1000), error_code="INVALID_ARGUMENT")
                return 2
            _emit(success(command_id, {"command": target}, next_actions=_next_actions(target)))
            telemetry.track_command(command_id, ok=True, status="success", duration_ms=int((time.monotonic() - started) * 1000))
            return 0

        values = {
            i["name"]: getattr(args, i["name"], i.get("default"))
            for i in command.get("inputs", []) or []
        }
        requires_auth = bool(command.get("requires", {}).get("auth"))
        resolver = _build_resolver(manifest, config) if requires_auth else None
        dry_run = bool(getattr(args, "dry_run", False))
        client = Client(
            config,
            auth_resolver=resolver,
            force_refresh_auth=getattr(args, "refresh_auth", False),
        )

        if command.get("handler"):
            data = _execute_handler(command, values, client, dry_run)
        elif command.get("steps"):
            data = _execute_steps(command, values, client)
        else:
            raise ClientError("INVALID_MANIFEST", f"Command {command_id!r} has neither handler nor steps.", recoverable=False)

    except HandlerError as error:
        _emit(failure(command_id, error.code, str(error), error.recoverable, _next_actions(command)))
        telemetry.track_command(command_id, ok=False, status="failure", duration_ms=int((time.monotonic() - started) * 1000), error_code=error.code)
        return 1
    except ClientError as error:
        _emit(failure(command_id, error.code, str(error), error.recoverable, _next_actions(command)))
        telemetry.track_command(command_id, ok=False, status="failure", duration_ms=int((time.monotonic() - started) * 1000), error_code=error.code)
        return 1
    except Exception as error:  # pragma: no cover - defensive
        _emit(failure(command_id, "INTERNAL_ERROR", f"The command failed unexpectedly: {type(error).__name__}", recoverable=False, next_actions=_next_actions(command)))
        telemetry.track_command(command_id, ok=False, status="failure", duration_ms=int((time.monotonic() - started) * 1000), error_code="INTERNAL_ERROR")
        return 1

    _emit(success(command_id, data, auth=client.auth_metadata, next_actions=_next_actions(command)))
    telemetry.track_command(command_id, ok=True, status="success", duration_ms=int((time.monotonic() - started) * 1000))
    return 0
