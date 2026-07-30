---
name: browser-forge
description: Use when a browser-forge recording must be analyzed into a reusable, independently runnable skill and CLI package. Also handles fusing multiple generated skills into one.
---

# Browser Forge

Turn a Chrome recording into a manifest-driven skill with its own CLI. Also
fuse skills produced by different people into one aggregate skill.

Design principles: **thin framework, fat extension**. The framework handles
CLI wiring, JSON envelope, HTTP transport (with recording-derived default
headers), and authentication delegation. All business logic lives in
`commands/<name>.py` handler files or manifest `steps`.

## Workflow

```
user context → clarifying questions → HAR/DOM correlation → generate → populate → validate → report
```

1. **User context** — ask what the operation is, which data was viewed / entered / changed, and what the final result was. Do not analyse a recording without intent.
2. **Ambiguity questions** — surface competing request candidates and let the user pick. Never guess a side effect.
3. **Correlate artifacts** — read `references/analysis-workflow.md`.
4. **Generate skeleton**:

   ```bash
   bash skills/browser-forge/scripts/generate-skill \
     --recording-dir <recording-dir> \
     --skill-name <skill-name> \
     --description <text> \
     --target-domain <host>          # (or --target-url <full URL>, repeatable)
   ```

   Never overwrite. If the target skill directory exists, pick a new name.

5. **Populate** — read `references/artifact-spec.md`. Add manifest commands, references, and either `commands/<name>.py` handlers or `steps` bodies. Do **not** copy any recording file into the skill.
6. **Validate**:

   ```bash
   bash skills/browser-forge/scripts/validate-skill --skill-dir <skill-dir>
   ```
   Fix every issue and rerun. Change `status` in `manifest.json` from `draft` to `ready` only after validate is clean; ready mode enforces every gate.

7. **Report** — path, commands, auth strategy, findings, minimal invocation.

## Fusion (combine multiple skills)

```bash
bash skills/browser-forge/scripts/fuse-skill \
  --name aggregated \
  --description "Everything I need for team X." \
  --out /path/to/output-root \
  --skill /path/to/skill-a \
  --skill /path/to/skill-b
```

Produces a fresh generated skill whose commands are namespaced with the source
skill name (`skill-a:command-x`). Built-in `doctor` / `auth-status` /
`describe` are unified. Auth strategy defaults to the strictest of the inputs
(`jd-internal` > `browser-cookie` > `none`); override with `--auth-strategy`.
Read `references/fusion.md` for the merge policy.

## Authentication is external

Generated skills do **not** implement SSO or cookie discovery themselves.
They call:

- `browser-auth-cookie` (universal fallback) — a `pip install browser-auth-cookie` away.
- `erp-sso-login` (京东内网优先) — set `ERP_SSO_LOGIN_HOME` to the skill dir.

See `references/authentication.md`.

## Commands (of this skill)

- `generate-skill` — build a new skill skeleton from a Chrome recording.
- `validate-skill` — gate a skill's readiness.
- `fuse-skill` — combine ≥2 skills into an aggregate.

## Progressive reading

- `references/analysis-workflow.md` — while correlating recording artifacts.
- `references/artifact-spec.md` — before populating manifest and handlers.
- `references/authentication.md` — before touching auth.
- `references/fusion.md` — before fusing skills.
- `references/security.md` — before transferring derived content.
