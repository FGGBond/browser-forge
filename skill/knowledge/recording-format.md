# 录制物料格式说明

Agent 在分析 browser-forge 录制会话时，需要按以下顺序和格式读取物料。

## 目录结构

```
{session-name}/
├── RECORDING.md          录制概况（人类可读摘要）
├── metadata.json         元数据：起始 URL、时长、Tab 列表
├── timeline.json         全局事件时间线（跨 Tab）
├── recording.har         所有 Tab 的网络请求（HAR 1.2 格式）
└── tabs/
    └── {targetId}-{title}/
        ├── events.json       用户交互事件序列
        ├── console.json      Console 输出
        ├── dom-{ts}.html     导航完成时的 DOM 快照
        └── screenshots/
            └── {ts}.png      关键事件时刻截图
```

## 推荐读取顺序

1. `RECORDING.md` — 快速了解录制概况（URL、时长、Tab 数、请求数）
2. `metadata.json` — 获取 Tab 列表和 targetId 映射
3. `timeline.json` — 了解操作全局时序
4. `recording.har` — 分析网络请求（重点：POST 请求、带 request body 的请求）
5. `tabs/*/events.json` — 了解用户交互事件（点击、输入、滚动）
6. `tabs/*/screenshots/{ts}.png` — 结合时间戳与 timeline 对应，验证操作意图

## metadata.json 格式

```json
{
  "startUrl": "https://example.jd.com/",
  "startedAt": "2026-07-17T06:32:10.123Z",
  "durationMs": 45000,
  "tabs": [
    { "targetId": "A1B2C3", "title": "订单列表", "url": "https://example.jd.com/orders" }
  ]
}
```

## timeline.json 格式

每条记录包含 `type`（navigate / click / input / screenshot 等）、`timestamp`（ms）、`targetId`、`data`。

```json
[
  { "type": "navigate", "timestamp": 1000, "targetId": "A1B2C3", "data": { "url": "..." } },
  { "type": "click",    "timestamp": 2500, "targetId": "A1B2C3", "data": { "selector": "#submit-btn" } }
]
```

## recording.har 核心字段

分析接口依赖时重点关注：

- `entries[].request.url` — 接口路径
- `entries[].request.method` — HTTP 方法（POST 通常是写操作）
- `entries[].request.postData.text` — 请求 body（JSON 字符串）
- `entries[].response.content.text` — 响应 body
- `entries[].startedDateTime` — 请求时间（与 timeline 时间戳对应）
- `entries[].request.headers` — 请求头（注意：凭证字段只记录字段名，不持久化值）

## events.json 格式

```json
[
  {
    "type": "click",
    "timestamp": 2500,
    "selector": "#submit-btn",
    "text": "提交订单"
  },
  {
    "type": "input",
    "timestamp": 3000,
    "selector": "#address-input",
    "value": "<已脱敏>"
  }
]
```
