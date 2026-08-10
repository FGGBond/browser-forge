# Recording Browser, Poster, and Guidance Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a normal scoped Chrome recording window, generate a stable first-page poster, and deliver a right-side three-question guidance composer whose final action exports the recording and copies a prompt referencing that export.

**Architecture:** Chrome and CDP establish independent native-window and CDP-window anchors from the token start page. A platform-independent navigation-settling tracker emits poster candidates during recording. The renderer replaces EasyMDE with a constrained guidance editor, and the main process exposes a single export-and-prompt handoff operation.

**Tech Stack:** Electron, Node.js, Chrome DevTools Protocol, vanilla HTML/CSS/JavaScript, Vitest, ScreenCaptureKit/Swift, npm packaging.

## Global Constraints

- Keep Chrome's address bar, tab strip, multi-tab behavior, and navigation controls.
- Record and analyze only the Chrome window Browser Forge launched.
- Poster must come from the first real HTTP(S) page after stable rendering, never the internal guide page.
- Electron guidance remains to the right of video at every supported width.
- Show `第 N / 3 个问题` as a centered non-interactive capsule; remove segmented progress.
- Remove EasyMDE and do not add a replacement editor dependency.
- Persist the existing v2 guidance Markdown framing; never persist editable HTML.
- Export before assembling the external-agent prompt; prompt uses the final exported path.
- Preserve macOS delivery and platform-neutral interfaces for a later Windows backend.
- Use TDD, one independently reviewable commit per task, then push and build a DMG.

---

### Task 1: Restore the Full Chrome Window and Scope CDP Targets

**Files:**
- Modify: `src/main/chrome-launcher.js`
- Modify: `src/main/recorder/cdp-client.js`
- Modify: `src/main/recorder/index.js`
- Modify: `tests/unit/chrome-launcher.test.js`
- Modify: `tests/unit/cdp-client.test.js`
- Modify: related recording-session tests under `tests/unit/`

**Interfaces:**
- Produces: `CdpClient.connect({ rootTargetMatcher })` state containing `recordingWindowId`, active same-window targets, and archived targets.
- Preserves: native PID/title/CGWindowID binding contract.

- [ ] Write failing launcher tests requiring `--new-window` and positional start URL and rejecting `--app`, kiosk, and fullscreen flags.
- [ ] Run launcher tests and confirm failure against current app-mode launch.
- [ ] Implement the normal Chrome launch arguments and rerun launcher tests.
- [ ] Write failing CDP tests for initial `Browser.getWindowForTarget`, same-window tab attach, other-window rejection, target metadata change, closed-tab archive, and fail-closed identity errors.
- [ ] Run CDP tests and confirm the expected scope failures.
- [ ] Implement window-scoped target discovery and archive behavior without comparing CDP WindowID to CGWindowID.
- [ ] Add recording-session coverage for two tabs in one window and an ignored second window.
- [ ] Run all launcher/CDP/session tests.
- [ ] Commit as `fix: restore full Chrome recording window`.

### Task 2: Capture the First Stable External Page Poster

**Files:**
- Create: `src/main/recorder/navigation-settler.js`
- Modify: `src/main/recorder/index.js`
- Modify: `src/main/recorder/collectors/network.js`
- Modify: `src/main/recorder/poster-generator.js`
- Modify: `src/main/recorder/http-server.js`
- Modify: `src/main/recorder/video-manifest.js`
- Test: `tests/unit/navigation-settler.test.js`
- Modify: poster, recorder, and HTTP-server tests under `tests/unit/`

**Interfaces:**
- Produces: `navigation-stable` timeline events with URL, loaderId, timestamp, videoOffsetMs, reason, and confidence.
- Consumes: lifecycle events, relevant request start/end/failure, viewport samples, recording start epoch, and video coverage.

- [ ] Write failing tests proving raw navigation plus 750ms is never sufficient, internal pages are rejected, network activity resets quiet time, stable samples choose the first sample, and a bounded deadline provides a fallback.
- [ ] Run the new tests and confirm failure.
- [ ] Implement loader-scoped navigation lifecycle and relevant-request accounting with cleaned-up listeners.
- [ ] Implement visual stability sampling and deadline fallback without waiting forever for WebSocket/long polling.
- [ ] Emit and persist stable candidates during recording.
- [ ] Rewrite poster selection to consume stable candidates and produce a neutral unavailable state when no external page exists.
- [ ] Parse and persist extractor requested and actual offsets.
- [ ] Add a staged local page test (guide color → transition → skeleton → stable color) and assert the selected poster represents the stable state.
- [ ] Run navigation, poster, HTTP-server, and video tests.
- [ ] Commit as `fix: capture poster after first page settles`.

### Task 3: Keep Guidance Beside the Video

**Files:**
- Modify: `src/main/index.js`
- Modify: `ui/styles.css`
- Modify: `tests/unit/app-startup.test.js` or the existing BrowserWindow configuration test
- Modify: `tests/unit/ui-recording-detail.test.js`
- Modify: `tests/unit/ui-recording-library-layout.test.js`

**Interfaces:**
- Produces: Electron content viewport minimum 1200px and an analysis grid with a 360–390px right pane.

- [ ] Write failing tests for `useContentSize: true`, default width 1280, and minimum width 1200.
- [ ] Write failing layout tests requiring the pane to remain to the right at 1200, 1280, and 1440px.
- [ ] Run the targeted tests and confirm old 1080/stacked behavior fails.
- [ ] Update BrowserWindow sizing and remove the Electron stacked-pane breakpoint.
- [ ] Preserve a non-product web fallback only if it cannot affect supported Electron widths.
- [ ] Run layout and startup tests.
- [ ] Commit as `fix: keep recording guidance beside video`.

### Task 4: Replace EasyMDE with the Guided Composer and Progress Capsule

**Files:**
- Create: `ui/guidance-document.js`
- Create: `ui/views/guidance-editor.js`
- Modify: `ui/views/prompt-editor.js`
- Modify: `ui/index.html`
- Modify: `ui/styles.css`
- Modify: `package.json`
- Modify: `package-lock.json`
- Delete: `ui/views/markdown-editor.js`
- Delete: `ui/vendor/easymde/easymde.min.js`
- Delete: `ui/vendor/easymde/easymde.min.css`
- Delete: `ui/vendor/easymde/LICENSE`
- Replace: `tests/unit/ui-markdown-editor.test.js`
- Replace: `tests/unit/ui-markdown-editor-browser.test.js`
- Modify: `tests/unit/ui-prompt-editor.test.js`

**Interfaces:**
- Produces: `mountGuidanceEditor({ root, initialMarkdown, placeholder, labelledBy, describedBy, onChange })` returning `{ kind, getMarkdown, setMarkdown, focus, destroy }`.
- Preserves: `ui/guidance-format.js` v2 persistence.

- [ ] Write codec tests for paragraph/list Markdown-to-DOM-to-Markdown round trips and sanitization.
- [ ] Write real Chromium tests for `- `, `1. `, Enter continuation, empty-item exit, Shift+Enter, plain-text paste, composition, and one-step undo.
- [ ] Run the editor tests and confirm failure before implementation.
- [ ] Implement the constrained contenteditable adapter without per-keystroke `innerHTML` rewrites; add textarea fallback behind the real-browser behavior gate.
- [ ] Write failing prompt-flow tests requiring `第 1 / 3 个问题`, `第 2 / 3 个问题`, and `第 3 / 3 个问题`, with no progress buttons/segments and no focusable question heading.
- [ ] Implement the centered `role=status` capsule, normal question heading, bottom composer, autosize/max-scroll behavior, and focus flow.
- [ ] Remove EasyMDE assets, script/style tags, package dependency, and lockfile-only dependencies.
- [ ] Run editor, prompt, product-boundary, and dependency tests.
- [ ] Commit as `refactor: replace markdown editor with guided composer`.

### Task 5: Export Before Copying the External-Agent Prompt

**Files:**
- Modify: `src/main/recording-library/index.js`
- Modify: `src/main/recording-library/external-agent-prompt.js`
- Modify: `src/main/recorder/http-server.js`
- Modify: `ui/api.js`
- Modify: `ui/views/prompt-editor.js`
- Modify: `tests/unit/recording-library.test.js`
- Modify: `tests/unit/external-agent-prompt.test.js`
- Modify: `tests/unit/recorder-http-server.test.js`
- Modify: `tests/unit/ui-prompt-editor.test.js`

**Interfaces:**
- Produces: `POST /api/recordings/:id/agent-handoff` returning `{ recordingId, path, text }` or a quiet cancellation result.
- Consumes: an authoritative main-process directory chooser and an immutable guidance snapshot.

- [ ] Write failing tests for strict save → chooser → export → final-path prompt ordering, cancellation, save/export failure, private-path exclusion, and copy-only retry.
- [ ] Run the targeted tests and confirm failure.
- [ ] Implement an atomic export using a temporary sibling and final rename, then build the prompt from the final path.
- [ ] Add renderer API and the `导出并复制给外部 Agent` state machine.
- [ ] Preserve the exported path when clipboard copy fails and retry only the copy.
- [ ] Run library, HTTP, prompt, and UI tests.
- [ ] Commit as `feat: export recording before copying agent prompt`.

### Task 6: Restore Interruptible Left Sidebar Motion

**Files:**
- Modify: `ui/app.js`
- Modify: `ui/state.js` if required to avoid remounts
- Modify: `ui/styles.css`
- Modify: `tests/unit/ui-workspace-shell.test.js`
- Modify: related UI browser tests

**Interfaces:**
- Produces: persistent sidebar DOM and a cancellable staged toggle using opacity/transform for labels and one discrete shell geometry commit.

- [ ] Write failing tests proving the same `<aside>` survives toggles, labels do not use `display:none` during motion, and no width/grid/padding property is animated.
- [ ] Write a browser test proving video time and the right-pane editor survive sidebar toggles.
- [ ] Run targeted tests and confirm failure.
- [ ] Refactor sidebar rendering so unrelated state updates patch the mounted node rather than replace it.
- [ ] Implement collapse/expand sequencing with 100–180ms transform/opacity motion, interruption, and reduced-motion behavior.
- [ ] Run workspace shell and browser UI tests.
- [ ] Commit as `feat: restore interruptible sidebar motion`.

### Task 7: Integrated Verification, DMG, and Push

**Files:**
- Create or update: `docs/superpowers/reports/2026-08-10-recording-browser-poster-and-guidance-redesign-verification.md`
- Build output: project `dist/` DMG only; remove redundant app bundles requested by the user.

- [ ] Run the complete unit/integration test command from `package.json` and record exact totals.
- [ ] Run native Swift typecheck/build and packaged native-tool checks.
- [ ] Run headed Chrome verification: address bar/tabs visible, create/switch/navigate tabs, second window excluded, fixed native window identity.
- [ ] Run staged-page poster verification and inspect the generated poster.
- [ ] Capture 1200/1280/1440 light/dark UI evidence for pane placement, progress capsule, short/long composer, review, copy failure, and sidebar motion/reduced motion.
- [ ] Run the production application build.
- [ ] Build the latest macOS arm64 DMG and identify its absolute path and checksum.
- [ ] Remove redundant `.app` outputs outside the packaging staging area when safe; retain the DMG for user installation.
- [ ] Commit the verification report, push `feat/window-video-recording`, and confirm local HEAD equals the remote branch.
