"""Manifest-driven command-line interface."""

from __future__ import annotations

import argparse
import json
import platform
import re
import sys
import time
from typing import Any, NoReturn

from .auth.provider import AuthResolver
from .client import Client, ClientError
from .config import load_config
from .envelope import failure, success
from .manifest import load_manifest, manifest_path
from .telemetry import UsageTelemetry

BUILTIN_COMMANDS = {"doctor", "auth-status", "describe"}


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
        command["id"]: command
        for command in manifest.get("commands", [])
        if isinstance(command, dict) and isinstance(command.get("id"), str)
    }


def _source_help(input_spec: dict[str, Any]) -> str:
    sources = []
    for source in input_spec.get("sources", []):
        command = source.get("command")
        if not command:
            continue
        json_path = source.get("json_path")
        sources.append(f"{command} -> {json_path}" if json_path else command)
    return f"Obtain from: {', '.join(sources)}" if sources else "Provide directly."


def _input_converter(type_name: str):
    normalized = type_name.lower()
    if normalized in {"integer", "int"}:
        return int
    if normalized in {"number", "float"}:
        return float
    if normalized in {"object", "array", "json"}:
        return json.loads
    return str


def _format_next_actions(command: dict[str, Any]) -> str:
    actions = command.get("next_actions", [])
    if not actions:
        return "None"
    return "\n".join(
        f"  {action.get('command', 'unknown')}"
        + (f" ({', '.join(f'{key}={value}' for key, value in action.get('bindings', {}).items())})" if action.get("bindings") else "")
        for action in actions
    )


def _epilog(command: dict[str, Any], manifest: dict[str, Any]) -> str:
    requires = command.get("requires", {})
    dependencies = requires.get("commands", [])
    auth = manifest.get("auth", {})
    providers = auth.get("providers", [])
    inputs = " ".join(f"--{item['name'].replace('_', '-')} VALUE" for item in command.get("inputs", []))
    entrypoint = manifest.get("cli", {}).get("entrypoint", "browser-forge").split("/")[-1]
    return "\n".join([
        "Dependencies:",
        f"  {', '.join(dependencies) if dependencies else 'None'}",
        "Authentication:",
        f"  {'Required' if requires.get('auth') else 'Not required'}"
        + (f" ({', '.join(providers)})" if providers else ""),
        "Output:",
        f"  {command.get('outputs', {}).get('schema_ref', 'Unspecified')}",
        "Next actions:",
        _format_next_actions(command),
        "Side effects:",
        f"  {'Yes' if command.get('side_effect') else 'No'}"
        + (f"; dry-run={command.get('safety', {}).get('dry_run')}; "
           f"retry-risk={command.get('safety', {}).get('retry_risk')}; "
           f"verification={command.get('safety', {}).get('verification')}"
           if command.get("side_effect") else ""),
        "Idempotency:",
        f"  {'Idempotent' if command.get('idempotent') else 'Not idempotent'}",
        "Examples:",
        f"  {entrypoint} {command.get('id', '')}{(' ' + inputs) if inputs else ''}",
    ])


def _fallback_command(command_id: str, summary: str) -> dict[str, Any]:
    return {
        "id": command_id,
        "summary": summary,
        "side_effect": False,
        "idempotent": True,
        "inputs": [],
        "outputs": {"schema_ref": "#/$defs/unknown-output"},
        "requires": {"auth": False, "commands": []},
        "next_actions": [],
        "steps": [],
    }


def build_parser(manifest: dict[str, Any]) -> EnvelopeArgumentParser:
    parser = EnvelopeArgumentParser(prog=manifest.get("cli", {}).get("entrypoint", "browser-forge").split("/")[-1])
    parser.description = manifest.get("description") or manifest.get("name") or "Generated Browser Forge skill"
    subparsers = parser.add_subparsers(dest="selected_command", required=True, parser_class=EnvelopeArgumentParser)
    commands = _command_map(manifest)
    builtins = {
        "doctor": _fallback_command("doctor", "Checks local prerequisites."),
        "auth-status": _fallback_command("auth-status", "Reports redacted authentication status."),
        "describe": _fallback_command("describe", "Describes the generated command contract."),
    }
    for command_id, fallback in builtins.items():
        commands.setdefault(command_id, fallback)

    for command in commands.values():
        command_id = command["id"]
        subparser = subparsers.add_parser(
            command_id,
            help=command.get("summary"),
            description=command.get("summary"),
            epilog=_epilog(command, manifest),
            formatter_class=getattr(argparse, "RawDescription" "HelpFormatter"),
            command_id=command_id,
        )
        subparser.set_defaults(command_spec=command)
        if command_id == "describe":
            subparser.add_argument("described_command", nargs="?", help="Command ID to describe")
            continue
        if command.get("requires", {}).get("auth"):
            subparser.add_argument(
                "--refresh-auth",
                action="store_true",
                help="Discard the cached authentication session before this command.",
            )
        for input_spec in command.get("inputs", []):
            option = f"--{input_spec['name'].replace('_', '-')}"
            kwargs: dict[str, Any] = {
                "dest": input_spec["name"],
                "required": bool(input_spec.get("required")),
                "help": _source_help(input_spec),
            }
            if input_spec.get("type", "").lower() in {"boolean", "bool"}:
                kwargs["action"] = argparse.BooleanOptionalAction
            else:
                kwargs["type"] = _input_converter(input_spec.get("type", "string"))
            subparser.add_argument(option, **kwargs)
    return parser


def _next_actions(command: dict[str, Any]) -> list[dict[str, Any]]:
    return [action for action in command.get("next_actions", []) if isinstance(action, dict)]


def _build_auth_resolver(manifest: dict[str, Any]):
    """Build the provider behind the resolver seam consumed by the client."""

    providers = manifest.get("auth", {}).get("providers", [])
    if not providers:
        return None
    return AuthResolver(
        str(manifest.get("id", "browser-forge")),
        allowed_domains=tuple(manifest.get("auth", {}).get("target_domains", [])),
        providers=tuple(providers),
    )


def _substitute(value: Any, values: dict[str, Any]) -> Any:
    if isinstance(value, str):
        for name, replacement in values.items():
            value = value.replace("{" + name + "}", str(replacement))
        return value
    if isinstance(value, list):
        return [_substitute(item, values) for item in value]
    if isinstance(value, dict):
        return {key: _substitute(item, values) for key, item in value.items()}
    return value


def _execute_business(command: dict[str, Any], values: dict[str, Any], client: Client) -> Any:
    results: dict[str, Any] = {}
    completed: set[str] = set()
    for step in command.get("steps", []):
        step_id = step.get("id")
        if not isinstance(step_id, str) or not step_id or step_id in completed:
            raise ClientError("INVALID_MANIFEST", "Request step IDs must be unique.", recoverable=False)
        dependencies = step.get("depends_on", [])
        if not isinstance(dependencies, list) or any(dependency not in completed for dependency in dependencies):
            raise ClientError(
                "INVALID_MANIFEST",
                f"Request step dependencies must refer to completed steps: {step_id}",
                recoverable=False,
            )
        request = step.get("request", "")
        match = re.fullmatch(r"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (/\S*)", request)
        if not match:
            raise ClientError("INVALID_MANIFEST", f"Invalid request step: {request}", recoverable=False)
        method, path = match.groups()
        path = _substitute(path, values)
        body = _substitute(step.get("body"), values) if "body" in step else None
        results[step_id] = client.request(method, path, body)
        completed.add(step_id)
    output = results[next(reversed(results))] if results else None
    return {"steps": results, "output": output}


def _auth_status(manifest: dict[str, Any], config) -> dict[str, Any]:
    resolver = _build_auth_resolver(manifest)
    if resolver is None or not config.base_url:
        return config.auth_status
    try:
        return resolver.resolve(config.base_url).metadata()
    except Exception as error:
        result = dict(config.auth_status)
        result.update({
            "error_code": getattr(error, "code", "AUTH_UNAVAILABLE"),
            "recoverable": getattr(error, "recoverable", True),
        })
        attempted = getattr(error, "attempted_providers", None)
        remediation = getattr(error, "remediation", None)
        if attempted is not None:
            result["attempted_providers"] = list(attempted)
        if remediation:
            result["remediation"] = remediation
        return result


def main(argv: list[str] | None = None) -> int:
    try:
        manifest = load_manifest()
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
    started_at = time.monotonic()
    try:
        config = load_config(manifest)
        if command_id == "doctor":
            resolver = _build_auth_resolver(manifest)
            _emit(success(command_id, {
                "python_version": platform.python_version(),
                "manifest_path": str(manifest_path()),
                "network_disabled": __import__("os").environ.get("BROWSER_FORGE_" "DISABLE_NETWORK") == "1",
                "authentication": resolver.doctor() if resolver is not None else {
                    "attempted_providers": [],
                    "remediation": "Configure an authentication provider in manifest.json.",
                },
            }))
            telemetry.track_command(command_id, ok=True, status="success", duration_ms=int((time.monotonic() - started_at) * 1000))
            return 0
        if command_id == "auth-status":
            auth = _auth_status(manifest, config)
            _emit(success(command_id, auth, auth=auth))
            telemetry.track_command(command_id, ok=True, status="success", duration_ms=int((time.monotonic() - started_at) * 1000))
            return 0
        if command_id == "describe":
            target_id = args.described_command
            if target_id is None:
                _emit(success(command_id, {"manifest": manifest}))
                telemetry.track_command(command_id, ok=True, status="success", duration_ms=int((time.monotonic() - started_at) * 1000))
                return 0
            target = _command_map(manifest).get(target_id)
            if target is None:
                _emit(failure(command_id, "INVALID_ARGUMENT", f"Unknown command: {target_id}", recoverable=True))
                telemetry.track_command(command_id, ok=False, status="failure", duration_ms=int((time.monotonic() - started_at) * 1000), error_code="INVALID_ARGUMENT")
                return 2
            _emit(success(command_id, {"command": target}, next_actions=_next_actions(target)))
            telemetry.track_command(command_id, ok=True, status="success", duration_ms=int((time.monotonic() - started_at) * 1000))
            return 0

        values = {
            input_spec["name"]: getattr(args, input_spec["name"])
            for input_spec in command.get("inputs", [])
        }
        requires_auth = bool(command.get("requires", {}).get("auth"))
        auth_resolver = _build_auth_resolver(manifest) if requires_auth else None
        client = Client(
            config,
            auth_resolver=auth_resolver,
            force_refresh_auth=getattr(args, "refresh_auth", False),
        )
        data = _execute_business(
            command,
            values,
            client,
        )
    except ClientError as error:
        _emit(failure(command_id, error.code, str(error), error.recoverable, _next_actions(command)))
        telemetry.track_command(command_id, ok=False, status="failure", duration_ms=int((time.monotonic() - started_at) * 1000), error_code=error.code)
        return 1
    except Exception:
        _emit(failure(
            command_id,
            "INTERNAL_ERROR",
            "The command failed unexpectedly.",
            recoverable=False,
            next_actions=_next_actions(command),
        ))
        telemetry.track_command(command_id, ok=False, status="failure", duration_ms=int((time.monotonic() - started_at) * 1000), error_code="INTERNAL_ERROR")
        return 1
    _emit(success(command_id, data, auth=client.auth_metadata, next_actions=_next_actions(command)))
    telemetry.track_command(command_id, ok=True, status="success", duration_ms=int((time.monotonic() - started_at) * 1000))
    return 0
