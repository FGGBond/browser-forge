# Browser Forge Recorder Helper App 设计

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

1. 新建录制页调用 Helper 的 `--check-permission`。
2. 未授权时调用同一 Helper 的 `--request-permission`。
3. 用户在系统设置中开启 `Browser Forge Recorder`。
4. 重启 Browser Forge 后再次由同一 Helper preflight。
5. 通过后，同一 Helper 进入窗口录制模式。

权限未通过前不得创建 staging、临时 MP4 或启动 Chrome。

## 用户恢复入口

系统设置中的目标主体明确显示为 `Browser Forge Recorder`。拒绝后 UI 提供：

- `再次检查权限`：重新执行 preflight，不承诺再次弹出系统对话框；
- `打开系统设置`：打开固定的录屏设置页；
- `在 Finder 中显示录制组件`：Main 进程揭示固定 Helper App，供用户通过加号选择或拖入系统设置。

Renderer 不得传入路径或 URL。

## 验收

- 开发与打包路径都解析到 Helper 内的同一可执行文件。
- Helper Info.plist 的 Bundle ID、名称、可执行文件正确。
- DMG 中 Helper 位于 `Contents/Helpers`，不残留在 Resources。
- Helper 和父 App 的 codesign 验证通过。
- Helper 的权限 CLI 和录制 CLI 使用同一 Mach-O。
- 完整测试、build、package、make 通过。
