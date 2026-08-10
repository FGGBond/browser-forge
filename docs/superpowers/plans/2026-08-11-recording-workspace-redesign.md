# Recording Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the active Browser Forge UI with the approved stable three-pane recording workspace while preserving mature recording/storage APIs and deleting the inactive React renderer.

**Architecture:** Keep the local HTTP/Electron backend and active `ui/` application. Rebuild the UI around a persistent shell and explicit center/right responsibilities, extend the versioned guidance document for supplemental context, and remove the unused React build path. Every behavior change starts with a failing Vitest or Playwright test and lands as an independently reviewable commit.

**Tech Stack:** Vanilla ES modules, semantic HTML, CSS, Electron, Express, Vitest, Playwright.

## Global Constraints

- Work only in `refactor/recording-workspace-redesign`.
- Do not change recording, storage, export, or trash API semantics unless a failing test proves the approved UI needs it.
- Do not fabricate internal analysis or validation; describe the existing external-agent handoff truthfully.
- At 1512 × 869 target 240px / flexible center / 476px panes and keep video dominant.
- Desktop analysis/context must not auto-hide the left navigation.
- The right composer remains usable after the three required answers.
- Motion is 80–220ms, asymmetric, interruptible, property-specific, and reduced-motion safe.
- Use semantic controls, visible focus, status/alert roles, and keyboard-operable resizing.
- Remove inactive React renderer code and dependencies only after production references and tests prove they are unused.
- Run focused tests after each task; run `npm test` and `npm run build` before completion.

---

### Task 1: Versioned supplemental guidance context

**Files:**
- Modify: `ui/guidance-format.js`
- Modify: `ui/views/prompt-editor.js`
- Modify: `ui/guidance.css`
- Test: `tests/unit/ui-guidance-format.test.js`
- Test: `tests/unit/ui-prompt-editor.test.js`

**Interfaces:**
- Produces: `emptyGuidance()` with `actions`, `capability`, `acceptance`, and `notes`.
- Produces: a backward-compatible versioned codec that reads v2 and writes the new format.
- Produces: persistent composer behavior for supplemental notes after required answers.

- [ ] Add failing codec tests for supplemental notes and v2 backward compatibility.
- [ ] Run `npx vitest run tests/unit/ui-guidance-format.test.js` and confirm failure.
- [ ] Implement the smallest versioned codec change that preserves legacy material.
- [ ] Add failing browser/source tests proving the completed conversation retains an enabled composer and saves supplemental notes.
- [ ] Run `npx vitest run tests/unit/ui-prompt-editor.test.js` and confirm failure.
- [ ] Implement persistent supplemental-note composition, save state, truthful handoff copy, and reduced-motion-safe message motion.
- [ ] Run both focused test files and confirm pass.
- [ ] Commit as `feat: keep recording context composer available`.

### Task 2: Unified prepare and active-recording surfaces

**Files:**
- Modify: `ui/views/recording.js`
- Modify: `ui/new-recording.css`
- Test: `tests/unit/ui-start-recording.test.js`
- Test: `tests/unit/screen-recording-recovery.test.js`

**Interfaces:**
- Consumes: existing screen-permission and start/stop APIs.
- Produces: center-pane prepare, permission recovery, active recording, and finalizing surfaces with one primary action each.

- [ ] Add failing tests for stable workspace copy, single primary action, semantic status/error regions, and absence of the four-card welcome layout.
- [ ] Run the focused tests and confirm failure.
- [ ] Replace the welcome-card hierarchy with compact intent/permission/start presentation.
- [ ] Preserve active recording data polling and safe stop behavior while simplifying technical detail.
- [ ] Add finalizing state feedback that cannot double-submit stop.
- [ ] Run focused tests and confirm pass.
- [ ] Commit as `feat: unify recording lifecycle workspace`.

### Task 3: Remove inactive React renderer and build path

**Files:**
- Delete: `src/renderer/index.html`
- Delete: `src/renderer/src/App.jsx`
- Delete: `src/renderer/src/main.jsx`
- Delete: `src/renderer/src/store.js`
- Delete: `src/renderer/src/views/Setup.jsx`
- Delete: `src/renderer/src/views/Recording.jsx`
- Delete: `src/renderer/src/views/Done.jsx`
- Modify: `electron.vite.config.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `forge.config.cjs`
- Modify: `tests/unit/packaging-config.test.js`

**Interfaces:**
- Produces: main/preload-only Electron Vite build; active UI continues to be served from `ui/` by the recorder HTTP server.

- [ ] Change packaging tests to require no React renderer/plugin and no React dependencies.
- [ ] Run `npx vitest run tests/unit/packaging-config.test.js` and confirm failure.
- [ ] Remove renderer sources, renderer Vite block, React plugin import, React dependencies, and obsolete package ignore rules.
- [ ] Run `npm install --package-lock-only` if needed to normalize the lockfile.
- [ ] Run packaging tests and `npm run build`; confirm both pass.
- [ ] Commit as `refactor: remove inactive react renderer`.

### Task 4: Stable three-pane application shell

**Files:**
- Modify: `ui/app.js`
- Modify: `ui/views/sidebar.js`
- Modify: `ui/views/split-resize.js`
- Modify: `ui/styles.css`
- Test: `tests/unit/ui-workspace-shell.test.js`
- Test: `tests/unit/ui-sidebar-motion-browser.test.js`

**Interfaces:**
- Produces: persistent desktop left navigation, flexible center pane, fixed/default 476px context pane, compact-rail and drawer fallbacks.
- Produces: shell state that never auto-collapses the left pane merely because context is open.

- [ ] Replace obsolete shell expectations with failing tests for 240px desktop navigation, 476px context default, aligned top bars, no analysis-triggered sidebar hide, and property-specific motion.
- [ ] Run the focused tests and confirm failure.
- [ ] Simplify shell state by deleting hover-peek and analysis-triggered auto-collapse logic.
- [ ] Rebuild sidebar markup as recording library plus compact rail while retaining keyboard navigation and persisted explicit collapse.
- [ ] Bound pointer/keyboard resizing without changing the reference defaults.
- [ ] Add responsive rules that collapse left first and convert right to a drawer at narrow widths.
- [ ] Run focused tests and confirm pass.
- [ ] Commit as `feat: establish stable three pane shell`.

### Task 5: Evidence-first recording detail workspace

**Files:**
- Modify: `ui/views/detail.js`
- Modify: `ui/views/video-player.js`
- Modify: `ui/styles.css`
- Test: `tests/unit/ui-recording-detail.test.js`
- Test: `tests/unit/ui-video-player.test.js`

**Interfaces:**
- Consumes: prompt editor from Task 1 and shell sizing from Task 4.
- Produces: compact aligned title bar, dominant player, evidence strip, object action dock, and continuously mounted context pane.

- [ ] Add failing Playwright assertions for the target geometry at 1512 × 869, persistent left/context panes, video dominance, bottom-right object actions, and fixed right composer.
- [ ] Run the focused tests and confirm failure.
- [ ] Replace the oversized detail header with a 42–44px title bar.
- [ ] Keep the context pane mounted; toggling at narrow widths controls drawer visibility rather than desktop existence.
- [ ] Add an evidence strip based only on available recording metadata; do not invent event data.
- [ ] Move Export and Move to Trash into the object action dock beneath the player.
- [ ] Refine player controls and focus/idle behavior without changing media semantics.
- [ ] Run focused tests and confirm pass.
- [ ] Commit as `feat: make recording evidence the workspace focus`.

### Task 6: Repository and Trash alignment

**Files:**
- Modify: `ui/views/library.js`
- Modify: `ui/views/trash.js`
- Modify: `ui/styles.css`
- Test: `tests/unit/ui-recording-library-layout.test.js`
- Test: `tests/unit/ui-recording-library.test.js`
- Test: `tests/unit/ui-trash.test.js`

**Interfaces:**
- Produces: repository and trash views that use the same shell, density, typography, and reversible-danger hierarchy.

- [ ] Add failing tests for compact repository rows, evidence-first selection, no competing large cards, and confirmed permanent deletion.
- [ ] Run focused tests and confirm failure.
- [ ] Align repository/list spacing and actions with the new shell.
- [ ] Keep Restore primary and Permanent Delete secondary/dangerous; preserve confirmation and error truthfulness.
- [ ] Run focused tests and confirm pass.
- [ ] Commit as `style: align repository and trash workspace`.

### Task 7: Cross-flow accessibility and motion regression

**Files:**
- Modify: `ui/styles.css`
- Modify: `ui/guidance.css`
- Modify: `ui/new-recording.css`
- Modify: affected view files only when a semantic defect is proven
- Test: `tests/unit/ui-product-boundaries.test.js`
- Test: `tests/unit/ui-workspace-shell.test.js`
- Test: `tests/unit/ui-recording-detail.test.js`
- Test: `tests/unit/ui-prompt-editor.test.js`

**Interfaces:**
- Produces: a single motion token contract and complete keyboard/reduced-motion behavior across the journey.

- [ ] Add failing checks that reject `transition: all`, animations over 300ms, missing reduced-motion fallbacks, inaccessible icon controls, and duplicate primary actions.
- [ ] Run focused tests and confirm failure.
- [ ] Consolidate motion tokens and repair focus, status, alert, tooltip, and reduced-motion gaps.
- [ ] Run focused tests and confirm pass.
- [ ] Commit as `fix: harden workspace motion and accessibility`.

### Task 8: Full verification and real-app visual regression

**Files:**
- Modify only defects proven by verification.
- Add/update screenshots or test fixtures only if the repository already treats them as source-controlled artifacts.

**Interfaces:**
- Produces: verified branch ready for review and remote push.

- [ ] Run `npm test`; require every test to pass.
- [ ] Run `npm run build`; require production build success.
- [ ] Launch the real Electron application from the redesigned worktree/package.
- [ ] Inspect Repository, Prepare, Recording/permission recovery, Detail, Context, completed handoff, responsive/collapsed shell, and Trash.
- [ ] Capture the 1512 × 869 detail workspace and compare geometry/hierarchy against the reference image.
- [ ] Exercise keyboard navigation and reduced-motion emulation.
- [ ] Run `git diff --check` and inspect `git status`.
- [ ] Request independent code and motion review; fix only evidence-backed findings.
- [ ] Re-run full test/build after fixes.
- [ ] Commit final verification fixes, push `refactor/recording-workspace-redesign`, and report evidence.
