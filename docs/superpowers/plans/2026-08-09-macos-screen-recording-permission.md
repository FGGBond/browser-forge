# macOS Screen Recording Permission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Automatically request and gate macOS screen-recording access before Browser Forge creates recording material or launches Chrome.

**Architecture:** Extend the existing native window recorder with a small JSON permission protocol, wrap it behind a platform-neutral JS service, expose fixed-purpose local HTTP endpoints, and render explicit permission states in the managed recording UI. Electron Main owns the only system-settings URL.

**Tech Stack:** Swift/CoreGraphics, Node.js child_process, Express, Electron shell, browser-native JavaScript, Vitest, Playwright.

## Global Constraints

- macOS ARM64 is the delivered backend; Windows remains an explicit undelivered platform contract.
- Permission failure must not create staging material or launch Chrome.
- The settings endpoint accepts no renderer-provided URL.
- No new runtime dependency or user-installed tool is allowed.
- Do not merge or push the feature branch.

---

### Task 1: Native permission protocol

**Files:**
- Modify: `native/macos/window-recorder/main.swift`
- Modify: `scripts/build-native-tools.mjs`
- Modify: `tests/integration/native-tools-build.test.js`

**Interfaces:**
- Produces: `bf-window-recorder --check-permission|--request-permission` single-line JSON protocol.

- [x] Add failing source/build assertions for CoreGraphics permission commands and protocol states.
- [x] Run the integration test and verify RED.
- [x] Implement argument dispatch and CoreGraphics calls.
- [x] Run the integration test and verify GREEN.

### Task 2: Platform-neutral JS permission client

**Files:**
- Create: `src/main/recorder/screen-recording-permission.js`
- Create: `tests/unit/screen-recording-permission.test.js`
- Modify: `src/main/recorder/native-tools.js`

**Interfaces:**
- Produces: `ScreenRecordingPermission.check()` and `.request()` returning normalized status objects.

- [x] Add failing tests for granted, denied, restart-required, malformed protocol, spawn failure, and unsupported platform.
- [x] Run the unit test and verify RED.
- [x] Implement the minimal client using the registered native window-recorder executable.
- [x] Run the unit test and verify GREEN.

### Task 3: HTTP permission APIs and start gate

**Files:**
- Modify: `src/main/recorder/http-server.js`
- Modify: `tests/unit/recorder-http-server.test.js`

**Interfaces:**
- Consumes: `ScreenRecordingPermission.check/request`.
- Produces: permission GET/request/open-settings endpoints and pre-Chrome start gate.

- [x] Add failing tests proving denied starts do not allocate a port, create staging, or launch Chrome.
- [x] Add failing tests for permission request and fixed-purpose open-settings routes.
- [x] Run focused tests and verify RED.
- [x] Implement routes and gate before all recording side effects.
- [x] Run focused tests and verify GREEN.

### Task 4: Electron Main settings adapter

**Files:**
- Modify: `src/main/index.js`
- Modify: `tests/unit/main-startup.test.js`
- Modify: `tests/unit/shell-ipc.test.js`

**Interfaces:**
- Produces: `openScreenRecordingSettings()` using a fixed macOS settings URL.

- [x] Add failing tests that arbitrary request URL data cannot reach `shell.openExternal`.
- [x] Run tests and verify RED.
- [x] Inject the fixed adapter into the recorder server.
- [x] Run tests and verify GREEN.

### Task 5: Permission-aware recording UI

**Files:**
- Modify: `ui/api.js`
- Modify: `ui/views/recording.js`
- Modify: `ui/styles.css`
- Modify: `tests/unit/ui-start-recording.test.js`

**Interfaces:**
- Consumes: permission APIs.
- Produces: explanatory first-run UI, request/retry/open-settings actions, and restart guidance.

- [x] Add failing Playwright cases for granted, denied, restart-required, and open-settings behavior.
- [x] Run the UI test and verify RED.
- [x] Implement UI state rendering and actions.
- [x] Run the UI test and verify GREEN.

### Task 6: Full verification and commit

**Files:**
- Review all modified files and packaged output.

- [x] Run focused permission tests.
- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Run `npm run package:mac`.
- [x] Execute packaged `bf-window-recorder --check-permission` and validate JSON.
- [x] Audit every design requirement against code and test evidence.
- [x] Commit changes on `feat/window-video-recording`; do not merge or push.
