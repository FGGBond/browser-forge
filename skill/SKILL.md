---
name: browser-forge
description: 分析 browser-forge 录制物料，产出可独立分发的 skill + CLI 工具。触发条件：用户说"分析录制物料"、"帮我生成 skill"、"分析这次录制"、"把录制转成 CLI"等场景。
---

# browser-forge

分析浏览器操作录制物料，自动产出可独立分享和运行的 skill + CLI 工具包。

---

## 使用前提

1. 已安装并运行过 browser-forge 应用，有录制产出的 session 目录
2. 启动本 skill 时，告知录制目录路径（绝对路径或相对路径均可）

---

## 分析协议（Agent 执行步骤）

### Step 0：确认录制目录

```
请告知录制输出目录的路径（包含 session-xxx/ 子目录的那个根目录）。
例如：/Users/xxx/recordings/
```

### Step 1：分析前问卷（必须在读取任何物料前完成）

在开始分析之前，向用户提出以下问题（越详细越准确）：

```
在开始分析之前，请描述这次操作的具体信息：

1. 这次操作的目标是什么？（一句话，如"查询某个订单的物流状态"）
2. 查询了哪些数据？（如：查询了订单号 123456 的详情）
3. 修改或提交了哪些数据？（如：修改了收货地址为北京朝阳区）
4. 涉及哪些关键业务实体？（如：orderId、skuId、userId）
5. 操作是否顺利完成？如果有失败重试，请说明。
6. 希望产出的 CLI 工具叫什么名字？（建议格式：{动词}-{业务名}，如 query-order）
```

### Step 2：读取物料

按以下顺序读取（详细格式见 [knowledge/recording-format.md](knowledge/recording-format.md)）：

1. `{session}/RECORDING.md` — 概况
2. `{session}/metadata.json` — Tab 列表
3. `{session}/timeline.json` — 操作时序
4. `{session}/recording.har` — 网络请求（核心分析对象）
5. `{session}/tabs/*/events.json` — 用户交互
6. `{session}/tabs/*/screenshots/*.png` — 截图（结合时间戳与 timeline 对应）

### Step 3：接口依赖分析

按 [knowledge/api-dependency.md](knowledge/api-dependency.md) 中的方法：
- 识别接口调用顺序
- 识别数据依赖（某接口的输入来自哪个接口的输出）
- 识别动态凭证（区分业务 ID 和鉴权 token）
- 遇到歧义主动追问（触发条件见 knowledge/api-dependency.md）

### Step 4：安全扫描（产出前）

分析阶段识别凭证字段，**不得将以下内容写入任何产出文件**：
- `sso.jd.com` Cookie 实际值（形如 `BJ.[A-Z0-9]{32,}`）
- `Authorization: Bearer` token 实际值
- `ssa.*` Cookie 实际值
- 疑似 CSRF token（随机字符串 > 20 字符）

凭证在产出文档中统一使用占位符：`<SSO_COOKIE>`、`<COOKIE_HEADER>`、`<CSRF_TOKEN>`

### Step 5：产出 skill 目录

在 `{录制根目录}/skills/{operation-name}/` 下创建以下文件：

```
{operation-name}/
├── SKILL.md          （基于 templates/SKILL-template.md 填充）
├── knowledge.md      （基于 templates/knowledge-template.md 填充）
├── api-map.md        （基于 templates/api-map-template.md 填充）
└── scripts/
    ├── install.sh    （直接复制 templates/install-template.sh，替换 {operation-name}）
    ├── auth.sh       （直接复制 templates/auth-template.sh，替换 {operation-name}）
    └── {verb}-{resource}.sh  （为每个独立操作创建一个 CLI 工具）
```

每个 CLI 工具必须包含：
- `--help` 输出（功能/输入参数/输出/依赖/下一步建议）
- 完整的鉴权调用（调用 auth.sh 获取 Cookie）
- 接口请求逻辑（Python 脚本或 curl）
- JSON 格式的标准输出

### Step 6：Secret Scanner（产出后强制执行）

扫描 `skills/{operation-name}/` 整个目录，搜索以下模式：

```bash
grep -rE 'BJ\.[A-Z0-9]{32,}' skills/{operation-name}/
grep -rE 'Bearer [A-Za-z0-9+/=]{20,}' skills/{operation-name}/
grep -rE 'ssa\.[a-z]+=([A-Za-z0-9+/=]{20,})' skills/{operation-name}/
```

发现匹配：
- 产出标记为 **FAILED**，不得标记为可用
- 报告具体文件路径和行号
- 要求用户确认后替换为占位符，重新运行 Secret Scanner

扫描通过：报告产出路径，告知用户下一步。

---

## 产出目录结构规范

→ 详见 [templates/SKILL-template.md](templates/SKILL-template.md)

## 鉴权实现参考

→ 详见 [knowledge/auth-patterns.md](knowledge/auth-patterns.md)

## 录制物料格式

→ 详见 [knowledge/recording-format.md](knowledge/recording-format.md)

## 接口依赖分析方法

→ 详见 [knowledge/api-dependency.md](knowledge/api-dependency.md)
