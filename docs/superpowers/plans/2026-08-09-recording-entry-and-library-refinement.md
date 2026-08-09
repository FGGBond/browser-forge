# Recording Entry and Library Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把新录制页精简为 Codex 风格输入面，并让录制仓库卡片以整宽视频为主。

**Architecture:** 保留现有无构建 UI 和权限 API，重写 `renderNewRecording` 的展示状态与通知层，同时保持 start payload 和权限 preflight 行为。仓库只调整 `recordingRow` 的语义结构和共享 CSS，不改变播放器、搜索或导航接口。

**Tech Stack:** Vanilla JavaScript ES modules、CSS、Vitest、Playwright。

## Global Constraints

- 不新增运行时依赖。
- 不自动重置或删除 macOS TCC 权限。
- 不伪造 Agent 对话或 Agent 回复。
- 不使用原生视频 controls、音量、下载或画中画。
- 深浅色、键盘操作、reduced-motion 和 520px 起的窄屏必须可用。

---

### Task 1: 新录制页核心交互

**Files:**
- Modify: `tests/unit/ui-start-recording.test.js`
- Modify: `tests/unit/ui-product-boundaries.test.js`
- Modify: `ui/views/recording.js`
- Modify: `ui/styles.css`

**Interfaces:**
- Consumes: `api.getChromePath()`, `api.getScreenRecordingPermission()`, `api.requestScreenRecordingPermission()`, `api.openScreenRecordingSettings()`, `api.restartBrowserForge()`, `api.startRecording({ chromePath, goalText })`。
- Produces: `[data-goal-text]`, `[data-send-goal]`, `[data-start]`, `[data-notice-stack]`。

- [ ] 添加失败测试：默认页面不存在 `.goal-context-note`、`.advanced-settings`、`.permission-actions`；只存在发送目标和开始录制两个 composer 动作。
- [ ] 添加失败测试：缺权限时点击“开始录制”仍调用 request；失败后自动打开设置并出现可关闭通知；窗口 focus 后自动复查。
- [ ] 运行 `npx vitest run tests/unit/ui-start-recording.test.js tests/unit/ui-product-boundaries.test.js`，确认新增断言失败。
- [ ] 重构 `renderNewRecording`，用通知堆叠替换 form status 和恢复按钮组；保留自动权限 preflight 与录制 payload。
- [ ] 在 `ui/styles.css` 实现居中 composer、底部双动作、层叠通知和窄屏规则。
- [ ] 重跑目标测试并提交 `feat: simplify new recording composer`。

### Task 2: 视频主导的录制仓库

**Files:**
- Modify: `tests/unit/ui-recording-library.test.js`
- Modify: `ui/views/library.js`
- Modify: `ui/styles.css`

**Interfaces:**
- Consumes: `mountVideoPlayer(...)`、现有 recording metadata。
- Produces: `.recording-row`, `.repository-video`, `.recording-row-content`, `.recording-row-summary`, `.recording-row-actions`。

- [ ] 添加失败测试：仓库 markup 使用紧凑 summary，不再渲染三块 `<dl class="recording-row-meta">`。
- [ ] 添加失败测试：桌面 computed layout 中视频位于信息栏上方且宽度占卡片至少 95%，信息栏高度小于视频高度的 35%。
- [ ] 运行 `npx vitest run tests/unit/ui-recording-library.test.js`，确认新增断言失败。
- [ ] 改写 `recordingRow` 为整宽视频 + 紧凑信息栏，并更新 skeleton。
- [ ] 更新桌面、900px、600px CSS，保证视频优先、元信息换行和按钮可用。
- [ ] 重跑目标测试并提交 `feat: prioritize video in recording library`。

### Task 3: 完整验证和视觉证据

**Files:**
- Modify: `docs/superpowers/specs/2026-08-09-recording-entry-and-library-refinement-design.md`（仅在实现偏差需要记录时）

- [ ] 运行 `npm test`，要求全部通过且 0 failures。
- [ ] 运行 `npm run build`，要求 main、preload、renderer 构建成功。
- [ ] 用 Playwright 在 1280×800、900×700、640×760、520×760 检查新录制和仓库；覆盖 light/dark 与 reduced-motion。
- [ ] 检查 `git diff --check`、`git status` 和最终提交范围。
- [ ] 独立提交验证记录并推送当前分支。
