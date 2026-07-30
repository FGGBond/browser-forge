# Populate the generated skill

## Keep the framework thin

The generator writes a self-contained Python package under
`scripts/cli/src/<pkg>/`. Do not modify these framework files after
generation (validator will refuse them):

- `cli.py`, `envelope.py`, `manifest.py`, `config.py`, `http.py`, `auth.py`,
  `handler.py`, `telemetry.py`, `__init__.py`, `__main__.py`,
  `commands/__init__.py`.

Everything else is yours to edit: `manifest.json`, the entire `commands/`
directory (except `__init__.py`), `references/**`, `tests/**`,
`README`-style docs.

## The two command execution modes

### Handler mode (default choice)

1. Declare the command in `manifest.json`:

   ```json
   {
     "id": "swap-rota",
     "summary": "Swap the alarm rota bound to a DongSchedule job.",
     "handler": "swap_rota:run",
     "side_effect": true,
     "idempotent": true,
     "safety": {"dry_run": "supported", "retry_risk": "safe", "verification": "GET jobinfo/get after POST."},
     "inputs": [
       {"name": "job_id", "type": "integer", "required": true},
       {"name": "rota", "type": "string", "required": true}
     ],
     "outputs": {"schema_ref": "#/$defs/swap-rota-output"},
     "requires": {"auth": true, "commands": []},
     "next_actions": []
   }
   ```

2. Implement `scripts/cli/src/<pkg>/commands/swap_rota.py`:

   ```python
   from browser_forge_generated.handler import command

   @command("swap-rota")
   def run(inputs, ctx):
       job = ctx.http("GET", f"/api/jd-schedule/jobinfo/get?id={inputs['job_id']}")
       ...
       return {"status": "updated", "before": ..., "after": ...}
   ```

3. Return a plain dict (goes into envelope `data`). Raise
   `HandlerError(code, msg)` or `ClientError` for typed failures; other
   exceptions become `INTERNAL_ERROR`.

`ctx.http(method, path_or_url, body=None, headers=None, params=None)` runs
through the shared client — auth is attached, `default_headers` are merged,
SSO redirect stubs are turned into `AUTH_REFRESH_REQUIRED`.

### Steps mode (only for straight-through flows)

```json
{
  "id": "list-orders",
  "steps": [
    {"id": "list", "request": "GET /orders?status={status}", "depends_on": []}
  ]
}
```

Placeholders `{name}` are substituted from `inputs`.

## Every command must declare

- `id` (kebab-case), `summary`, `side_effect`, `idempotent`, `inputs`,
  `outputs.schema_ref` (must resolve to a `$defs` entry), `requires`,
  `next_actions`.
- Side-effect commands must also declare `safety` (dry_run / retry_risk /
  verification).
- Its command reference doc at `references/commands/<id>.md` must include the
  `Inputs / Dependencies / Authentication / Output / Next actions / Side
  effects / Idempotency / Examples` sections and reference its
  `outputs.schema_ref`.

## Transport metadata

- `manifest.transport.default_headers` — headers applied to every request.
- `manifest.transport.per_host` — headers keyed by target host; merged after
  `default_headers`.
- Never place `Cookie`, `Authorization`, or any `*token*` / `*ticket*` header
  here (the validator rejects it).

## Output contract

Every non-help invocation prints exactly **one JSON envelope** on stdout.
Redacted logs go to stderr. Do not print anywhere else.

## Tests

The template ships pytest coverage for envelope, config, and network gate.
Add tests under `tests/` for your handlers — mock the HTTP client, do not
hit the network.

## Ready gate

Flip `manifest.status` from `draft` to `ready` only after `validate-skill`
returns `{"ok": true}`. Ready mode enforces every gate (command parity,
help metadata, output schemas, transport policy, handler-reference validity,
runtime integrity, secret scan).
