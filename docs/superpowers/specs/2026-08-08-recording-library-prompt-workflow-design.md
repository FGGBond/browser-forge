# Browser Forge Recording Library and Prompt Workflow Design

**Date:** 2026-08-08
**Status:** Approved design
**Scope:** Ideas 2 and 3, building on the completed native window-video recording work

## 1. Objective

Browser Forge must stop treating a recording as a filesystem path the user has to choose, remember, and manually pass to an Agent. Recordings become first-class App-managed objects that users can browse, name, preview, explain, export, move to an App recycle bin, restore, and permanently delete.

Each recording also owns one Agent-guidance prompt. Browser Forge generates a complete external-Agent instruction from the recording and that prompt, so a user does not need to understand the internal session layout or manually compose a browser-forge skill invocation.

The implementation must preserve these existing invariants:

- window video records only the Browser Forge Chrome window;
- timeline events correlate to video through `videoOffsetMs`;
- Agent frame extraction remains self-contained and requires no FFmpeg, Homebrew, Python, or pip installation;
- failed video capture must not invalidate HAR, timeline, DOM, console, scripts, screenshots, or other CDP material;
- macOS is delivered first while shared library behavior remains portable to Windows.

## 2. Scope

### Included

- an App-owned recording workspace under Electron `userData`;
- an indexed recording library that can repair itself from recording directories;
- recording list, detail, video playback, and event-to-video seeking;
- recording naming and search;
- App recycle bin, restore, and explicit permanent deletion;
- export of an independent recording copy;
- one persisted prompt per recording;
- a guided prompt template and complete external-Agent prompt generation;
- removal of output-directory selection from the normal recording flow;
- path-safe HTTP APIs and Electron-owned native directory selection;
- packaged macOS operation without new runtime dependencies;
- shared contracts and boundaries suitable for a later Windows capture backend.

### Excluded

- Reasonix or another built-in code Agent;
- API-key configuration and hosted model execution;
- cloud sync, collaboration, or account management;
- automatic recycle-bin expiry;
- SQLite or another external database;
- replacing all existing screenshot material;
- implementing the Windows native capture binary in this phase.

The UI may reserve a future built-in-Agent action, but it must not appear enabled or imply that analysis is available before that feature exists.

## 3. Current-State Constraints

The production Electron window currently loads the static UI from `ui/index.html` through the local recorder HTTP server. The React files under `src/renderer` are not the active product UI.

The existing flow is linear:

```text
Setup with Chrome path and output directory
→ live recording inspector
→ completed screen displaying the session path
```

`RecordingSession.stop()` creates an immutable session directory through `writeSession()`. Video material is copied through a temporary file and atomically renamed before the video manifest claims that the MP4 exists. This write behavior remains the basis of managed recording persistence.

## 4. Chosen Architecture

Use a hybrid filesystem architecture:

1. each recording directory is the authoritative source for that recording;
2. `library.json` is a small, rebuildable list index;
3. all mutations are serialized and written atomically;
4. no new database or native runtime dependency is introduced.

```text
<app.getPath('userData')>/recordings/
├── library.json
├── active/
│   └── <recording-id>/
│       ├── recording.json
│       ├── metadata.json
│       ├── timeline.json
│       ├── recording.har
│       ├── RECORDING.md
│       ├── prompt.md                 # created on first non-empty save
│       ├── video/
│       │   ├── manifest.json
│       │   ├── recording.mp4
│       │   └── poster.png            # best effort
│       └── tabs/
├── trash/
│   └── <recording-id>/
└── staging/
    └── <recording-id>/
```

The Electron main process obtains the root from `app.getPath('userData')` and injects it into the recorder server. Lower layers must not guess Electron paths.

### Why this architecture

- unlike startup-only scanning, list and search operations do not read every recording file;
- unlike SQLite, it does not add native packaging, migration, or cross-platform dependency risk;
- if `library.json` is absent or malformed, it can be reconstructed from `active` and `trash`;
- recording directories remain portable, inspectable, and independently exportable;
- future prompt and Agent-analysis state can evolve without changing capture material formats.

## 5. Recording Identity and Lifecycle

A UUID recording ID is created when recording starts. It is distinct from the Chrome-window title token and remains stable for the lifetime of the managed recording.

The recorder receives the managed staging root and the recording ID. Session output is written as `staging/<recording-id>` rather than a user-selected directory. The existing writer still creates a new non-overwriting directory and preserves its atomic MP4 behavior.

### Start

1. Generate the recording ID.
2. Launch the isolated Browser Forge Chrome window.
3. Start native window video capture.
4. Start CDP collection with output directed to the managed staging location.
5. Display the live recording state in memory; incomplete captures are not listed as completed library entries.

### Stop and promote

1. Finalize the native MP4.
2. Write CDP and video material into `staging/<recording-id>`.
3. Write `recording.json` atomically.
4. Generate `video/poster.png` on a best-effort basis with the bundled native frame extractor.
5. Rename the completed directory to `active/<recording-id>` on the same filesystem.
6. Atomically update `library.json`.
7. Navigate directly to the new recording detail view.

If material writing succeeds but promotion or index update is interrupted, startup reconciliation adopts the staging recording. A failed poster does not fail promotion. A failed video remains a valid managed recording with its manifest state exposed in the UI.

## 6. Recording Metadata

### `recording.json`

This file contains mutable App-management metadata. Capture metadata remains in the existing `metadata.json`.

```json
{
  "schemaVersion": 1,
  "id": "3d4527e4-4d47-4aea-a4ba-cd61218bbd27",
  "title": "example.com · 8月8日 20:15",
  "state": "active",
  "createdAt": "2026-08-08T12:15:00.000Z",
  "updatedAt": "2026-08-08T12:18:00.000Z",
  "trashedAt": null,
  "capture": {
    "status": "complete",
    "durationMs": 42000
  },
  "video": {
    "status": "complete",
    "relativePath": "video/recording.mp4",
    "posterRelativePath": "video/poster.png"
  },
  "prompt": {
    "status": "empty",
    "updatedAt": null
  }
}
```

No absolute path is persisted in recording metadata. This keeps an exported directory self-contained and portable.

The default title is derived from the first meaningful non-Browser-Forge website host and localized creation time. If no meaningful host exists, the title starts with `未命名录制`.

### `library.json`

The global index stores only fields required by list rendering, sorting, and search.

```json
{
  "schemaVersion": 1,
  "revision": 42,
  "recordings": [
    {
      "id": "3d4527e4-4d47-4aea-a4ba-cd61218bbd27",
      "title": "example.com · 8月8日 20:15",
      "state": "active",
      "createdAt": "2026-08-08T12:15:00.000Z",
      "durationMs": 42000,
      "startHost": "example.com",
      "videoStatus": "complete",
      "promptStatus": "draft"
    }
  ]
}
```

`revision` increases after every successful mutation. The recording directories, not this index, are authoritative.

## 7. Atomicity and Reconciliation

All library mutations run through one serialized mutation queue. The queue covers rename, prompt save, trash, restore, permanent delete, promotion, and index updates. Export takes a stable snapshot of the selected recording and prevents destructive mutation of that recording until copying finishes.

JSON and prompt writes use a sibling temporary file followed by rename. The implementation must not update in place.

On startup, reconciliation:

1. validates and scans `active`, `trash`, and `staging` without following symlinks;
2. validates recording directory names and recording IDs;
3. repairs `recording.json.state` from the authoritative parent directory;
4. adopts complete staging recordings and isolates incomplete or malformed staging entries;
5. adds directories missing from the index;
6. removes index entries whose directories no longer exist;
7. rebuilds `library.json` if it is missing or invalid;
8. never silently deletes an unrecognized directory.

A malformed recording remains visible with a repair/error state when enough identity metadata is available. Otherwise it is left untouched and reported in the startup log.

## 8. App Information Architecture

The App opens directly into the recording library rather than a setup page.

```text
┌──────────────┬─────────────────────┬──────────────────────────────┐
│ Navigation   │ Recording list      │ Recording detail             │
│              │                     │                              │
│ All          │ title               │ editable title               │
│ Trash        │ time, host, duration│ video and event timeline     │
│              │ status and poster   │ metadata and prompt editor   │
│ + New        │                     │ export and trash actions     │
└──────────────┴─────────────────────┴──────────────────────────────┘
```

At narrow widths the list and detail become navigable screens instead of compressing the video player below a usable size.

The first version supports title search and newest-first ordering. Additional filters are deferred.

## 9. New Recording Experience

Output-directory selection is removed.

The normal new-recording surface explains that Browser Forge opens and records one isolated Chrome window and provides one primary start button. Chrome is auto-detected. Manual Chrome-path selection appears only when detection fails or under advanced settings.

During recording, the existing live inspector remains available. Library-destructive actions are unavailable for the active in-memory recording. Stopping automatically opens the newly promoted recording detail; the user is not shown an internal session path as the completion destination.

## 10. Video Preview and Event Navigation

The detail view uses Chromium's native `<video>` element for H.264 MP4 playback. The server implements byte-range responses so seeking does not require downloading the entire file.

The UI provides play, pause, seek, fullscreen, elapsed time, duration, and left/right keyboard seeking. Audio controls are omitted because capture contains no audio.

A compact key-event list is derived from `timeline.json`. Selecting an event seeks to:

```text
event.videoOffsetMs / 1000
```

Events without a valid video offset remain inspectable but cannot seek the player. Out-of-range offsets are visibly disabled rather than clamped silently.

The video route is resolved only through a validated recording ID and manifest. It must never accept an arbitrary filesystem path.

### Poster generation

After successful material writing, the bundled native frame tool extracts a best-effort poster at:

```text
min(1000 ms, 20% of video duration)
```

The exact offset may be adjusted to a decodable frame by the extractor. Poster failure uses a standard placeholder and does not alter video status.

## 11. Naming

The title is edited in the detail header. Enter or blur commits; Escape restores the previous value. Titles are trimmed, have a documented maximum length, and may contain characters not legal in filenames because internal directories are UUID-based.

Renaming updates `recording.json` and `library.json` atomically through the mutation queue. It never renames the internal recording directory.

## 12. App Recycle Bin

Deletion from the active library means moving the recording into the App recycle bin, not deleting bytes.

```text
active/<id> → trash/<id>
```

Because both directories share one root, the move uses an atomic rename. Directory location is authoritative. After the move, metadata and the index are repaired to `state: "trashed"` with `trashedAt` set. If interruption occurs between those operations, reconciliation repairs the metadata from directory location.

The UI offers a short-lived undo action after trashing.

Trash detail permits restore and permanent delete. Analysis and prompt-copy actions are disabled until restoration, so generated prompts never reference a transient trash path.

Restore performs the inverse rename and retains title, prompt, timestamps, video, and capture material.

Permanent deletion:

- requires an explicit destructive confirmation showing title and material size;
- is unavailable while export or another mutation is active;
- recursively removes only the validated directory under `trash`;
- updates the index only after removal succeeds;
- reports partial filesystem failure rather than pretending deletion completed.

There is no automatic trash expiry in this phase.

## 13. Export

Export creates an independent directory copy and never moves or mutates the managed recording.

The Electron main process owns the native directory picker. The renderer provides only the recording ID; it does not submit an arbitrary source or destination path to the HTTP server.

The destination name is based on a sanitized title and timestamp. Name conflicts receive deterministic numeric suffixes. Copying occurs into a temporary sibling directory followed by rename, so an interrupted export is not presented as complete.

The export includes all capture files, `recording.json`, and `prompt.md` when present. A generated export README may explain that the directory can be supplied to the browser-forge skill. Internal managed absolute paths are not persisted into the exported files.

After success, the UI can reveal the copy in Finder on macOS or Explorer on Windows.

## 14. Prompt Workflow

Each active recording owns at most one `prompt.md`. The file is created on the first non-empty save. Clearing a prompt removes the content and returns prompt status to `empty`; the implementation may remove the empty file.

The editor starts with a guided template covering:

- what the user did in the recording;
- what the generated skill should accomplish;
- expected inputs;
- expected outputs or page changes;
- success criteria;
- constraints and risk-sensitive steps.

The initial Chinese template is:

```text
我在这段录制中完成了：

[描述你刚才进行了哪些操作，以及为什么这样操作]

我希望生成的 Browser Forge skill 实现：

[描述未来希望 Agent 自动完成的目标]

调用这个 skill 时，用户会提供：

[输入参数，例如订单号、商品链接、查询日期]

skill 应返回或产生：

[输出结果或页面变更]

成功标准：

[什么结果代表操作成功]

限制和注意事项：

[登录状态、操作风险、不可执行的步骤等]
```

Input is saved after a 500 ms debounce. The UI exposes saving, saved, and failed states. Navigation away from a dirty editor flushes the pending save or asks the user to remain if saving fails.

### Complete external-Agent prompt

The copy action generates, at copy time, a complete instruction containing:

1. an instruction to use the installed browser-forge analysis skill;
2. the validated absolute path of the active managed recording;
3. the user's persisted guidance;
4. an instruction to produce an independently runnable skill and CLI package.

The managed absolute path is displayed in the copy preview but is not persisted inside `prompt.md`. This removes manual path handling while allowing an external local Agent to access the recording.

The generation function is a standalone domain service so a future built-in Agent can consume the identical prompt contract. Built-in Agent execution remains out of scope.

## 15. API and Service Boundaries

A `RecordingLibrary` service owns all recording lookup, path resolution, mutation, reconciliation, and export-source validation. HTTP route handlers do not construct recording paths directly.

Planned API surface:

```text
GET    /api/recordings?state=active|trashed
GET    /api/recordings/:id
PATCH  /api/recordings/:id
GET    /api/recordings/:id/video
GET    /api/recordings/:id/poster
GET    /api/recordings/:id/timeline
GET    /api/recordings/:id/prompt
PUT    /api/recordings/:id/prompt
GET    /api/recordings/:id/external-agent-prompt
POST   /api/recordings/:id/trash
POST   /api/recordings/:id/restore
DELETE /api/recordings/:id
POST   /api/recordings/:id/export
```

The Electron main process injects a `chooseExportDirectory()` callback into the recorder server. `POST /api/recordings/:id/export` invokes that callback, then passes the selected destination directly to `RecordingLibrary`; the destination path is never accepted from renderer JSON. Non-Electron development and tests provide an explicit adapter or return an unsupported-shell error.

Responses use stable error codes for not found, invalid state, busy, invalid input, corrupt material, export canceled, and filesystem failure.

## 16. Security and Privacy

- The HTTP server remains bound to `127.0.0.1` and does not enable permissive CORS.
- Recording IDs are validated UUIDs, not relative paths.
- Path containment is checked after resolution and before every destructive or read operation.
- Reconciliation and export do not follow symlinks out of the library root.
- Video, poster, timeline, and prompt routes resolve through `RecordingLibrary` only.
- Request bodies have explicit size limits, especially prompt input.
- Prompt text and recording content are local-only and are not added to telemetry.
- Telemetry may report aggregate action names and success/error codes but never titles, prompt text, URLs with paths or queries, or local paths.

## 17. UI Code Organization

The current active static UI is a large single HTML file. This feature should split affected behavior into build-free ES modules while preserving the existing local-server delivery model:

```text
ui/
├── index.html
├── styles.css
├── app.js
├── api.js
├── state.js
└── views/
    ├── library.js
    ├── recording.js
    ├── detail.js
    ├── prompt-editor.js
    └── trash.js
```

This is a targeted separation, not a React migration. The unused React renderer is not made authoritative as part of this work.

## 18. Cross-Platform Design

The following behavior is platform-neutral and implemented once:

- root selection through injected Electron `userData`;
- JSON index and per-recording metadata;
- staging, active, and trash transitions;
- reconciliation;
- prompt persistence and generation;
- video Range serving;
- recording list and detail UI;
- export-copy semantics.

Platform-specific adapters cover native capture, native frame extraction, native directory dialogs, and reveal-in-file-manager behavior.

The Windows capture implementation will later use the already designed Windows Graphics Capture and Media Foundation backend. Adding that binary must not require changing recording-library APIs or UI data contracts.

## 19. Failure Behavior

- Video capture failure: preserve and display the recording with failed video status.
- Poster extraction failure: use a placeholder and keep video status unchanged.
- Prompt write failure: preserve editor text in memory, show failure, and do not claim saved.
- Index corruption: rebuild from directories.
- Metadata corruption: isolate or show a repair state; do not delete automatically.
- Interrupted trash/restore: repair state from directory location.
- Interrupted export: leave only a clearly temporary destination that can be cleaned on the next export attempt.
- App quit during active recording: retain the existing orderly recorder shutdown and promote material when stop succeeds.
- Native screen-recording permission failure: show the actionable macOS permission error and do not create a false completed recording.

## 20. Verification and Acceptance Criteria

The implementation is accepted only when evidence demonstrates all of the following:

1. A user can start recording without selecting an output directory.
2. Recordings are stored under the injected App workspace and survive App restart.
3. A recording list displays title, time, duration, host, and video state.
4. H.264 video plays and seeks through byte-range responses.
5. Selecting a correlated event seeks to its `videoOffsetMs`.
6. Invalid or out-of-range event offsets cannot seek silently.
7. Renaming persists across restart without renaming the UUID directory.
8. Prompt text saves atomically and remains one-to-one with the recording.
9. Complete external-Agent prompt copy includes the managed recording path and user guidance.
10. Trashing moves material into the App recycle bin without deleting it.
11. Restore returns all video, prompt, and capture material unchanged.
12. Permanent deletion operates only on a validated trash entry.
13. Export produces a complete independent copy and leaves the managed source unchanged.
14. Missing or corrupt `library.json` is rebuilt from recording directories.
15. Path traversal and symlink escape attempts cannot expose or delete outside files.
16. Video or poster failure does not hide valid non-video material.
17. Existing Agent frame extraction still works from managed and exported recording directories without additional installation.
18. Existing window-recording and recorder lifecycle tests remain green.
19. UI tests cover library, detail, playback source, rename, prompt save/copy, trash, restore, and export states.
20. `npm test`, production build, macOS package, and packaged-ASAR smoke verification pass.
21. The delivered macOS App requires no new runtime dependency.
22. Shared recording-library tests run independently of macOS-native capture and remain suitable for Windows CI.

## 21. Implementation Sequence

Implementation should proceed in independently testable slices:

1. recording-library filesystem model, atomic mutations, and reconciliation;
2. managed start/stop output and promotion;
3. library/detail HTTP APIs, safe video Range serving, and export boundary;
4. recording library and detail UI;
5. recycle-bin and restore UI;
6. prompt persistence and complete external-Agent prompt generation;
7. event-to-video navigation and poster integration;
8. packaged verification, migration/compatibility checks, and full acceptance audit.
