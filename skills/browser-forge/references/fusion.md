# Skill fusion

Combine ≥2 Browser-Forge–generated skills into one aggregate skill so a team
can run everything through a single CLI.

## Invocation

```bash
bash skills/browser-forge/scripts/fuse-skill \
  --name aggregated \
  --description "Everything I need for team X." \
  --out /path/to/output-root \
  --skill /path/to/skill-a \
  --skill /path/to/skill-b \
  [--auth-strategy jd-internal]
```

Output is a fresh, generator-shaped skill at
`<output-root>/<name>/`. Validate it exactly the same way as any generated
skill:

```bash
bash skills/browser-forge/scripts/validate-skill --skill-dir <output-root>/<name>
```

## Merge policy

| Field | Merge rule |
|---|---|
| `commands` | Non-builtin commands from each source are prefixed with the source skill name: `skill-a:command-x`. Built-in `doctor` / `auth-status` / `describe` are unified. |
| `auth.strategy` | Strictest of the inputs (`jd-internal` > `browser-cookie` > `none`), unless overridden with `--auth-strategy`. |
| `auth.target_urls` | Union. |
| `auth.required_cookies` | Union. |
| `transport.default_headers` | Empty (headers move to `per_host` to avoid cross-contamination). |
| `transport.per_host` | Union keyed by host. Each source's original `default_headers` are stored under every one of its target hosts. |
| `$defs` | Union. On collision the last source wins — keep response shapes compatible. |
| `commands/` package | Each source's `commands/` becomes a subpackage: `<pkg>.commands.<source_name>.<mod>`. Handler references are rewritten accordingly. |
| `references/commands/*.md` | Copied under a `<source>-<command>.md` prefix. |
| `fused_from` | Records `{skill_id, spec_version}` for every input for lineage. |

## Conflict handling

- **Command ID collision** — cannot happen because IDs are always prefixed by
  source skill name. If two sources happen to share the same `skill.name`,
  fusion refuses with `FUSION_COMMAND_COLLISION`.
- **Handler module name collision** — avoided by placing each source's
  `commands/` under a subpackage.
- **Auth strategy conflict** — fusion picks the strictest by default; pass
  `--auth-strategy` to force a specific one.

## Non-goals

- Fusion is flat, one level deep. A previously-fused skill can be one of the
  inputs but the result is still flat (its own commands are inherited with an
  extra prefix layer).
- Fusion does not merge business logic (each source keeps its own handler
  module). Two sources doing "list orders" against the same backend remain
  two commands.
- Fusion does not remove or rename commands from source skills.

## Verification

After a fuse:

```bash
scripts/browser_forge-<name> describe            # inspect merged manifest
scripts/browser_forge-<name> doctor              # both auth tools reachable?
scripts/browser_forge-<name> auth-status         # cookies resolve?
scripts/browser_forge-<name> <source>:<command>  # invoke a fused command
```

If a fused command fails to import, check
`manifest.commands[*].handler` — it should look like
`<source>.<module>:<function>`, matching the subpackage layout under
`scripts/cli/src/<pkg>/commands/`.
