# Recording Workspace UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Browser Forge into a theme-safe recording workspace with Codex-style navigation, a goal-first recording flow, searchable video rows, a private custom player, and an Agent-ready analysis pane.

**Architecture:** Keep the existing framework-free ES module renderer and HTTP API, but split reusable navigation and media behavior into focused modules. Treat each recording as the primary navigation object, keep prompt drafts local-first, and derive poster timing from the recording timeline rather than a fixed video offset. Every task below leaves the app runnable and is committed independently.

**Tech Stack:** Electron, vanilla JavaScript ES modules, CSS custom properties, Express HTTP API, Playwright, Vitest, native macOS video helper.

## Global Constraints

- Support macOS light and dark appearance without a user-facing theme switcher.
- Do not use ego-browser for implementation or validation.
- Do not add a real or simulated Agent response; unconfigured Agent UI only edits and copies the external prompt draft.
- Do not expose media server ports, internal artifact paths, HAR, DOM, Console, screenshot counts, “录制物料”, or “关键事件” in visible UI.
- The custom player must omit native `controls`, audio controls, download affordances, and picture-in-picture.
- Keep recording, export, trash, restore, and permanent-delete behavior working.
- Preserve Windows recorder backend design; this UI plan must not introduce macOS-only renderer assumptions.
- Each task follows red-green-refactor TDD and ends with its own commit.

---

### Task 1: Theme Tokens and Workspace Shell

**Files:**
- Create: `ui/views/sidebar.js`
- Modify: `ui/app.js`
- Modify: `ui/state.js`
- Modify: `ui/styles.css`
- Modify: `tests/unit/ui-recording-library.test.js`
- Create: `tests/unit/ui-workspace-shell.test.js`

**Interfaces:**
- Produces: `renderSidebar({ container, recordings, route, selectedId, collapsed, locked, onNavigate, onNew, onToggle })` returning a cleanup function.
- Produces: state fields `sidebarCollapsed` and `analysisPaneOpen`; sidebar preference key `browser-forge.sidebar-collapsed`.
- Consumes: current `navigate(route, patch)` behavior from `ui/app.js`.

- [ ] **Step 1: Write failing shell and theme tests**

Add assertions that the stylesheet defines complete semantic tokens for both default and `@media (prefers-color-scheme: dark)`, that `color-scheme: light dark` is paired with dark overrides, and that the shell contains a top “新录制”, “录制仓库”, recording-list region, “回收站”, and a sidebar collapse control.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/unit/ui-workspace-shell.test.js tests/unit/ui-recording-library.test.js`

Expected: FAIL because the sidebar module, dark token block, and new labels do not exist.

- [ ] **Step 3: Implement the semantic theme and sidebar module**

Define semantic surface, text, border, overlay, focus, success, warning, and danger tokens in `:root`, override them in dark appearance, and replace visible hard-coded light surfaces in the shell. Move sidebar markup/event wiring out of `app.js`, render active recordings as navigation items, add compact collapsed rendering, and persist only the collapsed preference in `localStorage`.

- [ ] **Step 4: Run focused tests and full renderer regression**

Run: `npx vitest run tests/unit/ui-workspace-shell.test.js tests/unit/ui-recording-library.test.js tests/unit/ui-trash.test.js tests/unit/ui-start-recording.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/app.js ui/state.js ui/styles.css ui/views/sidebar.js tests/unit/ui-workspace-shell.test.js tests/unit/ui-recording-library.test.js
git commit -m "feat: add theme-safe recording workspace shell"
```

### Task 2: Goal-First New Recording Flow

**Files:**
- Modify: `ui/views/recording.js`
- Modify: `ui/api.js`
- Modify: `src/main/recorder/http-server.js`
- Modify: `src/main/recorder/recording-session.js`
- Modify: `src/main/recording-library/metadata.js`
- Modify: `src/main/recording-library/index.js`
- Modify: `ui/styles.css`
- Modify: `tests/unit/ui-start-recording.test.js`
- Modify: `tests/unit/recorder-http-server.test.js`
- Modify: `tests/unit/recording-library-metadata.test.js`
- Modify: `tests/integration/managed-recording-workflow.test.js`

**Interfaces:**
- `api.startRecording({ goalText })` sends optional trimmed `goalText`.
- `POST /api/start-recording` accepts `{ goalText?: string }` and persists it as the recording prompt draft when a managed recording is finalized.
- Empty input remains valid and starts recording without creating a prompt draft.

- [ ] **Step 1: Write failing goal persistence tests**

Cover the Codex-style question “有什么想要完成的浏览器操作？”, a large goal textarea, direct start with empty text, trimmed request payload, and managed-session prompt persistence after stop.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/ui-start-recording.test.js tests/unit/recorder-http-server.test.js tests/integration/managed-recording-workflow.test.js`

Expected: FAIL because start-recording does not accept or persist `goalText` and the old form copy remains.

- [ ] **Step 3: Implement goal-first recording**

Replace the configuration-card visual with a centered conversation-style goal composer. Keep permission recovery and Chrome-path errors actionable, send the optional goal through the start API, hold it in the managed session, and write it through the existing prompt storage path when the recording becomes a library item.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/ui-start-recording.test.js tests/unit/recorder-http-server.test.js tests/unit/recording-library-metadata.test.js tests/integration/managed-recording-workflow.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/views/recording.js ui/api.js ui/styles.css src/main/recorder/http-server.js src/main/recorder/recording-session.js src/main/recording-library/metadata.js src/main/recording-library/index.js tests/unit/ui-start-recording.test.js tests/unit/recorder-http-server.test.js tests/unit/recording-library-metadata.test.js tests/integration/managed-recording-workflow.test.js
git commit -m "feat: add goal-first recording flow"
```

### Task 3: Private Custom Video Player

**Files:**
- Create: `ui/views/video-player.js`
- Modify: `ui/views/detail.js`
- Modify: `ui/views/library.js`
- Modify: `ui/styles.css`
- Create: `tests/unit/ui-video-player.test.js`
- Modify: `tests/unit/ui-recording-detail.test.js`

**Interfaces:**
- Produces: `mountVideoPlayer({ container, src, poster, durationMs, compact = false, title = '' })` returning `{ element, destroy }`.
- Player controls: play/pause, seek range, `-10s`, `+10s`, playback rates `[0.5, 1, 1.5, 2]`, fullscreen, keyboard Space/ArrowLeft/ArrowRight.
- The underlying `<video>` has `controls=false`, `muted`, `playsinline`, `disablepictureinpicture`, and `controlslist="nodownload noplaybackrate nofullscreen"` as defense in depth; custom controls provide allowed functions.

- [ ] **Step 1: Write failing player behavior tests**

Use Playwright to assert no native controls, no visible audio/download/PIP UI, correct seek clamping, rate cycling, progress updates, fullscreen request, keyboard controls, cleanup, and a reduced compact control set.

- [ ] **Step 2: Run player tests and verify RED**

Run: `npx vitest run tests/unit/ui-video-player.test.js tests/unit/ui-recording-detail.test.js`

Expected: FAIL because `video-player.js` does not exist and detail uses `<video controls>`.

- [ ] **Step 3: Implement the player**

Create accessible custom controls, format elapsed/total time, prevent context-menu media actions, synchronize buffered/current state, and hide controls that are not appropriate in compact mode while retaining play, seek, and fullscreen.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/ui-video-player.test.js tests/unit/ui-recording-detail.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/views/video-player.js ui/views/detail.js ui/views/library.js ui/styles.css tests/unit/ui-video-player.test.js tests/unit/ui-recording-detail.test.js
git commit -m "feat: add private custom video player"
```

### Task 4: Searchable Single-Row Recording Repository

**Files:**
- Modify: `ui/views/library.js`
- Modify: `ui/app.js`
- Modify: `ui/styles.css`
- Modify: `src/main/recording-library/metadata.js`
- Modify: `src/main/recording-library/index.js`
- Modify: `tests/unit/ui-recording-library.test.js`
- Modify: `tests/unit/recording-library.test.js`
- Modify: `tests/unit/recording-library-metadata.test.js`

**Interfaces:**
- Library summaries expose `visitedHosts: string[]` in addition to `startHost`.
- Search matches normalized title, `startHost`, and `visitedHosts`.
- Each result row contains a 16:9 compact player, title, site summary, creation time, duration, video state, and “去分析”.

- [ ] **Step 1: Write failing list and search tests**

Assert one recording per row, embedded custom player mount point, no card/detail split, search by visited host, empty/search-empty states, and navigation from both row title and “去分析”.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/ui-recording-library.test.js tests/unit/recording-library.test.js tests/unit/recording-library-metadata.test.js`

Expected: FAIL because the grid/detail layout and title/host-only search remain.

- [ ] **Step 3: Implement repository rows and richer summaries**

Collect unique hosts from navigation metadata/timeline when finalizing a recording, normalize old metadata with an empty array, include them in summaries, update filtering, and rebuild the repository as full-width single rows with inline video browsing.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/ui-recording-library.test.js tests/unit/recording-library.test.js tests/unit/recording-library-metadata.test.js tests/unit/ui-video-player.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/views/library.js ui/app.js ui/styles.css src/main/recording-library/metadata.js src/main/recording-library/index.js tests/unit/ui-recording-library.test.js tests/unit/recording-library.test.js tests/unit/recording-library-metadata.test.js
git commit -m "feat: redesign searchable recording repository"
```

### Task 5: First External Page Poster Selection

**Files:**
- Modify: `src/main/recorder/poster-generator.js`
- Modify: `src/main/recorder/http-server.js`
- Modify: `tests/unit/poster-generator.test.js`
- Modify: `tests/unit/recorder-http-server.test.js`

**Interfaces:**
- Produces: `selectPosterOffset({ durationMs, timeline, internalOrigins, settleDelayMs = 750 }) -> number`.
- An eligible event is the first successful external HTTP(S) navigation with a finite non-negative `videoOffsetMs`.
- Selected offset is navigation offset plus settle delay, clamped before the video end; fallback retains the existing early-frame strategy.

- [ ] **Step 1: Write failing offset-selection tests**

Cover Browser Forge guide URLs being ignored, first external navigation selected, invalid offsets ignored, settle delay clamped, no-navigation fallback, and the HTTP finalize path passing timeline data to poster generation.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx vitest run tests/unit/poster-generator.test.js tests/unit/recorder-http-server.test.js`

Expected: FAIL because poster selection only uses `min(1000, duration * 0.2)`.

- [ ] **Step 3: Implement timeline-aware poster selection**

Keep extraction in the existing native helper, isolate offset selection as a pure function, pass the finalized timeline to the generator, and never fail recording finalization solely because poster extraction fails.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/poster-generator.test.js tests/unit/recorder-http-server.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/recorder/poster-generator.js src/main/recorder/http-server.js tests/unit/poster-generator.test.js tests/unit/recorder-http-server.test.js
git commit -m "fix: select poster from first external page"
```

### Task 6: Recording Analysis Workspace and Prompt Pane

**Files:**
- Modify: `ui/views/detail.js`
- Modify: `ui/views/prompt-editor.js`
- Modify: `ui/app.js`
- Modify: `ui/state.js`
- Modify: `ui/styles.css`
- Modify: `tests/unit/ui-recording-detail.test.js`
- Modify: `tests/unit/ui-prompt-editor.test.js`
- Modify: `tests/unit/ui-workspace-shell.test.js`

**Interfaces:**
- Detail main area renders title, site, date, duration, video state, custom player, export, trash, and analysis-pane toggle only.
- Produces: `renderAnalysisPane({ container, api, recordingId, open, onClose })` with draft autosave, preview, and external-copy behavior.
- Analysis pane preference is per current renderer session; it is not a persisted Agent session.

- [ ] **Step 1: Write failing analysis workspace tests**

Assert detail excludes “录制物料” and “关键事件”, excludes timeline fetch/rendering, opens/closes the right pane, shows explicit unconfigured-Agent copy, autosaves prompt, previews full external prompt, copies it, and shrinks the main area instead of overlaying it at desktop widths.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/ui-recording-detail.test.js tests/unit/ui-prompt-editor.test.js tests/unit/ui-workspace-shell.test.js`

Expected: FAIL because detail exposes artifacts/timeline and prompt editor is embedded in the old secondary grid.

- [ ] **Step 3: Implement analysis workspace**

Remove internal artifact and timeline UI, move prompt behavior into a right analysis pane with “Agent 尚未配置” state, add independent left/right collapse controls, preserve rename/export/trash behavior, and use a sheet presentation below the desktop width threshold.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/unit/ui-recording-detail.test.js tests/unit/ui-prompt-editor.test.js tests/unit/ui-workspace-shell.test.js tests/unit/ui-trash.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/views/detail.js ui/views/prompt-editor.js ui/app.js ui/state.js ui/styles.css tests/unit/ui-recording-detail.test.js tests/unit/ui-prompt-editor.test.js tests/unit/ui-workspace-shell.test.js
git commit -m "feat: add recording analysis workspace"
```

### Task 7: Trash, Responsive, Accessibility, and Motion Polish

**Files:**
- Modify: `ui/views/trash.js`
- Modify: `ui/views/recording.js`
- Modify: `ui/views/library.js`
- Modify: `ui/views/detail.js`
- Modify: `ui/styles.css`
- Modify: `tests/unit/ui-trash.test.js`
- Modify: `tests/unit/ui-workspace-shell.test.js`
- Modify: `tests/unit/ui-video-player.test.js`

**Interfaces:**
- Trash stays a simple single-column management view and does not open the analysis pane.
- At narrow widths, analysis pane becomes a modal sheet and compact player retains play, seek, fullscreen.
- Every icon-only button has `aria-label`; focus-visible styling uses semantic focus tokens.

- [ ] **Step 1: Write failing accessibility/responsive tests**

Assert accessible names, keyboard reachability, focus-visible rules, reduced-motion behavior, narrow analysis-sheet CSS, no duplicate new-recording CTA, and restoration returning to the restored recording analysis route.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run tests/unit/ui-trash.test.js tests/unit/ui-workspace-shell.test.js tests/unit/ui-video-player.test.js`

Expected: FAIL for missing labels, responsive sheet behavior, or old trash layout assumptions.

- [ ] **Step 3: Apply final interaction polish**

Normalize empty/loading/error states, long-title truncation, hover/focus/disabled states, 160–220ms ease-out transitions, reduced-motion overrides, responsive repository/player behavior, and explicit permanent-delete confirmation copy.

- [ ] **Step 4: Run all UI tests**

Run: `npx vitest run tests/unit/ui-*.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/views/trash.js ui/views/recording.js ui/views/library.js ui/views/detail.js ui/styles.css tests/unit/ui-trash.test.js tests/unit/ui-workspace-shell.test.js tests/unit/ui-video-player.test.js
git commit -m "fix: polish recording workspace interactions"
```

### Task 8: Full Regression and Packaged-App Verification

**Files:**
- Modify only if a regression is found: affected source and its focused regression test.
- Update: `docs/superpowers/specs/2026-08-09-recording-workspace-ux-redesign.md` status and verification notes.

**Interfaces:**
- No new interface; this task verifies all earlier contracts together.

- [ ] **Step 1: Run static and complete automated verification**

Run:

```bash
git diff --check
npm test
npm run build
```

Expected: zero diff errors, all tests pass, build exits 0.

- [ ] **Step 2: Launch the app without ego-browser and capture local evidence**

Use the Browser Forge desktop app directly or Playwright against the local UI test server. Verify new recording, active recording lock, repository with data/empty/search-empty, detail pane open/closed, trash, light, dark, 1200×800, 900×700, reduced motion, and keyboard-only operation.

- [ ] **Step 3: Verify security and product-language boundaries**

Search rendered source/tests to confirm no native video controls, media port text, “录制物料”, “关键事件”, fake Agent response, audio control, PIP, or download control is exposed.

- [ ] **Step 4: Record verification notes and commit any final regression fix**

```bash
git add docs/superpowers/specs/2026-08-09-recording-workspace-ux-redesign.md <affected-files>
git commit -m "test: verify recording workspace redesign"
```

- [ ] **Step 5: Push and verify the remote branch**

```bash
git push origin feat/window-video-recording
git ls-remote --heads origin feat/window-video-recording
git status -sb
```

Expected: local HEAD equals the remote branch head and the worktree is clean.
