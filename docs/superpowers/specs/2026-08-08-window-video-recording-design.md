# Browser Forge 窗口级视频录制设计

## 目标与边界

本阶段为一次 Browser Forge 录制新增一段 **Chrome 原生窗口级** H.264 MP4 视频。它服务于两个场景：

1. Agent 依据 `timeline.json` 中事件的 `videoOffsetMs`，按需提取指定时刻的可视上下文。
2. 后续应用内的录制物料库以这段视频进行预览、命名、删除和导出。

本阶段只实现 **macOS 14.2 及以上**，并为 Windows 11 保留同一 JavaScript 接口和产物契约；不实现物料库 UI、录制物料迁移或内置 Agent。

## 不可违反的录制边界

录制对象必须是 Browser Forge 本次启动的完整 Chrome 原生窗口（浏览器工具栏、标签页、地址栏和网页内容）。下列方案均不合格：

- 整个屏幕或显示器录制；
- Desktop Duplication / 显示器录制后裁剪；
- "最大的 Chrome 窗口"、"第一个 Chrome 窗口"、前台窗口；
- 用户手工任意选取的窗口；
- 仅 CDP viewport 截图。

启动时 Browser Forge 生成 128-bit session token，并将 Chrome 初始页标题设为 `Browser Forge Recording · <token>`。原生录制器仅允许匹配：

- `owningApplication.processID === chromeProcess.pid`；
- `window.title === expectedWindowTitle`；
- `window.isOnScreen === true`；
- 合格候选数 **严格等于 1**。

候选为 0 时最多等待 10 秒；候选多于 1 时立即失败；绝不降级到其他窗口或显示器。窗口在初始页阶段绑定后，即使网页导航修改 document title，流继续绑定同一个原生窗口。

## 时间轴契约

视频的零点不是点击“开始录制”的时间，也不是 CDP 连接时间，而是：

> 第一个被 `AVAssetWriterInput.append` 成功写入 MP4 的 ScreenCaptureKit video sample。

原生录制器在该 sample 到达时，以 `CMSampleBuffer` 的 PTS、host clock 与 Unix epoch 建立 `startEpochMs`。写入器从这份 sample 的 PTS 开始 session，令 MP4 内时间从 0 开始。

`RecordingSession` 的所有关键 timeline event 保留原有 `timestamp`（epoch ms），并新增：

```json
{
  "timestamp": 1786170012345,
  "videoOffsetMs": 12345
}
```

其中 `videoOffsetMs = max(0, timestamp - video.startEpochMs)`。Agent 必须优先使用该字段，禁止用 epoch 时间自行反推视频偏移。

## 录制生命周期

```mermaid
sequenceDiagram
  participant UI as Browser Forge UI
  participant Main as Electron main
  participant Chrome as Chrome process
  participant Native as macOS window recorder
  participant CDP as RecordingSession

  UI->>Main: POST /api/start-recording
  Main->>Main: 生成 token、临时 MP4 路径和唯一标题
  Main->>Chrome: launch URL with bfRecordingTitle
  Main->>Main: 等待 CDP debug endpoint
  Main->>Native: start(pid, expectedTitle, tempMp4)
  Native-->>Main: started(startEpochMs) after first append
  Main->>CDP: start(video.startEpochMs)
  UI->>Main: POST /api/stop-recording
  Main->>Native: stop and finalize MP4
  Native-->>Main: complete/partial/failed manifest data
  Main->>CDP: stop(video metadata)
  CDP->>Main: write material directory
```

如果 native recorder 在首帧前失败，整个“开始录制”请求失败，不启动 CDP session，也不把录制标记为成功。停止阶段即使视频只覆盖一部分时段，CDP 物料仍可写出，但 `video/manifest.json` 必须标明 `partial` 和 `coveredUntilOffsetMs`。

## 物料协议

录制目录新增：

```text
<recording-dir>/
├── RECORDING.md
├── recording.har
├── timeline.json
├── metadata.json
├── video/
│   ├── recording.mp4
│   └── manifest.json
└── tabs/
```

`video/manifest.json` 的第一个版本：

```json
{
  "version": 1,
  "state": "complete",
  "file": "recording.mp4",
  "codec": "h264",
  "fps": 15,
  "startEpochMs": 1786170000000,
  "durationMs": 42000,
  "coveredUntilOffsetMs": 42000,
  "window": {
    "pid": 12345,
    "windowId": "platform-specific-window-id",
    "title": "Browser Forge Recording · <token>"
  }
}
```

合法 `state` 仅为 `complete`、`partial`、`failed`。`failed` 不应带可播放文件；`partial` 的上下文只能使用 `0..coveredUntilOffsetMs`。

## macOS 实现

### 分发的原生工具

应用内原生实现采用两个由 `swiftc` 构建、随 macOS App 打包的可执行文件，均只使用 macOS 自带系统框架：

- `bf-window-recorder`：ScreenCaptureKit + AVFoundation；严格绑定窗口，写 H.264 MP4；行式 JSON stdout 协议。
- `bf-video-frame`：AVFoundation + ImageIO；按 MP4 时间偏移写 PNG；行式 JSON stdout 协议。

使用 Swift standalone executable 而不是 ffmpeg、Homebrew、npm、pip 或 Python。启动者在开发环境解析源码构建产物，在 packaged app 从 `process.resourcesPath/native-tools` 执行。构建失败是开发/打包阶段错误；运行时不会尝试下载或安装依赖。

ScreenCaptureKit 捕获过滤器为 `SCContentFilter(desktopIndependentWindow: targetWindow)`，并禁用音频。期望配置为 15 fps、H.264、包括鼠标光标和子窗口。程序必须向用户清楚呈现 macOS Screen Recording TCC 授权失败，不得静默产出空视频。

### JavaScript 外观层

`VideoRecorder` 负责寻找适当平台的 `bf-window-recorder`、启动子进程、解析 JSON、提供 `start()` 和 `stop()`，且可依赖注入 `spawn`/路径解析器以便单元测试。非 Darwin 平台提供显式 `UNSUPPORTED_PLATFORM` 的 placeholder；这为 Windows backend 保留接口。

## Agent 帧提取工具

analysis skill 新增：

```bash
scripts/extract-video-frame \
  --recording-dir "/absolute/path/to/recording" \
  --offset-ms 12345 \
  --output "/tmp/browser-forge-frame-12345.png"
```

它读取 `video/manifest.json`、校验 state、视频文件、offset 范围和输出覆盖策略，然后调用 skill 自身携带的 `assets/video-tools/<platform-arch>/bf-video-frame`。成功 stdout 是单行 JSON：

```json
{"requestedOffsetMs":12345,"actualOffsetMs":12345,"output":"/tmp/frame.png","width":1440,"height":900}
```

规定错误码：`VIDEO_MANIFEST_NOT_FOUND`、`VIDEO_FILE_NOT_FOUND`、`VIDEO_STATE_FAILED`、`VIDEO_OFFSET_OUT_OF_RANGE`、`VIDEO_OFFSET_NOT_COVERED`、`OUTPUT_ALREADY_EXISTS`、`UNSUPPORTED_PLATFORM`、`EXTRACTION_FAILED`。

安装器必须随 skill 一起复制原生工具、保持可执行位，并通过 `assets/video-tools/manifest.json` 的 SHA-256 验证它们。工具不可用时，skill 安装应报告失败，而不是把错误推迟到 Agent 分析时。

## Windows 11 兼容设计

Windows 后端不属于本次交付，但将实现同一个 `VideoRecorder` 和 `extract-video-frame` 命令契约。它应使用：

```text
Chrome PID + title token
→ EnumWindows / GetWindowThreadProcessId / GetWindowTextW
→ unique HWND
→ IGraphicsCaptureItemInterop::CreateForWindow(HWND)
→ Windows Graphics Capture
→ Media Foundation H.264 MP4 writer
```

禁止 `CreateForMonitor`、Desktop Duplication、monitor capture、区域裁剪和 `GetForegroundWindow`。Windows 帧工具将使用 Media Foundation，并保持相同 CLI 参数与 JSON 输出。
