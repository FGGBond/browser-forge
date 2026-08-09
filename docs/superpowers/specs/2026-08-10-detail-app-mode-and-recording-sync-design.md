# 录制详情、Chrome App Mode 与录制同步设计

**日期：** 2026-08-10
**状态：** 用户要求已明确

## 目标

1. 录制详情右侧分析栏以自然、可中断的动画进入和退出。
2. 详情页只保留用户决策所需的信息，移除播放器能力说明、时长和视频状态文案。
3. 录制 Chrome 窗口不暴露 Browser Forge 本地 HTTP 端口。
4. 新录制结束后立即出现在侧栏和录制仓库状态中。
5. 默认名称只由录制日期和时间构成，侧栏使用文件夹语义展示录制。

## 分析栏交互

- 关闭状态按钮文案为“去分析”。
- 分析栏是右侧覆盖式 sheet，不再通过网格压缩视频和标题。
- 打开：`translateX(28px) → 0` 与 `opacity 0 → 1`，240ms，`cubic-bezier(.2,.8,.2,1)`。
- 关闭：170ms，退出快于进入。
- 遮罩淡入淡出；点击遮罩或按 Escape 关闭。
- 关闭后焦点返回“去分析”按钮；打开后焦点进入关闭按钮。
- `prefers-reduced-motion: reduce` 时取消位移动画。
- 不使用 `display:none` / `hidden` 作为动画起点；通过 class、`aria-hidden`、`inert` 和 `pointer-events` 管理状态。

## 详情信息精简

- 标题下只保留网站与创建时间。
- 移除时长和“视频完整 / 视频部分可用”等状态文字。
- 移除视频下方“Chrome 窗口视频”“支持前后跳转、倍速和全屏”等 footer。
- 视频不可用时仍保留必要的错误状态。

## Chrome 启动窗口

- Chrome 参数从普通 `--new-window <URL>` 改为 `--app=<URL>`。
- 保留 remote debugging port、独立 user-data-dir、窗口标题身份和现有 CDP 生命周期。
- App Mode 隐藏地址栏和标签栏；不会在录制视频中暴露端口。
- 启动页仍由本地服务提供，但将假的地址栏说明改为真正的网站 URL 输入表单。
- 提交表单后在同一 App Mode 窗口导航；无地址栏但可继续使用页面内导航与 Agent/CDP 操作。
- macOS 优先实现；Chrome 的同一 `--app` 参数保留 Windows 兼容设计。

## 录制同步与默认名称

- 停止录制返回的 `recording` 立即 upsert 到全局 `state.recordings`，按 `createdAt` 从新到旧排序。
- 详情重命名后同步更新侧栏标题。
- 默认标题格式：`Recording-M月D日HH:mm`，例如 `Recording-8月9日23:40`。
- `startHost` 和 `visitedHosts` 仍保留在 metadata 中服务搜索和分析，但不参与默认标题。
- 侧栏录制项只显示文件夹图标和标题，不显示域名或首字母徽标。
- 当前详情录制显示打开文件夹；其余显示关闭文件夹，为未来分析会话层级预留视觉语义。
