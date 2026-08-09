# Detail Sheet, Chrome App Mode, and Recording Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each behavior change.

**Goal:** 精简录制详情、隐藏录制窗口本地端口，并让新录制立即同步到仓库。

**Architecture:** 详情分析栏改为 CSS transform 驱动的 overlay sheet；Chrome 启动器使用 `--app` 且启动页提供真实 URL 表单；前端增加 recording upsert 状态操作，metadata 层统一生成日期标题。

**Tech Stack:** Vanilla JavaScript、CSS、Chrome command-line、Vitest、Playwright。

## Task 1: 详情分析 Sheet

- 修改 `tests/unit/ui-recording-detail.test.js` 和产品边界测试，先断言“去分析”、冗余信息不存在、Escape/遮罩/焦点与动画状态。
- 修改 `ui/views/detail.js`，使用 `aria-hidden`/`inert` 和 open/closing class 管理 sheet。
- 修改 `ui/styles.css`，只动画 transform/opacity，进入 240ms、退出 170ms，添加 reduced-motion。
- 定向测试通过后独立提交。

## Task 2: Chrome App Mode

- 修改 `tests/unit/chrome-launcher.test.js`，要求 `--app=<startUrl>` 且不再使用 `--new-window` 和裸 URL 参数。
- 新增启动页测试，要求存在 URL 表单且不再指导用户使用地址栏。
- 修改 `src/main/chrome-launcher.js` 和 `ui/recording-start.html`。
- 运行 launcher、recorder server 和窗口录制身份测试后独立提交。

## Task 3: 录制同步、名称与侧栏文件夹

- 修改 metadata 测试，要求 `Recording-8月9日23:40` 且 host 仍保留在搜索 metadata。
- 新增 UI 流程测试，要求录制完成后 `state.recordings` 即时 upsert；重命名同步侧栏。
- 修改 `src/main/recording-library/metadata.js`、`ui/app.js`、`ui/views/detail.js`、`ui/views/sidebar.js` 和样式。
- 验证文件夹打开/关闭语义、无域名副标题、排序和去重后独立提交。

## Task 4: 完整验证

- 运行 `npm test`、`npm run build`、`git diff --check`。
- 视觉检查详情 sheet 的打开、关闭、深浅色和 reduced-motion。
- 构建并推送当前功能分支。
