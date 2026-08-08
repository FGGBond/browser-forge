# Window video analysis

A recording can contain `video/recording.mp4`, the full native Chrome window (including tabs, address bar and page), and `video/manifest.json`.

1. Read `timeline.json` first. For an event with visual context, use its **`videoOffsetMs`** field. Do not subtract epoch timestamps yourself.
2. Read `video/manifest.json`. A `complete` video is usable through `durationMs`; a `partial` video is only usable through `coveredUntilOffsetMs`; a `failed` video has no usable frames.
3. Extract only the frame necessary to resolve an ambiguity:

```bash
bash skills/browser-forge/scripts/extract-video-frame \
  --recording-dir "/absolute/path/to/recording" \
  --offset-ms 12345 \
  --output "/tmp/browser-forge-frame-12345.png"
```

The command emits one JSON line and requires no ffmpeg, Homebrew, npm install, pip, Python, or system PATH video utility. It calls the native extractor installed alongside this analysis skill.

Do not use a video frame to invent an unrecorded request or side effect. Correlate it with the timeline, HAR, DOM snapshots and the user's stated goal.
