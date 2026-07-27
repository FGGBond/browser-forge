# Product Branch Integration Design

## Goal

Create a single integration branch that consolidates the scattered browser-forge work into a product-ready mainline candidate without destabilizing the existing local `main` branch.

## Current Inputs

- Base branch: local `main` at `ffcacca`.
- Remote baseline: `origin/main` at `099b571`.
- Already included in local `main`:
  - `codex/browser-forge-skill-generation` through `65c1728`.
  - `codex/mac-packaging-installer` through `87f2e02`.
  - `tests/skill-generation/generator.test.js` timeout adjustment at `ffcacca`.
- Still scattered outside local `main`:
  - Uncommitted `codex/ui-ux-native-polish` worktree changes in `/Users/zhukai.129/.codex/worktrees/a8ad/browser-forge`.
  - Untracked design icon concepts in `/Users/zhukai.129/.codex/worktrees/62e4/browser-forge/design/icon-concepts`.
  - Remote early skill/auth branch `origin/feat/claude-skill-and-auth`.

## Integration Strategy

Use a dedicated branch named `codex/integrate-product-main` from local `main`. This branch is the only place where cross-branch integration changes are made. Existing feature worktrees remain untouched except for reading and copying their work into the integration branch.

## Included Work

### Skill Generation

Keep the existing `skills/browser-forge/` skill-generation architecture from `codex/browser-forge-skill-generation`. It remains the canonical skill system.

### macOS Packaging

Keep Electron Forge packaging support, including:

- `forge.config.cjs`.
- `package:mac` and `make:mac` scripts.
- preload CJS output configuration.
- packaging configuration tests.

### Recording Startup Improvements

Keep the recording startup improvements from `codex/mac-packaging-installer`, including:

- `--new-window` Chrome startup.
- configurable recording start URL.
- `/recording-start.html` startup guidance page.
- duplicate-start protection.
- startup button disabled/loading state.

### Native UI / UX Polish

Integrate the uncommitted `codex/ui-ux-native-polish` worktree changes, including:

- Native-style browser-forge shell UI.
- sidebar tab list and dimension tabs.
- live recording summary.
- artifact and screenshot gallery.
- recorder HTTP server extraction.
- Electron main process loading the local recorder server.
- output directory picker IPC.
- tests for recorder server, shell IPC, start options, UI behavior, and screenshot artifacts.

### Design Assets

Copy icon concepts into the integration branch under `design/icon-concepts/`. These assets must not be loaded by runtime code and must not affect tests, packaging, or app startup. Do not keep duplicate runtime-adjacent copies under `assets/icon-concepts/`.

### Early Claude Skill/Auth Branch

Do not merge `origin/feat/claude-skill-and-auth` wholesale. Its top-level `skill/` layout conflicts conceptually with the canonical `skills/browser-forge/` system. Only preserve useful knowledge by adding an archival comparison note under `docs/superpowers/specs/` or `docs/superpowers/plans/` if needed. Runtime auto-install into `~/.claude/plugins/user/browser-forge` is excluded from this integration unless it is redesigned to target the canonical `skills/browser-forge/` structure in a later task.

## Non-Goals

- Do not push to `origin/main` during integration.
- Do not overwrite existing feature worktrees.
- Do not add a second live skill system alongside `skills/browser-forge/`.
- Do not make design assets part of the packaged app unless explicitly configured later.
- Do not remove existing tests to make integration pass.

## Product Acceptance Criteria

The integrated branch is acceptable when all of the following are true:

1. `git status --short` is clean after committed integration work.
2. `npm test` passes.
3. `npm run test:skill-generation` passes.
4. `npm run build` passes.
5. Packaging configuration tests pass as part of `npm test`.
6. The integration branch contains the native UI files and recorder server extraction.
7. The integration branch keeps the `recording-start.html` guided startup behavior.
8. The integration branch does not contain a top-level runtime `skill/` directory from `origin/feat/claude-skill-and-auth`.
9. The final summary documents any remaining risks or manual checks.

## Risk Controls

- Work only on `codex/integrate-product-main`.
- Commit design and plan before code integration.
- Commit copied WIP in logical slices so regressions can be bisected.
- Prefer copying exact WIP files, then reconciling conflicts, instead of cherry-picking unknown partial state.
- Run focused tests after each slice and full tests before declaring completion.
