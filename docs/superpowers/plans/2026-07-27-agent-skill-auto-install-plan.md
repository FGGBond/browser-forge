# Agent Skill Auto Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically install the bundled `browser-forge` analysis skill for Codex/OpenAI, shared agents, and Claude Code when the Browser Forge app opens.

**Architecture:** Add a main-process installer module that copies the bundled skill to supported agent directories, adds a self-contained runtime, tracks managed installs with a marker, and logs status without blocking app startup. Update skill scripts and template resolution so installed skills run outside the source repository.

**Tech Stack:** Electron main process, Node.js `fs/promises`, Vitest unit tests, Electron Forge macOS packaging.

## Global Constraints

- Gemini CLI is out of scope for this implementation.
- Never overwrite an existing `browser-forge` skill directory unless it contains `.browser-forge-install.json` with `managedBy: "browser-forge"`.
- Installer failures must not prevent the Browser Forge app window from opening.
- Installed skills must include a local `scripts/runtime/cli.mjs` and must not depend on source-tree relative paths.
- Every production change must be covered by a failing test first.

---

### Task 1: Installer core

**Files:**
- Create: `src/main/agent-skill-installer.js`
- Test: `tests/unit/agent-skill-installer.test.js`

**Interfaces:**
- Produces: `getDefaultAgentSkillTargets({ homeDir, env }): Array<{ agent: string, rootDir: string, skillDir: string }>`
- Produces: `ensureAgentSkillsInstalled(options): Promise<{ checkedAt: string, results: Array<object> }>`

**Steps:**
- [ ] Write tests for default targets, missing install, managed update, and unmanaged conflict.
- [ ] Run `npx vitest run tests/unit/agent-skill-installer.test.js` and confirm expected failures.
- [ ] Implement target resolution, managed marker, hash comparison, safe copy, and conflict handling.
- [ ] Re-run the installer unit test and confirm it passes.

### Task 2: Self-contained runtime scripts

**Files:**
- Modify: `skills/browser-forge/scripts/generate-skill`
- Modify: `skills/browser-forge/scripts/validate-skill`
- Modify: `src/skill-generation/template-renderer.js`
- Test: `tests/unit/agent-skill-installer.test.js`
- Test: `tests/skill-generation/end-to-end.test.js`

**Interfaces:**
- Consumes: installed runtime at `scripts/runtime/cli.mjs`.
- Produces: source-tree scripts still work, installed scripts prefer local runtime.

**Steps:**
- [ ] Add tests asserting installed `scripts/runtime/cli.mjs` exists and copied scripts reference runtime fallback.
- [ ] Run relevant tests and confirm failure before implementation.
- [ ] Update shell scripts and template root resolver.
- [ ] Re-run unit and skill-generation tests.

### Task 3: Electron startup integration

**Files:**
- Modify: `src/main/index.js`
- Test: `tests/unit/main-startup.test.js`

**Interfaces:**
- Consumes: `ensureAgentSkillsInstalled`.
- Produces: app startup calls installer and continues on failure.

**Steps:**
- [ ] Write startup behavior test using injected Electron stubs.
- [ ] Run it and confirm failure before implementation.
- [ ] Refactor `src/main/index.js` to export `startApp` and call installer non-blockingly.
- [ ] Re-run startup tests and existing main-related tests.

### Task 4: Final verification and artifact

**Files:**
- Verify only; no source changes expected.

**Steps:**
- [ ] Run `npm test`.
- [ ] Run `npm run test:skill-generation`.
- [ ] Run `npm run make:mac`.
- [ ] Inspect generated DMG/ZIP paths and package contents.
- [ ] Commit and push `codex/integrate-product-main`.
