# Window Video Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture only the Browser Forge-launched Chrome native window into a portable H.264 MP4, correlate every timeline event to the first persisted video frame, and let the installed Browser Forge analysis skill extract a frame without user-installed dependencies.

**Architecture:** Electron launches Chrome with a cryptographically unique temporary title. A macOS ScreenCaptureKit sidecar binds exactly one window by Chrome PID and that title, streams it into AVAssetWriter, and reports the epoch of the first successfully appended frame. JavaScript writes the video manifest and maps CDP timestamps to `videoOffsetMs`; a second bundled AVFoundation executable extracts PNG frames through an analysis-skill wrapper.

**Tech Stack:** Electron/Node ESM, Vitest, Swift 6 (`ScreenCaptureKit`, `AVFoundation`, `ImageIO`), H.264 MP4, Electron Forge `extraResource`.

## Global Constraints

- Target macOS is **14.2+**; current delivery only implements Darwin, but keeps the JS interface and CLI contract for Windows 11.
- Capture exactly the Chrome window launched for this session; PID + random title must yield exactly one eligible native window; no fallback is permitted.
- Video `0ms` equals the first screen sample successfully appended to the MP4 writer.
- Every key timeline event must have `timestamp` and `videoOffsetMs`; consumers use the latter.
- No runtime dependency on ffmpeg, Homebrew, npm install, pip, Python, or PATH-provided tooling.
- Video states are only `complete`, `partial`, and `failed`; a partial file is valid only through `coveredUntilOffsetMs`.
- Do not record audio or a display/monitor.
- Preserve existing CDP screenshots during this milestone as a fallback and regression aid; do not replace them yet.
- Never record, persist, or introduce credentials in fixtures, logs, or documentation.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/main/recorder/video-manifest.js` | Pure JS validation/construction of v1 video manifests and timeline offsets. |
| `src/main/recorder/video-recorder.js` | Platform facade around a bundled `bf-window-recorder` child process. |
| `src/main/recorder/native-tools.js` | Resolve development and packaged macOS native executable paths. |
| `src/main/recorder/index.js` | Accept video start data, add offsets to timeline events, finalise video before writing. |
| `src/main/recorder/http-server.js` | Generate title token, start video before CDP collection, stop recorder before material write. |
| `src/main/recorder/output-writer.js` | Place MP4 + manifest in the recording material and document them. |
| `ui/recording-start.html` | Set document title from `bfRecordingTitle` query parameter. |
| `native/macos/window-recorder/main.swift` | Strict ScreenCaptureKit window capture into H.264 MP4 JSON protocol. |
| `native/macos/video-frame-cli/main.swift` | AVFoundation offset-to-PNG JSON protocol. |
| `scripts/build-native-tools.mjs` | Deterministically compile the two arm64 native tools with `swiftc`. |
| `skills/browser-forge/scripts/extract-video-frame` | Portable analysis-skill argument/manifest validation and binary launcher. |
| `skills/browser-forge/references/video-analysis.md` | Agent protocol: locate events, use `videoOffsetMs`, extract narrowly. |
| `skills/browser-forge/assets/video-tools/manifest.json` | Platform/arch binary hashes and protocol version. |
| `src/main/agent-skill-installer.js` | Verify/copy executable skill assets. |
| `forge.config.cjs` | Copy app-native recorder binaries into Electron resources. |

## Task 1: Establish executable protocol and pure JS video contract

**Files:**
- Create: `src/main/recorder/video-manifest.js`
- Create: `src/main/recorder/video-recorder.js`
- Create: `tests/unit/video-manifest.test.js`
- Create: `tests/unit/video-recorder.test.js`

**Interfaces:**
- `createVideoManifest({ state, file, startEpochMs, durationMs, coveredUntilOffsetMs, window, fps }) -> object`
- `addVideoOffset(event, startEpochMs) -> object`
- `VideoRecorder.start({ chromePid, expectedWindowTitle, outputPath }) -> Promise<VideoStart>`
- `VideoRecorder.stop() -> Promise<VideoResult>`

- [ ] **Step 1: Write failing unit tests** for exact state validation, non-negative offset clamping, passed-through `window` identity, JSON ready/completed messages, native spawn failures, and explicit unsupported-platform errors.
- [ ] **Step 2: Run tests to verify failure.** Run: `npx vitest run tests/unit/video-manifest.test.js tests/unit/video-recorder.test.js`. Expected: import/module failures.
- [ ] **Step 3: Implement the smallest pure JS manifest helpers and injectable sidecar facade.** The facade must not invoke a shell and must only accept line-delimited JSON from stdout.
- [ ] **Step 4: Re-run focused tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `git add src/main/recorder/video-*.js tests/unit/video-*.test.js && git commit -m "feat: add video recording contract"`

## Task 2: Start and stop window video capture in the recording lifecycle

**Files:**
- Modify: `src/main/recorder/http-server.js`
- Modify: `src/main/recorder/index.js`
- Modify: `src/main/chrome-launcher.js`
- Modify: `ui/recording-start.html`
- Modify: `tests/unit/recorder-http-server.test.js`
- Modify: `tests/unit/recording-session-screenshots.test.js`

**Interfaces:**
- `RecordingSession({ port, outputDir, video })`, where `video.startEpochMs` is set only after the first written video frame.
- `VideoRecorder` follows Task 1.

- [ ] **Step 1: Write failing HTTP-server tests** that require a random title in the launch URL, require video to start after CDP readiness but before `RecordingSession.start`, and require video stop before `RecordingSession.stop`.
- [ ] **Step 2: Write failing session tests** that assert click, keydown, navigation and final timeline entries include correctly derived `videoOffsetMs`.
- [ ] **Step 3: Implement lifecycle integration.** On a video-start failure, kill Chrome, clear state and return `ok:false`; no CDP material is started. On stop, preserve a partial result and hand it to the session writer.
- [ ] **Step 4: Set the temporary initial-page title** from `bfRecordingTitle` and use only the title captured at launch as the native match criterion.
- [ ] **Step 5: Run focused tests.** `npx vitest run tests/unit/recorder-http-server.test.js tests/unit/recording-session-screenshots.test.js`.
- [ ] **Step 6: Commit.** `git add src/main/recorder/http-server.js src/main/recorder/index.js src/main/chrome-launcher.js ui/recording-start.html tests/unit && git commit -m "feat: correlate recording events with window video"`

## Task 3: Write MP4 and manifest into Browser Forge recording materials

**Files:**
- Modify: `src/main/recorder/output-writer.js`
- Modify: `tests/unit/output-writer.test.js`
- Modify: `tests/integration/recorder.test.js`

**Interfaces:**
- `writeSession({ ..., video })` copies/renames complete and partial MP4s into `<sessionDir>/video/recording.mp4`, writes `<sessionDir>/video/manifest.json`, then removes the temporary source only after success.

- [ ] **Step 1: Write failing output tests** for exact directory layout, manifest state, source-file cleanup policy, and `RECORDING.md` documentation.
- [ ] **Step 2: Implement atomic video placement** (`copyFile` to an in-directory temp name, `rename`, then source deletion) and v1 manifest writing. Failed/no-video conditions write no fake MP4.
- [ ] **Step 3: Extend the integration test with a synthetic temp MP4**, asserting timeline event offsets and video paths without requiring Screen Recording permission.
- [ ] **Step 4: Run focused tests.** `npx vitest run tests/unit/output-writer.test.js tests/integration/recorder.test.js`.
- [ ] **Step 5: Commit.** `git add src/main/recorder/output-writer.js tests/unit/output-writer.test.js tests/integration/recorder.test.js && git commit -m "feat: write video recording materials"`

## Task 4: Implement native macOS window recorder

**Files:**
- Create: `native/macos/window-recorder/main.swift`
- Create: `scripts/build-native-tools.mjs`
- Create: `tests/integration/native-tools-build.test.js`

**Interfaces:**
- Invocation: `bf-window-recorder --chrome-pid <pid> --expected-window-title <title> --output <temp.mp4> --fps 15 --timeout-ms 10000`.
- stdout ready: `{"type":"started","startEpochMs":...,"window":{...}}` after first append succeeds.
- stdin `{"type":"stop"}` requests graceful `finishWriting`; stdout completion contains `state`, `durationMs`, `coveredUntilOffsetMs` and window identity.

- [ ] **Step 1: Write a build-contract test** that invokes the build script and checks both Mach-O executables exist and are executable; skip only off Darwin.
- [ ] **Step 2: Run it to verify absence fails.**
- [ ] **Step 3: Implement strict candidate discovery** using `SCShareableContent`, PID/title/on-screen predicates and `SCContentFilter(desktopIndependentWindow:)`. Return structured error for zero/multiple candidates and TCC-denied content enumeration.
- [ ] **Step 4: Implement capture and encoding** using `SCStreamOutput`, host-clock epoch conversion, `AVAssetWriter` H.264 writer input, first-sample `startSession`/append readiness, and graceful stdin stop.
- [ ] **Step 5: Compile and run build contract.** `node scripts/build-native-tools.mjs && npx vitest run tests/integration/native-tools-build.test.js`.
- [ ] **Step 6: Commit.** `git add native/macos/window-recorder scripts/build-native-tools.mjs tests/integration/native-tools-build.test.js && git commit -m "feat: add macOS Chrome window video recorder"`

## Task 5: Implement dependency-free native PNG frame extraction

**Files:**
- Create: `native/macos/video-frame-cli/main.swift`
- Create: `tests/integration/video-frame-cli.test.js`

**Interfaces:**
- Invocation: `bf-video-frame --input <recording.mp4> --offset-ms <ms> --output <png>`.
- stdout success: one JSON line with requested/actual offset plus image size.

- [ ] **Step 1: Write a fixture generator/test.** Use AVFoundation or a committed minimal fixture to verify `offset-ms 0` produces a valid PNG and dimensions; do not call ffmpeg.
- [ ] **Step 2: Implement image generation** with `AVAssetImageGenerator`, tolerances that select the nearest frame and ImageIO PNG encoding.
- [ ] **Step 3: Extend native build script and run focused test.**
- [ ] **Step 4: Commit.** `git add native/macos/video-frame-cli scripts/build-native-tools.mjs tests/integration/video-frame-cli.test.js && git commit -m "feat: add native video frame extraction"`

## Task 6: Package native tools and install analysis-skill video tool

**Files:**
- Modify: `package.json`
- Modify: `forge.config.cjs`
- Modify: `src/main/recorder/native-tools.js`
- Modify: `src/main/agent-skill-installer.js`
- Create: `skills/browser-forge/scripts/extract-video-frame`
- Create: `skills/browser-forge/references/video-analysis.md`
- Create: `skills/browser-forge/assets/video-tools/manifest.json`
- Modify: `skills/browser-forge/SKILL.md`
- Modify: `tests/unit/agent-skill-installer.test.js`
- Modify: `tests/unit/packaging-config.test.js`
- Modify: `tests/skill-generation/skill-docs.test.js`

**Interfaces:**
- App build runs `node scripts/build-native-tools.mjs` before `electron-vite build`.
- Forge copies `native-tools` to resources outside ASAR.
- Skill command supports `--recording-dir`, `--offset-ms`, `--output`, optional `--overwrite` and produces one JSON line or structured error.

- [ ] **Step 1: Write failing wrapper tests** for manifest validation, range/partial detection, output refusal, unsupported platform, binary SHA verification and executable copied mode.
- [ ] **Step 2: Implement the shell wrapper without external package calls.** It validates using Node built-ins; its only child process is the installed bundled binary.
- [ ] **Step 3: Update SKILL.md and reference** with the exact extraction command and the rule to use `timeline[].videoOffsetMs` rather than manually subtracting timestamps.
- [ ] **Step 4: Configure packaging** so native tools are built prior to macOS packaging and copied outside ASAR; add tests asserting both conditions.
- [ ] **Step 5: Run focused tests.** `npx vitest run tests/unit/agent-skill-installer.test.js tests/unit/packaging-config.test.js tests/skill-generation/skill-docs.test.js`.
- [ ] **Step 6: Commit.** `git add package.json forge.config.cjs src/main/recorder/native-tools.js src/main/agent-skill-installer.js skills/browser-forge tests && git commit -m "feat: ship video analysis tools with browser forge skill"`

## Task 7: Verify regressions and manual macOS authorization path

**Files:**
- Modify only if verification reveals a defect.

- [ ] **Step 1: Clean-install dependencies.** `npm ci`.
- [ ] **Step 2: Run full test suite.** `npm test`.
- [ ] **Step 3: Build developer tools and the packaged app.** `node scripts/build-native-tools.mjs && npm run package:mac`.
- [ ] **Step 4: Manually run Browser Forge.app.** Start a recording, grant macOS **Screen Recording** permission to the final app when prompted, interact with a webpage, and stop.
- [ ] **Step 5: Verify material.** Check the MP4 plays, `video/manifest.json` is `complete`, several timeline events have `videoOffsetMs`, and `extract-video-frame` returns a PNG for an event offset.
- [ ] **Step 6: Verify failure handling.** Revoke Screen Recording permission, try start, and ensure no fallback capture begins and the UI receives the native error.
- [ ] **Step 7: Final review and commit.** Run `git status --short`, inspect diff, request code review, then commit verification-only fixes if any.
