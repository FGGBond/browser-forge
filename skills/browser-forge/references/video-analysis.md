# Window video analysis

A recording can contain `video/recording.mp4`, the full native Chrome window (including tabs, address bar and page), and `video/manifest.json`.

1. Read `timeline.json` first. For an event with visual context, use its **`videoOffsetMs`** field. Do not subtract epoch timestamps yourself.
2. Read `video/manifest.json`. A `complete` video is usable through `durationMs` and must have `coveredUntilOffsetMs === durationMs`; a `partial` video is only usable through `coveredUntilOffsetMs`; a valid `failed` video has zero duration/coverage and no file. Treat `VIDEO_MANIFEST_INVALID` as corrupt or contradictory material—do not infer visual context from it.
3. Extract only the frame necessary to resolve an ambiguity. The stable,
   cross-platform entry point is the Node script:

```bash
node skills/browser-forge/scripts/extract-video-frame.mjs \
  --recording-dir "/absolute/path/to/recording" \
  --offset-ms 12345 \
  --output "/tmp/browser-forge-frame-12345.png"
```

On macOS/Linux, the Bash launcher is a convenience alias with the same
arguments and one-line JSON contract:

```bash
bash skills/browser-forge/scripts/extract-video-frame \
  --recording-dir "/absolute/path/to/recording" \
  --offset-ms 12345 \
  --output "/tmp/browser-forge-frame-12345.png"
```

The command emits exactly one JSON line and requires no ffmpeg, Homebrew, npm install, pip, Python, or system PATH video utility. It calls the native extractor installed alongside this analysis skill. With `--overwrite`, an existing PNG is replaced only after extraction succeeds; validation or decode failures preserve the old file.

The currently bundled extractor target is `darwin-arm64` with a macOS 14.2 deployment target. The script selects tools through `assets/video-tools/manifest.json` using `<platform>-<arch>`; other targets fail with a structured `UNSUPPORTED_PLATFORM` error instead of attempting to download a dependency or falling back to an unrelated system tool. The Windows launcher is `scripts/extract-video-frame.cmd`; a future Windows package will provide `win32-x64/bf-video-frame.exe` behind the same arguments and JSON contract.

Do not use a video frame to invent an unrecorded request or side effect. Correlate it with the timeline, HAR, DOM snapshots and the user's stated goal.
