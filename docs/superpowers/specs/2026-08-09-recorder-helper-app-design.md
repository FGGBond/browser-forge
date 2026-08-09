# Browser Forge Recorder Helper App 设计

## 后续验证修正（2026-08-09）

实时 TCC 日志确认：当 Recorder Helper 由 Browser Forge 启动时，macOS 将 ScreenCapture 请求归因到负责进程 `Browser Forge.app`，而不是 Helper。Helper App 仍用于稳定组织原生录制二进制，但用户可见的 TCC 授权主体必须是 `com.browserforge.app`。本地 ad-hoc 构建的主 App CDHash 每次构建会变化，因此需要重置旧授权后重新申请。完整恢复流程见 `2026-08-09-local-screen-recording-authorization-design.md`。

## 问题

系统设置授权的是 `Browser Forge.app`，而当前权限检查、请求和 ScreenCaptureKit 录制由 `Contents/Resources/native-tools/bf-window-recorder` 裸可执行文件完成。两者具有不同的 ad-hoc 代码身份，导致系统设置显示已授权，但运行时子进程仍返回未授权。

## 目标

将权限检查、权限申请和实际窗口录制统一到同一个正式 App Bundle：

```text
Browser Forge.app
└── Contents/Helpers/Browser Forge Recorder.app
    └── Contents/MacOS/Browser Forge Recorder
```

Helper Bundle ID 固定为 `com.browserforge.app.recorder`。所有录屏相关 CLI 模式都执行同一 Helper 可执行文件，避免权限主体分裂。

## 构建与打包

开发构建在 `native-tools/Browser Forge Recorder.app` 生成完整 Bundle，包含：

- `Contents/Info.plist`
- `Contents/MacOS/Browser Forge Recorder`
- `Contents/Resources/BrowserForgeRecorder.icns`

Electron Forge 打包后将 Helper 移至父 App 的 `Contents/Helpers`。打包钩子对嵌套 Helper 和父 App 执行 ad-hoc 深度签名，并验证签名完整性。正式分发可通过环境变量改用 Developer ID；本阶段没有可用证书，因此 DMG 仍为本地测试构建。

`bf-video-frame` 继续保留在 `Contents/Resources/native-tools`，因为它不申请 TCC 权限。

## 运行时路径

macOS ARM64：

- 开发：`native-tools/Browser Forge Recorder.app/Contents/MacOS/Browser Forge Recorder`
- 打包：`Contents/Helpers/Browser Forge Recorder.app/Contents/MacOS/Browser Forge Recorder`

Windows 的预留可执行文件命名不变。权限客户端和视频录制器都通过同一 native-tools 注册表解析 Helper 可执行文件。

## 权限流程

1. 新建录制页通过 HTTP 调用 Browser Forge Main 进程中的 N-API addon 执行 preflight。
2. 未授权时可执行同一主进程 addon 的 best-effort request；当前实机系统可能拒绝程序化弹出 ScreenCapture 对话框。
3. 无法弹窗时，Main 固定重置 `ScreenCapture com.browserforge.app`、在 Finder 显示主 App 并打开系统设置。
4. 用户在系统设置中关闭再打开 `Browser Forge` 开关，完成 Touch ID/密码确认后重启 Browser Forge。
5. Main addon 再次 preflight；只有返回 `granted` 后才启动 Chrome 和 Recorder Helper。
6. Recorder Helper 进入窗口录制模式，但不作为用户需要管理的 TCC 主体。

权限未通过前不得创建 staging、临时 MP4、分配 Chrome 端口或启动 Chrome。

## 用户恢复入口

系统设置中的目标主体明确显示为 `Browser Forge`。未授权时 UI 提供：

- `再次检查权限`：重新执行主 App preflight；
- `允许屏幕录制`：best-effort request，不承诺弹出系统对话框；
- `打开系统设置`：打开固定的录屏设置页；
- `重置并打开授权设置`：只重置 `ScreenCapture com.browserforge.app`，显示已安装主 App并打开固定设置页；
- `授权后重新启动 Browser Forge`：用户完成开关与系统认证后重启并复检。

Renderer 不得传入路径、URL、TCC service、bundle ID 或重启参数。完整恢复流程见 `2026-08-09-local-screen-recording-authorization-design.md`。

## 验收

- 开发与打包路径都解析到 Helper 内的同一可执行文件。
- Helper Info.plist 的 Bundle ID、名称、可执行文件正确。
- DMG 中 Helper 位于 `Contents/Helpers`，不残留在 Resources。
- Helper 和父 App 的 codesign 验证通过。
- Helper 的权限 CLI 和录制 CLI 使用同一 Mach-O。
- 完整测试、build、package、make 通过。
