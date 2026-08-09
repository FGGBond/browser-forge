# Browser Forge 本地 ad-hoc 录屏授权恢复设计

## 已验证根因

macOS TCC 将由 Browser Forge 启动的 Recorder Helper 的 ScreenCapture 请求归因到负责进程 `Browser Forge.app`。本地 ad-hoc 构建的主 App 指定要求包含当前二进制 CDHash；每次重新构建后 CDHash 改变，系统设置保留的旧授权记录无法匹配新 App，即使旧条目的开关仍显示开启，运行时 preflight 也会返回未授权。

因此用户可见的唯一授权主体必须是：

```text
Browser Forge.app
Bundle ID: com.browserforge.app
```

Recorder Helper 只负责实际的窗口录制，不再作为用户需要管理的授权对象。权限 preflight 和 best-effort request 由加载在 Browser Forge Electron Main 进程中的 N-API addon 执行，确保 TCC subject 为主 App。

## 系统行为修正

在当前实机系统上，重置 TCC 后调用 `CGRequestScreenCaptureAccess`，无论从 Helper、Electron `desktopCapturer` 还是主进程 N-API addon 发起，TCC 都记录：

```text
Service kTCCServiceScreenCapture does not allow prompting; returning denied.
```

因此产品不能承诺“重新请求授权”一定弹出系统对话框。程序化 request 只作为 best effort：

- preflight 已通过：返回 `granted`；
- request 被系统接受但需要重启：返回 `restart-required`；
- 系统拒绝弹出授权提示：返回 `manual-authorization-required`，进入手动设置流程。

可靠流程必须是：固定重置 Browser Forge 自身 TCC 记录，显示已安装主 App，打开固定系统设置页；条目缺失时用户可将 Finder 中选中的 App 拖入设置页，再关闭/打开 `Browser Forge` 开关并完成 Touch ID/密码确认，然后重启 App 并重新 preflight。

## 目标

本地 ad-hoc 开发允许每次重新安装后重新授权，但必须保证：

1. 可以安全清除 Browser Forge 自己的旧 ScreenCapture TCC 记录；
2. 用户只管理 `/Applications/Browser Forge.app`，不需要寻找 Recorder Helper；
3. 无法程序化弹窗时提供可执行、可理解的手动授权流程；
4. 用户完成设置后可以可靠重启 Browser Forge；
5. 重启后 App API 必须返回 `granted` 才允许进入录制启动；
6. 权限通过前不分配 Chrome 端口、不创建 staging/临时视频、不启动 Chrome；
7. Renderer 无法传入任意路径、bundle ID、TCC service、系统设置 URL、命令或重启参数。

## App 内恢复流程

新建录制页首次加载时执行主进程 preflight。未授权时提供：

- `允许屏幕录制`：调用主进程 addon 的 best-effort request；系统不允许弹窗时转入手动恢复；
- `再次检查权限`：只执行 preflight；
- `重置并打开授权设置`：固定重置 `ScreenCapture com.browserforge.app`，在 Finder 中显示当前安装的 `Browser Forge.app`，再打开固定的屏幕录制设置页；
- `打开系统设置`：不重置，仅打开固定设置页；
- `授权后重新启动 Browser Forge`：Main 先向 HTTP 客户端返回，再调用 `app.relaunch()` 和 `app.quit()`。

重置后的提示必须说明：如果系统设置里的旧条目仍显示开启，先关闭再重新打开 `Browser Forge` 开关，并完成 Touch ID/密码确认。UI 文案只指向 Browser Forge 主 App，不再引导用户授权 Recorder Helper。

## Main/HTTP 安全边界

Electron Main 提供四个无参数 fixed-purpose adapter：

```text
openScreenRecordingSettings()
revealBrowserForgeApp()
resetScreenRecordingPermission()
restartBrowserForge()
```

固定目标：

```text
Settings URL: x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture
App path:     由 app.getPath('exe') 向上解析到 Browser Forge.app
TCC command:  /usr/bin/tccutil reset ScreenCapture com.browserforge.app
Restart:      app.relaunch() + app.quit()
```

HTTP 提供无请求参数的固定路由：

```text
POST /api/screen-recording-permission/open-settings
POST /api/screen-recording-permission/reveal-app
POST /api/screen-recording-permission/reset
POST /api/restart
```

即使 Renderer 在 body 中伪造 URL、路径、service、bundle ID、可执行文件或参数，Main 也不得使用这些值。

## 本地安装辅助流程

`npm run install:mac:local` 执行：

1. 构建 macOS package；
2. 请求当前 Browser Forge 正常退出，超时后终止；
3. 固定重置 `ScreenCapture com.browserforge.app`；
4. 用构建产物替换 `/Applications/Browser Forge.app`；
5. 通过 LaunchServices 强制注册当前安装路径和新 CDHash；
6. 启动新安装版本。

脚本仅支持 macOS，不接受 Renderer 输入。允许通过命令行参数覆盖源 App 和目标目录以便测试，但默认值固定为当前项目 package 产物与 `/Applications`。显式注册避免系统设置仍解析到旧构建或工作区副本。脚本完成后不再提示等待系统弹窗，而是明确要求用户在系统设置中关闭再打开 Browser Forge 开关，然后重启 App。

## 错误与状态

- `tccutil` 执行失败：返回稳定错误码，不继续恢复流程；
- request 返回 false：映射为 `manual-authorization-required`，不再误报普通 `denied`；
- native 返回 `restart-required`：不得启动 Chrome，显示重启按钮；
- 重启后仍未授权：继续恢复流程，不把系统设置开关或旧 TCC 条目当作成功证据；
- 只有 App API 的 preflight 返回 `granted` 才可启动录制。

## 验收

- 自动化测试覆盖固定 reset 参数、固定 App reveal/settings/restart 入口、HTTP 路由、UI 状态和权限前无副作用；
- 本地安装脚本测试 quit → reset → replace → launch 顺序和固定 TCC 范围；
- 完整测试、build、package、make 通过；
- 实际安装后完成：重置旧权限 → 安装当前 App → 系统设置中关闭再打开 Browser Forge → Touch ID/密码确认 → App 重启 → App API `granted`；
- 新建录制仅在 `granted` 后进入 Chrome 启动流程。
