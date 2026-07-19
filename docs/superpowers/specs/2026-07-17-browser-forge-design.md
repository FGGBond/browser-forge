# browser-forge 设计文档

## 概述

browser-forge 是一个 Electron 桌面应用，启动用户本机 Chrome 并通过 CDP（Chrome DevTools Protocol）全量录制浏览器会话。录制产物以标准格式组织到本地目录，供用户提供给外部 Agent（如 Claude Code）进行分析。Agent 分析后产出配套的 Skill `.md` 文件和可执行 CLI 工具，CLI 直接调用目标网站 API，不依赖 browser-forge 本身运行。

**工具定位：采集 + 结构化组织物料，零 AI 能力，零后端依赖。**

---

## 系统架构

```
browser-forge/
├── Electron 主进程
│   ├── Chrome 进程管理（启动/关闭，--remote-debugging-port=9222）
│   ├── CDP 客户端（WebSocket 连接 localhost:9222）
│   ├── 录制会话管理（开始/暂停/停止）
│   └── 物料写入（实时流式写入本地目录）
│
├── Electron 渲染进程（控制面板 UI）
│   ├── 录制状态显示（当前 Tab 列表、耗时、物料大小）
│   └── 开始 / 停止 / 在 Finder 中打开 / 复制路径
│
└── 物料输出目录（session-YYYY-MM-DD-HHmm/）
    ├── RECORDING.md          ← Agent 入口，模板生成的目录说明
    ├── recording.har         ← 完整网络请求（HAR 1.2，含所有 Tab）
    ├── timeline.json         ← 全局时间线（Tab 切换 + 跨 Tab 事件）
    ├── metadata.json         ← 录制元数据
    └── tabs/
        └── {targetId}-{title}/
            ├── events.json   ← 用户交互事件序列
            ├── dom-{ts}.html ← 导航完成时的 DOM 快照
            ├── console.json  ← Console 输出
            ├── screenshots/  ← PNG 截图，文件名为时间戳（ms）
            └── scripts/      ← 本 Tab 加载的 JS 文件，按 URL 路径组织
```

---

## 技术选型

| 维度 | 决策 | 理由 |
|------|------|------|
| 桌面框架 | Electron | 跨平台，可嵌入控制 UI |
| 浏览器 | 用户本机 Chrome（`--remote-debugging-port=9222`） | CDP 能力无限制，复用真实 Cookie/会话 |
| CDP 连接 | WebSocket + `chrome-remote-interface` 或原生 WS | 成熟库，支持多 Target 管理 |
| 网络物料格式 | HAR 1.2 | 工业标准，Agent/DevTools 原生理解 |
| 其他物料格式 | 原始 HTML/JS/PNG/JSON | 标准格式，无需特殊解析 |

---

## CDP 录制层

### 监听的 CDP 域

| CDP 域 | 事件/方法 | 捕获内容 |
|--------|-----------|----------|
| `Target` | `targetCreated/Destroyed/Activated` | Tab 生命周期、切换事件 |
| `Network` | `requestWillBeSent/responseReceived/loadingFinished` | 完整请求响应，含 body |
| `Page` | `loadEventFired/frameNavigated` | 页面导航事件 |
| `DOM` | `documentUpdated`（触发快照） | DOM 树快照 |
| `Runtime` | `consoleAPICalled/exceptionThrown` | Console 输出和 JS 异常 |
| `Debugger` | `scriptParsed` | JS 文件解析记录 |

### 关键实现细节

1. **Network body 获取**：在 `loadingFinished` 后立即调用 `Network.getResponseBody(requestId)`，Chrome 释放缓存后无法再取。超大响应（默认阈值 10MB）只保存 headers，body 标记为 `body_too_large`。
2. **截图时机**：不做全程截图，仅在 `frameNavigated`、用户点击、输入等关键事件时触发 `Page.captureScreenshot`，控制体积。
3. **DOM 快照**：每次导航完成后执行 `DOM.getDocument` + `DOM.getOuterHTML` 全量快照，不做实时 mutation 监听。
4. **Tab 切换记录**：`Target.activatedTarget` 事件写入 `timeline.json`，记录时间戳和 from/to targetId。
5. **录制启动**：先 `Target.getTargets` 枚举已有 Tab，对每个 target attach CDP session 并开启各域监听，确保录制前已打开的 Tab 也被捕获。
6. **JS 去重**：按 URL + content hash 去重，同一 JS 多次加载只存一份，`scripts/` 目录按域名/路径结构组织。
7. **二进制资源**：图片/字体等二进制响应默认只保存 URL 和 headers，不保存 body（可在设置中开启完整保存）。

---

## 物料组织与渐进式披露

工具不具备 AI 分析能力，物料组织的核心目标是：**让 Agent 能够用自己已知的标准格式理解物料，并通过一份结构说明文件按需定位内容。**

### RECORDING.md（模板生成，非 AI 生成）

录制结束后，工具根据实际录制内容模板化生成 `RECORDING.md`，内容包括：

- 录制概况（起始 URL、时长、Tab 数量）
- 完整目录树（根据实际文件生成）
- 各类物料的格式说明和检索建议

示例内容：

```markdown
# browser-forge 录制物料

录制时间：2026-07-17 14:32
起始 URL：https://example.com/checkout
时长：4分23秒 | Tab 数量：3 | 网络请求：247个

## 目录结构
session-2026-07-17-1432/
├── RECORDING.md          ← 本文件
├── recording.har         ← 全部网络请求（HAR 1.2）
├── timeline.json         ← 全局操作时间线
├── metadata.json         ← 录制元数据
└── tabs/
    ├── abc123-商品详情页/
    ├── def456-购物车/
    └── ghi789-支付页/
        ├── events.json
        ├── dom-1720000000000.html
        ├── console.json
        ├── screenshots/
        └── scripts/

## 文件说明
- `recording.har` — 全部网络请求和响应，HAR 1.2 格式，含 headers、body、状态码、时序
- `timeline.json` — 全局事件时间线，包含 Tab 创建/关闭/切换、页面导航、用户交互，按时间戳排列
- `metadata.json` — 录制元数据：起始 URL、录制时长、Chrome 版本、Tab 列表（targetId + 标题 + URL）
- `tabs/{tab}/events.json` — 该 Tab 内的用户交互事件序列（点击、输入、滚动），含目标元素选择器和时间戳
- `tabs/{tab}/dom-{ts}.html` — 该 Tab 在导航完成时的完整 DOM 快照，文件名中的时间戳对应导航事件
- `tabs/{tab}/console.json` — 该 Tab 的 Console 输出，含 log/warn/error 级别和 JS 异常堆栈
- `tabs/{tab}/screenshots/` — 关键事件时刻的截图，文件名为事件触发时的时间戳（ms）
- `tabs/{tab}/scripts/` — 该 Tab 加载的 JS 文件，按原始 URL 路径结构存放，相同内容去重
```

---

## Agent 分析产出规范

browser-forge 不参与分析，但设计时需明确 Agent 分析后的产出规范，以便工具的物料组织能服务于该目标。

Agent 分析录制物料后，应产出以下两件事：

### 1. Skill 文件（`.md`）
描述该操作的能力边界、使用前提、参数说明和调用示例，供 Agent 理解"能做什么、怎么调用"。

### 2. CLI 工具（可执行脚本）
实现具体操作，采用三级降级策略：

| 级别 | 策略 | 适用场景 |
|------|------|---------|
| L1 | 直接调用目标网站 API | 录制物料中可清晰识别 API endpoint 和参数 |
| L2 | 前端 JS 逆向封装 | 存在加密/签名，从 JS 源文件中还原加密逻辑 |
| L3 | 浏览器自动化兜底 | L1/L2 均不可行，回退到 browser-use 模式 |

**CLI 不依赖 browser-forge 运行**，Agent 调用 CLI 时直接打目标网站后端 endpoint 完成操作。

---

## 控制面板 UI

最小化设计，三个页面：

1. **启动页**：Chrome 可执行文件路径（自动探测，可手动修改）、输出目录选择
2. **录制中**：Tab 列表（标题 + URL）、录制时长、已捕获物料大小、停止录制按钮
3. **录制结束**：输出目录路径、"在 Finder/Explorer 中打开"按钮、"复制路径"按钮

---

## 不在范围内

- 物料回放/预览
- 内置 AI 分析能力
- 云端上传或同步
- CLI 工具的生成（由外部 Agent 负责）
- 浏览器自动化执行（由生成的 CLI 负责）
