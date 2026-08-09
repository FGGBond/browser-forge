# macOS 屏幕录制权限自动申请设计

## 目标

Browser Forge 在启动录制用 Chrome 和创建录制 staging 目录之前检查 macOS 屏幕录制权限。首次未授权时由实际执行窗口录制的 `bf-window-recorder` 调用 CoreGraphics 权限 API 触发系统弹窗；权限仍不可用时，UI 提供重试和打开固定系统设置页的操作。

## 原生权限协议

`bf-window-recorder` 增加两个互斥命令：

- `--check-permission`：调用 `CGPreflightScreenCaptureAccess()`，输出单行 JSON，状态为 `granted` 或 `not-granted`。
- `--request-permission`：先 preflight；未授权则调用 `CGRequestScreenCaptureAccess()`，随后再次 preflight，输出 `granted`、`denied` 或 `restart-required`。

权限命令不启动 ScreenCaptureKit，也不解析窗口录制参数。权限结果属于正常协议结果，进程退出码为 0；协议错误或原生异常才使用非零退出码。

## JS 平台边界

新增 `ScreenRecordingPermission`，负责解析原生工具 JSON 协议并提供 `check()` / `request()`。macOS ARM64 使用现有 `bf-window-recorder`；Windows 后端未交付时返回明确 `unsupported`，但 HTTP/UI 不包含平台特定二进制路径或 `.exe` 判断。

## 启动门禁

`POST /api/start-recording` 首先执行权限检查。未授权时返回稳定错误码，且不得：

- 创建 managed recording staging 目录；
- 查找可用调试端口；
- 启动 Chrome；
- 创建临时 MP4；
- 创建 RecordingSession。

权限通过后保持现有启动顺序。这样失败不会留下无效录制物料。

## HTTP 与 Electron Main 安全边界

新增：

- `GET /api/screen-recording-permission`
- `POST /api/screen-recording-permission/request`
- `POST /api/screen-recording-permission/open-settings`

`open-settings` 只调用 Electron Main 注入的 `openScreenRecordingSettings()`，该函数内部使用固定的 `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` URL。Renderer 和 HTTP 请求不能提供 URL。

## UI 状态

新建录制页在 macOS 权限未知或未授权时，先解释：Browser Forge 仅录制其启动的 Chrome 窗口，不录制桌面、其他 App 或个人浏览器。用户点击主按钮后先调用 request API：

- `granted`：继续开始录制；
- `restart-required`：提示授权后重新启动 App，并提供打开系统设置；
- `denied` / `not-granted`：提示系统可能不会再次弹窗，提供“重新请求权限”和“打开系统设置”；
- `unsupported`：保留平台清晰错误，不误称 Windows 已实现。

权限通过前按钮文案为“允许屏幕录制”；通过后为“打开 Chrome 并开始录制”。

## 测试与验收

测试覆盖原生源码/构建协议、JS 协议解析、启动前门禁、无 staging/Chrome 副作用、固定系统设置 URL、UI 的首次请求/拒绝/需重启/授权路径。最终运行完整 `npm test`、`npm run build`、`npm run package:mac`，并对打包 App 内原生工具执行 `--check-permission` smoke test。
