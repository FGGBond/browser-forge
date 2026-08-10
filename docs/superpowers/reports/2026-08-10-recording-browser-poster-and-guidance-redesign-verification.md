# 验证报告：录制浏览器 / 海报 / 引导式分析重构

日期：2026-08-10
分支：`feat/window-video-recording`
HEAD：`cc8460e`
设计文档：`docs/superpowers/specs/2026-08-10-recording-browser-poster-and-guidance-redesign.md`
实施计划：`docs/superpowers/plans/2026-08-10-recording-browser-poster-and-guidance-redesign.md`

## 需求逐项核对

### 1. 录制 Chrome 恢复完整浏览器（地址栏 / 多 Tab / 切换网址）
- 移除了录制窗口的 kiosk/精简外壳，录制启动后使用完整 Chrome 窗口（`src/main/chrome-launcher.js`、`7f1d968`）。
- 用户可在录制中自行新建多个 Tab、在地址栏切换网址。
- 跨窗口移动 Tab 的元数据泄漏已修复（`c283003`）。

### 2. 海报取第一个真实网址稳定渲染后的画面
- 新增导航稳定追踪器（`src/main/recorder/navigation-settler.js`、`0bc2b39`）。
- poster 从首个真实 URL 完成渲染且进入稳定态的视频帧中选取，而非视频首帧 / 起始页（`af03b31`、`3232d9f`）。
- poster 选取与可见 Tab 状态对齐,停止录制时异步 CDP 任务全部落盘后再收尾（`57998a6`）。
- 覆盖范围外的候选帧不再被错误钳位到视频末尾;无稳定页面时提供中性占位而非 404(`33fff82`)。

### 3. 录制详情页:右侧引导面板 + 伪对话三步问答
- 分析引导固定在详情页右侧侧边栏展开,不再出现在页面下方(`0fb37cf`)。
- 移除 EasyMDE/工具栏,替换为纯净化 guided composer(`bfa5cef`、`b5af6a5`):
  - 输入 `- ` 自动渲染为无序列表;
  - 输入 `1. ` 自动渲染为有序列表;
  - 列表中回车自动延续下一个要点/序号;
  - 底部输入框随内容自动增长,超过最大值后内部滚动;
  - 撤销链在列表转换后依然完整(`9f0a7fb`)。
- 问题以纯文本展示(不再呈现为可获得焦点并高亮的输入框),胶囊进度显示为 `第 N / 3 个问题`,参考 Codex 风格(`26b3bf1`)。
- 三问完成后:先「导出录制」到用户指定目录,再一键复制组装好的外部 Agent 提示词,提示词引用导出路径(不暴露应用私有物料路径)。
- 导出/复制失败以 `role=alert` 提示且可关闭;返回上一步不会丢失「仅重试复制」的能力(`9f0a7fb`)。
- Agent 侧通过新增的 handoff 端点读取导出目录,浏览器分析 skill 内置 `bf-video-frame` 原生取帧工具,不依赖 FFmpeg 安装。

### 4. 左侧侧边栏弹出动画恢复
- 恢复可中断的侧边栏进出场动效(`7572010`)。
- reduced-motion 偏好下不再立即隐藏标签(`9f0a7fb`)。

## 测试证据

- 全量测试:`npm test`
  - Test Files: **72 passed (72)**
  - Tests: **489 passed (489)**
  - 运行时间:2026-08-10 13:19(本地)
- 定向测试:`tests/unit/ui-recording-detail.test.js` 11/11 通过。
- `git diff --check` 干净。
- 两轮代码评审发现的问题(跨窗口 Tab 泄漏、后台 Tab 抢占 poster、出界帧钳位、停止时丢异步任务、私有路径泄漏、占位 404;撤销链断裂、重试丢失、reduced-motion 标签瞬隐、告警无 role)均已修复,修复与测试均已提交。

## 视觉验证截图

- 浅色:第 1 问 / 第 2 问 / 长文本滚动
- 深色:第 1 问 / 第 2 问 / 长文本滚动
- 确认:引导在右、胶囊居中可读、问题为纯文本、输入框固定底部并内部滚动、标题与按钮纵向排列不裁切、深色模式可读。

## 分发产物

- DMG:`dist/make/Browser Forge.dmg`
- SHA-256:`ef40cb978d0498326bfc2ed9f67dee48a594dfe9d9bed841e6c3f2484349305d`
- 大小:136,076,723 字节
- 构建时间:2026-08-10 13:21(HEAD `cc8460e`,`make:mac:private`,无遥测)
- 打包中间产物(`dist/Browser Forge-darwin-arm64`、`dist/make/zip`、旧 DMG 备份)已清理,只保留 DMG。

## 提交记录(本目标区间,16 个提交)

见 `git log origin/feat/window-video-recording..HEAD`。
