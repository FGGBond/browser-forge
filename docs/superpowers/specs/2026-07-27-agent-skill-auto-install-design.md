# Agent Skill Auto Install Design

## Goal

When Browser Forge opens, it should ensure the bundled `browser-forge` analysis skill is installed for mainstream agents that consume `SKILL.md` directory skills. The first implementation targets Codex/OpenAI skills, the shared agent skills directory, and Claude Code skills. Gemini CLI is explicitly out of scope for this iteration.

## Supported targets

Browser Forge installs `browser-forge` to these target directories:

- `$CODEX_HOME/skills/browser-forge` when `CODEX_HOME` is set, otherwise `~/.codex/skills/browser-forge`
- `~/.agents/skills/browser-forge`
- `~/.claude/skills/browser-forge`

## Installation behavior

On every app startup, Browser Forge checks all supported targets.

- If a target is missing, Browser Forge installs the skill.
- If a target has a Browser Forge marker, Browser Forge updates it when the bundled version/content changed.
- If a target exists without a Browser Forge marker, Browser Forge does not overwrite it and reports a conflict status.
- If a target cannot be written, Browser Forge records a warning but does not block app startup.

Each managed installation includes `.browser-forge-install.json` with the installed version, content hash, target agent, installation time, and source metadata.

## Self-contained installed skill

The installed skill must not depend on the source repository layout. The installer copies the bundled `skills/browser-forge` directory and adds a self-contained runtime under `scripts/runtime/` copied from `src/skill-generation/`. Installed `generate-skill` and `validate-skill` scripts resolve `scripts/runtime/cli.mjs` first, falling back to the source-tree runtime during development.

`template-renderer.js` resolves the skill template relative to runtime when installed and relative to the repository when running from source.

## Startup integration

`src/main/index.js` calls the installer during `app.whenReady()`. Installer failures are logged and written to `skill-installation.json` under Electron `userData`, but they do not prevent Browser Forge from opening.

## Validation

Implementation must include unit tests for missing install, managed update, unmanaged conflict, multi-target resolution, self-contained runtime files, and non-blocking startup behavior. Final verification must run `npm test`, `npm run test:skill-generation`, `npm run make:mac`, and inspect the generated package artifact.
