# Claude Skill/Auth Branch Disposition

`origin/feat/claude-skill-and-auth` was reviewed during product branch integration.

## Decision

Do not merge the branch wholesale into `codex/integrate-product-main`.

## Rationale

The branch introduces a top-level `skill/` directory and startup-time auto-install behavior targeting `~/.claude/plugins/user/browser-forge`. The integrated product branch uses `skills/browser-forge/` as the canonical skill-generation system. Carrying both systems as active runtime code would create conflicting ownership for generated skill templates and authentication flows.

## Preserved Value

The branch remains available at `origin/feat/claude-skill-and-auth` for historical reference. Its knowledge areas were considered while preserving the canonical generated skill templates and authentication support under `skills/browser-forge/`.

## Future Work

If automatic skill installation becomes a product requirement, design it as a new feature that installs or publishes the canonical `skills/browser-forge/` output rather than reviving the older top-level `skill/` layout.
