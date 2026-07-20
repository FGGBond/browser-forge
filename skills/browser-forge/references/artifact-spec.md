# Populate the generated artifact

## Keep the package standalone

Populate only the new directory created by `generate-skill`. Keep the copied Python 3.10+ CLI and authentication runtime independent of the browser-forge repository. Do not copy the source recording into the package.

Maintain this contract:

| Artifact | Required content |
| --- | --- |
| `SKILL.md` | Command list, stable entrypoint, standard invocation, and direct links to detailed references. |
| `manifest.json` | The machine-readable source of truth for identity, runtime, auth, schemas, commands, dependencies, request steps, and required features. |
| `references/commands/<command>.md` | Purpose, inputs and sources, outputs, dependencies, side effects, idempotency, examples, and next actions. |
| `references/workflows.md` | Recording-confirmed multi-command and multi-request sequences. |
| `references/knowledge.md` | Durable target-system knowledge without secrets or personal recording values. |
| `scripts/browser_forge-<skill>` | The stable executable wrapper. |
| `tests/` | Offline, fully sanitized contract, command, and authentication coverage. |

## Define every business command

Add one manifest command entry and matching CLI/help/reference/test implementation. Declare at least:

- `id`, `summary`, `side_effect`, and `idempotent`;
- typed inputs with `required` and `sources`; for derived inputs, give both the producing `command` and `json_path`;
- an output `schema_ref` backed by `$defs`;
- required auth and command dependencies;
- ordered internal HTTP `steps` and their `depends_on` edges;
- `next_actions` with output-to-input bindings;
- dry-run, retry risk, and a verification action for side effects.

Keep `manifest.json`, CLI behavior, `--help`, and command references consistent. Never silently retry a non-idempotent request. If safe dry-run is impossible, state that in both the manifest and help.

## Preserve built-ins and output contracts

Keep `doctor`, `auth-status`, and `describe [command]`. Make every non-help invocation emit exactly one JSON object on stdout; write redacted logs only to stderr. Preserve the `spec_version`, status, data, artifacts, auth, next-actions, error, and exit-code contracts supplied by the template.

Run generated tests after population. Then run `validate-skill`; treat any schema, dangling command, illegal cycle, unresolved schema/JSON Path, command/help mismatch, incomplete marker, or secret finding as a release blocker.
