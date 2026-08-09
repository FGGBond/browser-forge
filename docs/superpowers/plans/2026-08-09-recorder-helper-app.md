# Browser Forge Recorder Helper App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the macOS recorder as one signed nested App Bundle so permission checks, permission requests, and ScreenCaptureKit recording share one TCC identity.

**Architecture:** The native build emits `Browser Forge Recorder.app`; runtime path resolution points both permission and video clients to its executable. A Forge post-package hook moves the Helper to `Contents/Helpers`, copies its icon, signs the complete bundle tree, and verifies it before DMG creation.

**Tech Stack:** Swift/CoreGraphics/ScreenCaptureKit, Node.js, Electron Forge hooks, codesign, Vitest, Playwright.

## Global Constraints

- macOS ARM64 only; preserve the Windows contract without claiming delivery.
- No additional runtime dependency.
- Permission failure must remain before Chrome/staging/video side effects.
- Renderer cannot supply settings URLs or Helper paths.
- Commit to `feat/window-video-recording`; do not merge or push.

---

### Task 1: Helper bundle build contract
- [x] Add failing tests for Helper Info.plist, bundle layout, executable and icon.
- [x] Verify RED.
- [x] Build the Swift executable into a formal `.app` Bundle.
- [x] Verify GREEN.

### Task 2: Unified native path resolution
- [x] Add failing tests for development and packaged Helper executable/app paths.
- [x] Verify RED.
- [x] Update native registry, VideoRecorder and ScreenRecordingPermission resolution.
- [x] Verify GREEN.

### Task 3: Forge packaging and signing
- [x] Add failing packaging tests for the post-package hook and expected `Contents/Helpers` layout.
- [x] Verify RED.
- [x] Implement Helper relocation, icon installation, ad-hoc/developer signing selection and verification.
- [x] Verify GREEN against an actual packaged app.

### Task 4: Recovery APIs and UI
- [x] Add failing Main/HTTP/UI tests for fixed Helper reveal and `再次检查权限` semantics.
- [x] Verify RED.
- [x] Implement fixed Main adapter, API route and UI actions/copy.
- [x] Verify GREEN.

### Task 5: Full verification and DMG
- [x] Run focused tests.
- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Run `npm run package:mac`.
- [x] Run `npm run make:mac`.
- [x] Mount DMG and verify Helper location, Info.plist, code signatures and permission JSON.
- [x] Commit; do not merge or push.
