# 接口依赖链识别方法

Agent 分析 HAR 物料时，按以下方法识别接口之间的数据依赖和时序依赖。

## 识别步骤

### Step 1：提取所有请求，按时间排序

从 `recording.har` 中提取每条 entry 的：
- `startedDateTime`（时间戳）
- `request.method + request.url`（接口标识）
- `request.postData.text`（请求 body，JSON 解析）
- `response.content.text`（响应 body，JSON 解析）

按 `startedDateTime` 升序排列，建立有序调用序列。

### Step 2：识别数据依赖

对每个请求的 body/query 参数中的每个值，检查是否来自前序请求的响应：
- 在所有已执行请求的响应 JSON 中搜索该值
- 如果找到匹配，记录：`{来源接口} → {字段路径} → {目标接口} → {参数名}`

**常见依赖模式：**

```
GET /list → items[0].id → POST /detail?id=xxx        （列表详情模式）
GET /preview → data.token → POST /submit（body.token）（防重复提交 token）
POST /init → data.orderId → GET /status?orderId=xxx  （流程 ID 传递）
```

### Step 3：识别动态凭证

区分"业务参数"和"动态凭证"：

| 类型 | 特征 | 处理方式 |
|------|------|---------|
| 业务 ID | 有语义（orderId、skuId）、来自业务响应 | 作为 CLI 输入参数 |
| 动态凭证 | 随机字符串、来自中间接口、无业务语义 | 在 CLI 内部自动获取，不暴露给用户 |
| 鉴权 Cookie | 来自 SSO 流程、长字符串 | 通过 auth.sh 获取，不暴露给用户 |

### Step 4：绘制依赖链

用以下格式记录在 `api-map.md` 中：

```
[用户输入] orderId
     │
     ▼
GET /order/detail?orderId={orderId}  → previewToken（响应字段）
     │
     ├─→ GET /address/list           → addressId（用户选择）
     │
     ▼
POST /order/confirm
  body: { previewToken, addressId }
     │
     ▼
[输出] confirmedOrderId
```

## 追问触发条件

分析过程中遇到以下情况，**必须主动向用户追问**，不得自行推断：

| 情况 | 追问示例 |
|------|---------|
| 同一接口调用多次 | "我看到 `/order/submit` 被调用了 2 次，第一次返回 400，第二次成功。这是你手动重试的吗？还是页面自动重试？" |
| 参数来源不明 | "请求 body 中有一个 `scene` 字段，值为 `checkout`，我没有在前序接口中找到它的来源，这是一个固定值吗？" |
| 多 Tab 操作 | "操作过程中切换了 2 个 Tab，Tab B 里的操作是否是完成 Tab A 操作的必要步骤？" |
| 截图与 HAR 不一致 | "截图显示弹窗已关闭，但之后还有 3 个请求，这些请求是弹窗关闭后自动触发的吗？" |
