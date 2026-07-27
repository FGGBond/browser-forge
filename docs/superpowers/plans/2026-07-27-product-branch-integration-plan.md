# Product Branch Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate all scattered branch and worktree changes into `codex/integrate-product-main` as a product-ready mainline candidate.

**Architecture:** Start from local `main`, which already includes committed skill generation, macOS packaging, and recording startup fixes. Copy the uncommitted UI/native recorder work into the integration branch as explicit files, then reconcile it with the already-integrated packaging/startup behavior. Treat `skills/browser-forge/` as the single canonical skill system.

**Tech Stack:** Electron, electron-vite, Electron Forge, Express, ws, Chrome DevTools Protocol, React build tooling, Vitest, Node.js ESM.

## Global Constraints

- Work only on branch `codex/integrate-product-main`.
- Do not modify the source worktrees at `/Users/zhukai.129/.codex/worktrees/a8ad/browser-forge` or `/Users/zhukai.129/.codex/worktrees/62e4/browser-forge`.
- Keep `skills/browser-forge/` as the only active skill system.
- Do not add the top-level runtime `skill/` directory from `origin/feat/claude-skill-and-auth`.
- Keep design assets inert: they may be committed under `design/icon-concepts/`, but runtime code must not load them.
- Do not push or merge into `main` until all acceptance checks pass.

---

### Task 1: Commit Integration Design and Plan

**Files:**
- Create: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/docs/superpowers/specs/2026-07-27-product-branch-integration-design.md`
- Create: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/docs/superpowers/plans/2026-07-27-product-branch-integration-plan.md`

**Interfaces:**
- Consumes: branch inventory and user approval to integrate WIP on a dedicated branch.
- Produces: committed design and plan documents for auditability.

- [ ] **Step 1: Verify branch**

Run:

```bash
git branch --show-current
```

Expected output:

```text
codex/integrate-product-main
```

- [ ] **Step 2: Commit design and plan**

Run:

```bash
git add docs/superpowers/specs/2026-07-27-product-branch-integration-design.md docs/superpowers/plans/2026-07-27-product-branch-integration-plan.md
git commit -m "docs: plan product branch integration"
```

Expected: commit succeeds.

---

### Task 2: Import Native UI and Recorder Server WIP

**Files:**
- Modify: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/recorder.mjs`
- Modify: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/src/main/chrome-launcher.js`
- Modify: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/src/main/index.js`
- Modify: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/src/main/recorder/index.js`
- Modify: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/tests/unit/chrome-launcher.test.js`
- Modify: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/ui/index.html`
- Create: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/src/main/recorder/http-server.js`
- Create: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/src/main/recorder/session-state.js`
- Create: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/src/main/recorder/start-options.js`
- Create: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/src/main/shell-ipc.js`
- Create: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/ui/recording-start.html`
- Create: relevant tests copied from `/Users/zhukai.129/.codex/worktrees/a8ad/browser-forge/tests/unit/`

**Interfaces:**
- Consumes: current local `main` code and WIP files from `/Users/zhukai.129/.codex/worktrees/a8ad/browser-forge`.
- Produces: integrated native UI, HTTP recorder server, live summary APIs, screenshot APIs, Electron shell IPC, and tests.

- [ ] **Step 1: Copy WIP files exactly into integration branch**

Run from `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge`:

```bash
src=/Users/zhukai.129/.codex/worktrees/a8ad/browser-forge
cp "$src/recorder.mjs" recorder.mjs
cp "$src/src/main/chrome-launcher.js" src/main/chrome-launcher.js
cp "$src/src/main/index.js" src/main/index.js
cp "$src/src/main/recorder/index.js" src/main/recorder/index.js
mkdir -p src/main/recorder tests/unit ui assets/icon-concepts
cp "$src/src/main/recorder/http-server.js" src/main/recorder/http-server.js
cp "$src/src/main/recorder/session-state.js" src/main/recorder/session-state.js
cp "$src/src/main/recorder/start-options.js" src/main/recorder/start-options.js
cp "$src/src/main/shell-ipc.js" src/main/shell-ipc.js
cp "$src/tests/unit/chrome-launcher.test.js" tests/unit/chrome-launcher.test.js
cp "$src/tests/unit/recorder-http-server.test.js" tests/unit/recorder-http-server.test.js
cp "$src/tests/unit/recording-session-screenshots.test.js" tests/unit/recording-session-screenshots.test.js
cp "$src/tests/unit/session-state.test.js" tests/unit/session-state.test.js
cp "$src/tests/unit/shell-ipc.test.js" tests/unit/shell-ipc.test.js
cp "$src/tests/unit/start-options.test.js" tests/unit/start-options.test.js
cp "$src/tests/unit/ui-artifacts-gallery.test.js" tests/unit/ui-artifacts-gallery.test.js
cp "$src/tests/unit/ui-start-recording.test.js" tests/unit/ui-start-recording.test.js
cp "$src/ui/index.html" ui/index.html
cp "$src/ui/recording-start.html" ui/recording-start.html
cp -R "$src/assets/icon-concepts/." assets/icon-concepts/
```

Expected: files are copied into the integration branch; source worktree remains unchanged.

- [ ] **Step 2: Inspect changes**

Run:

```bash
git diff --stat
git status --short
```

Expected: only integration branch files show modifications or additions.

- [ ] **Step 3: Run focused tests likely affected by copied files**

Run:

```bash
npx vitest run tests/unit/chrome-launcher.test.js tests/unit/session-state.test.js tests/unit/start-options.test.js tests/unit/shell-ipc.test.js tests/unit/recorder-http-server.test.js tests/unit/recording-session-screenshots.test.js tests/unit/ui-start-recording.test.js tests/unit/ui-artifacts-gallery.test.js
```

Expected: all listed tests pass. If any fail, fix the integration branch files only and rerun the same command.

- [ ] **Step 4: Commit native UI integration**

Run:

```bash
git add recorder.mjs src/main/chrome-launcher.js src/main/index.js src/main/recorder/index.js src/main/recorder/http-server.js src/main/recorder/session-state.js src/main/recorder/start-options.js src/main/shell-ipc.js tests/unit/chrome-launcher.test.js tests/unit/recorder-http-server.test.js tests/unit/recording-session-screenshots.test.js tests/unit/session-state.test.js tests/unit/shell-ipc.test.js tests/unit/start-options.test.js tests/unit/ui-artifacts-gallery.test.js tests/unit/ui-start-recording.test.js ui/index.html ui/recording-start.html assets/icon-concepts
git commit -m "feat: integrate native recorder UI"
```

Expected: commit succeeds.

---

### Task 3: Import Inert Design Concepts

**Files:**
- Create: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/design/icon-concepts/`

**Interfaces:**
- Consumes: untracked design files from `/Users/zhukai.129/.codex/worktrees/62e4/browser-forge/design/icon-concepts`.
- Produces: archived design concepts that do not affect runtime or tests.

- [ ] **Step 1: Copy design concepts**

Run:

```bash
mkdir -p design/icon-concepts
cp -R /Users/zhukai.129/.codex/worktrees/62e4/browser-forge/design/icon-concepts/. design/icon-concepts/
```

Expected: concept PNGs and generation script are present under `design/icon-concepts/`.

- [ ] **Step 2: Verify runtime does not reference design concepts**

Run:

```bash
grep -R "design/icon-concepts\|browser-forge-ai-\|browser-forge-drawn-" -n package.json src ui tests skills || true
```

Expected: no runtime references; output is empty or limited to documentation.

- [ ] **Step 3: Commit design concepts**

Run:

```bash
git add design/icon-concepts
git commit -m "chore: archive browser forge icon concepts"
```

Expected: commit succeeds.

---

### Task 4: Document Early Claude Skill/Auth Branch Decision

**Files:**
- Create: `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/docs/superpowers/specs/2026-07-27-claude-skill-auth-branch-disposition.md`

**Interfaces:**
- Consumes: `origin/feat/claude-skill-and-auth` branch inventory.
- Produces: explicit record that the branch was reviewed and not merged wholesale.

- [ ] **Step 1: Write branch disposition note**

Create `/Users/zhukai.129/.codex/worktrees/6d6d/browser-forge/docs/superpowers/specs/2026-07-27-claude-skill-auth-branch-disposition.md` with this content:

```markdown
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
```

Expected: note clearly explains why the branch was not merged.

- [ ] **Step 2: Verify excluded files are absent**

Run:

```bash
test ! -d skill
```

Expected: exit code 0.

- [ ] **Step 3: Commit disposition note**

Run:

```bash
git add docs/superpowers/specs/2026-07-27-claude-skill-auth-branch-disposition.md
git commit -m "docs: record claude skill branch disposition"
```

Expected: commit succeeds.

---

### Task 5: Full Verification and Product Readiness Fixes

**Files:**
- Modify only files required to make the integration branch pass tests and build.

**Interfaces:**
- Consumes: integrated branch from Tasks 1-4.
- Produces: verified product candidate branch.

- [ ] **Step 1: Install dependencies if needed**

Run:

```bash
npm install
```

Expected: dependencies are installed and `package-lock.json` remains consistent or updates only for declared package changes.

- [ ] **Step 2: Run full tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run skill generation tests**

Run:

```bash
npm run test:skill-generation
```

Expected: all skill-generation tests pass.

- [ ] **Step 4: Run production build**

Run:

```bash
npm run build
```

Expected: electron-vite build succeeds.

- [ ] **Step 5: Inspect final git state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -8
```

Expected: branch is `codex/integrate-product-main`; status is clean after any final fixes are committed.

- [ ] **Step 6: Commit verification fixes if needed**

If Step 2, 3, or 4 required code changes, run:

```bash
git add <changed-files>
git commit -m "fix: stabilize integrated product branch"
```

Expected: final status is clean.
