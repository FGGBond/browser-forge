# browser-forge Skill 生成与鉴权设计

## 1. 目标与范围

本阶段为 browser-forge 增加一套可重复、可校验的 Agent 分析与生成规范。用户完成浏览器操作录制后，在自己的 Agent 中显式调用 `browser-forge` skill，并用自然语言说明操作目标、观察到的数据、修改的数据及最终结果。Agent 分析录制物料后，生成一个目标系统级 skill，其中包含多个可独立调用和自由组合的 CLI 子命令。

所有生成产物必须：

- 遵循统一目录、manifest、CLI、帮助、输出、错误码和安全规范。
- 在运行时优先使用京ME SSO 鉴权，并在不适用或失败时回退到本地浏览器 Cookie。
- 携带完整鉴权实现，脱离 browser-forge 后可以独立安装和运行。
- 明确命令之间和命令内部 HTTP 请求之间的数据依赖。
- 不包含录制时的真实 Cookie、Token、个人数据或其他秘密。

本阶段不实现平台上传、检索、组合，也不实现录制工具内置的 Agent 问答接口。未来问答接口只保留抽象扩展点。

## 2. 用户工作流

### 2.1 触发分析

用户在 Agent 中显式指定 `browser-forge` skill，并提供录制目录和尽可能详细的操作描述，例如：

```text
/browser-forge
请分析 session-2026-07-17-1432。我先查询订单列表，再打开订单详情，
最后对订单 12345 提交了退款申请，退款金额为……
```

分析开始前，skill 必须提示用户补充：

- 操作的业务目标。
- 查询并看到的关键数据。
- 选择、输入或修改的数据。
- 页面展示或操作返回的最终结果。

如果用户描述不足以把行为与网络请求可靠对应，Agent 必须先提问。分析过程中出现多个合理解释时也必须主动提问，不得对有副作用的路径进行猜测。

### 2.2 输出位置

生成 skill 与录制物料位于同一根目录：

```text
<用户指定目录>/
├── session-2026-07-17-1432/
└── skills/
    └── order-tools/
```

一次分析生成一个目标系统级 skill。skill 可以包含多个原子业务子命令，Agent 后续根据命令契约自由组合，不按录制动作拆分多个 skill。

skill 名由用户指定。用户未指定时，Agent 根据目标系统提出名称，并在写入前确认。若目标目录已经存在，生成器不得直接覆盖；Agent 必须请求用户选择更新现有 skill 或使用新名称。

## 3. 生成产物结构

CLI 统一采用 Python 3.10+ 实现，并通过 bash wrapper 提供稳定入口：

```text
skills/order-tools/
├── SKILL.md
├── manifest.json
├── references/
│   ├── workflows.md
│   ├── knowledge.md
│   ├── authentication.md
│   └── commands/
│       ├── list-orders.md
│       └── get-order.md
├── scripts/
│   ├── browser_forge-order-tools
│   ├── install.sh
│   └── cli/
│       ├── pyproject.toml
│       └── src/browser_forge_order_tools/
│           ├── cli.py
│           ├── config.py
│           ├── envelope.py
│           ├── client.py
│           ├── commands/
│           └── auth/
│               ├── provider.py
│               ├── jdme_sso.py
│               ├── browser_cookies.py
│               ├── cookie_jar.py
│               └── session_store.py
└── tests/
    ├── test_contract.py
    ├── test_auth_selection.py
    ├── test_commands.py
    └── fixtures/
```

### 3.1 文件职责

- `SKILL.md` 是 Agent 入口，列出全部 CLI 子命令和标准调用流程，并引用详细文档实现渐进式披露。
- `manifest.json` 是机器可校验的唯一契约源，描述 skill、CLI、运行时、鉴权、命令 schema 和依赖关系。
- `references/commands/<command>.md` 描述单个命令的功能、参数来源、输出字段、依赖和后续动作。
- `references/workflows.md` 记录从录制物料确认的多请求编排和可靠使用范例，但不限制 Agent 自由组合命令。
- `references/knowledge.md` 保存目标系统的业务背景和长期使用知识，不得保存凭证或录制中的个人敏感值。
- `scripts/browser_forge-<skill-name>` 是唯一稳定入口。规范 ID 使用 `browser_forge.<skill-name>`。
- `scripts/cli/src/.../auth/` 是生成时复制的鉴权运行时，生成后不依赖 browser-forge。
- `tests/fixtures/` 只允许完全脱敏的录制派生数据。

## 4. Manifest 契约

`manifest.json` 首版使用 `spec_version: "1.0"`，至少包含：

- `id`：例如 `browser_forge.order-tools`。
- `name`、`description` 和 skill 相对路径。
- `cli.entrypoint` 和 Python 最低版本。
- `auth.policy`、目标域、provider 顺序和 `auth_runtime_version`。
- `commands`：每个业务和基础命令的契约。
- `$defs`：输入和输出 JSON Schema。
- `required_features`：运行时必须理解的能力。

每个业务命令至少声明：

```json
{
  "id": "get-order",
  "summary": "获取订单详情",
  "side_effect": false,
  "idempotent": true,
  "inputs": [
    {
      "name": "order_id",
      "type": "string",
      "required": true,
      "sources": [
        {
          "command": "list-orders",
          "json_path": "$.data.orders[*].order_id"
        }
      ]
    }
  ],
  "outputs": {
    "schema_ref": "#/$defs/get-order-output"
  },
  "requires": {
    "auth": true,
    "commands": []
  },
  "next_actions": [
    {
      "command": "submit-refund",
      "bindings": {
        "order_id": "$.data.order_id"
      }
    }
  ]
}
```

Validator 必须检查所有命令引用、schema 引用和 JSON Path 均可解析。命令依赖图不得有无法执行的环；轮询类命令可通过明确的状态循环声明例外。

## 5. CLI 契约与渐进式帮助

### 5.1 命名与入口

```bash
bash scripts/browser_forge-order-tools <command> [options]
```

所有生成 CLI 固定包含：

- `doctor`：检查 Python、依赖、配置、鉴权和只读 API 可用性。
- `auth-status`：返回脱敏的 provider、缓存和刷新状态。
- `describe [command]`：输出整个 CLI 或指定命令的机器可读契约。

所有需要鉴权的业务命令支持 `--refresh-auth`。

### 5.2 单命令帮助

每个子命令的 `--help` 必须明确：

- 功能和副作用。
- 必填、可选参数及类型。
- 每个输入参数如何获取，包括前置 CLI 和 JSON Path。
- 鉴权、配置和前置命令依赖。
- 输出字段和 artifact。
- 下一步建议及参数绑定。
- 至少一个脱敏示例。
- 幂等性和重试风险。

帮助内容必须与 manifest 保持一致，由同一声明生成或通过 validator 校验。

### 5.3 JSON Envelope

除帮助文本外，命令 stdout 只输出一个 JSON 对象。日志只写 stderr。成功 envelope 示例：

```json
{
  "spec_version": "1.0",
  "ok": true,
  "command": "get-order",
  "status": "success",
  "data": {},
  "artifacts": {},
  "auth": {
    "provider": "jdme_sso",
    "fallback_used": false
  },
  "next_actions": []
}
```

失败 envelope 使用相同顶层结构，并包含：

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "缺少 order_id",
    "recoverable": true
  }
}
```

固定退出码：

- `0`：成功，或异步任务已接受。
- `1`：业务、鉴权或远端接口失败。
- `2`：参数或契约使用错误。
- `3`：本地运行环境、安装或依赖错误。

## 6. 两层调用依赖模型

### 6.1 命令间依赖

manifest 描述一个命令的输出如何成为另一个命令的输入。Agent 可以通过 `describe`、`SKILL.md` 和 `references/commands/` 获得相同信息，并自由组合命令。

### 6.2 命令内部接口编排

一个业务命令可以编排多个 HTTP 请求。每个步骤记录 endpoint、method、参数映射、响应提取、前置步骤和失败条件，例如：

```json
{
  "steps": [
    {
      "id": "resolve-account",
      "request": "GET /api/account",
      "depends_on": []
    },
    {
      "id": "load-order",
      "request": "GET /api/orders/{order_id}",
      "depends_on": ["resolve-account"]
    }
  ]
}
```

接口步骤不得包含真实 Cookie、Token 或个人数据。动态字段如 CSRF、nonce、时间戳和签名必须声明其运行时来源，禁止固化录制值。

有副作用的命令必须声明 `side_effect: true`。默认提供 `--dry-run`；若目标接口无法安全预演，帮助和 manifest 必须明确说明。不允许静默重试非幂等请求，输出必须包含业务结果标识或可执行的验证步骤。

## 7. 鉴权架构

每个生成 skill 内置统一 `AuthProvider` 链。业务命令只能请求已经按目标 URL 绑定的 CookieJar 或请求会话，不得自行读取 Cookie 数据库。

### 7.1 Provider 选择

```text
业务子命令
   ↓
AuthProvider.resolve(target_url)
   ├─ 京东内部 SSA/OIDC 目标
   │    1. JdmeSsoProvider
   │    2. BrowserCookieProvider（失败回退）
   └─ 其他目标
        1. BrowserCookieProvider
```

### 7.2 京ME SSO 主方案

`JdmeSsoProvider` 参考 `skills-109024-v6`：

1. 从当前用户的京ME Chromium Cookie 数据库读取 `me_token`。
2. 调用 `eopen.getCode` 换取一次性授权码。
3. 访问目标系统，从重定向链发现真实 `client_id`。
4. 在同一 CookieJar 中完成 SSA/OIDC、`jdmeUnionLogin` 和目标站回调。
5. 返回只适用于目标 domain、path、secure 和 expiry 规则的请求会话。

该 provider 只对配置允许的京东内部域启用。非京东网站不得尝试京ME SSO。

### 7.3 浏览器 Cookie 回退方案

`BrowserCookieProvider` 参考 `big-data-sql`：

- 按配置顺序读取 Edge、Chrome，必要时扩展 Firefox 和 Safari。
- 按目标 URL 的 domain、path、secure 和 expiry 规则选择 Cookie。
- 浏览器数据库被锁、系统密钥链拒绝或 Cookie 缺失时返回结构化错误。
- 回退成功时只报告 provider 和 `fallback_used`，不暴露凭证。

### 7.4 缓存与错误

缓存隔离在：

```text
~/.config/browser-forge/<skill-id>/auth/
```

缓存按 skill、目标 host 和设置指纹隔离，包含过期时间和 provider 信息。支持的平台将文件权限设为 `0600`。

稳定鉴权错误码包括：

- `AUTH_UNAVAILABLE`
- `JDME_NOT_LOGGED_IN`
- `SSO_EXCHANGE_FAILED`
- `TARGET_SESSION_FAILED`
- `BROWSER_COOKIE_UNAVAILABLE`
- `AUTH_REFRESH_REQUIRED`

CLI stdout、日志、异常、`doctor` 和 `auth-status` 永远不得输出完整 Cookie、Token 或可还原的长指纹。

## 8. 安全约束

录制 HAR 可能包含 Cookie、Authorization、CSRF Token 和个人数据。Agent 可分析字段名、域、生命周期及传递关系，但生成产物只能保存脱敏占位符。

生成完成必须运行 secret scanner，扫描：

- `SKILL.md`、references 和 manifest。
- Python、shell 和配置文件。
- 测试、fixture、快照和生成日志。
- Cookie、Authorization、JWT、CSRF、`me_token`、`sso.jd.com`、`ssa.*` 等模式。

允许字段名和明确的脱敏占位符，禁止真实值。发现疑似秘密时 validator 失败，产物不得标记为 `ready`。运行时 HTTP 日志必须经过 header/body redactor，默认不记录请求体或响应中的敏感字段。

## 9. browser-forge Skill 的分析流程

### 9.1 输入校验

定位录制目录，并校验 `RECORDING.md`、HAR、timeline、events 和 metadata。首版通过 Agent 文本交互提问；未来 `UserQuestionProvider` 可接入录制工具提供的选择和填空接口。

### 9.2 行为关联

按时间线对齐点击、输入、截图、DOM、导航和 HAR 请求，识别：

- 用户输入进入了哪些请求参数。
- 列表、详情、校验、提交、轮询和结果确认步骤。
- 前一响应字段如何进入后一请求。
- 动态认证、签名和防重放字段。

### 9.3 能力建模

将稳定能力建模为业务子命令，将多接口步骤封装在子命令内部。无法可靠还原的能力必须标记为 `unsupported` 或 `experimental`，不得伪装为稳定命令。

### 9.4 生成与验证

从版本化模板创建目录、复制鉴权运行时、生成业务代码和文档，再运行完整 validator。最终报告必须包含生成位置、命令清单、已确认及不确定关系、鉴权策略、验证结果、副作用命令和最小启动示例。

## 10. browser-forge 仓库实现

在仓库中新增：

```text
skills/browser-forge/
├── SKILL.md
├── references/
│   ├── analysis-workflow.md
│   ├── artifact-spec.md
│   ├── authentication.md
│   └── security.md
├── scripts/
│   ├── generate-skill
│   └── validate-skill
├── schemas/
│   └── manifest.schema.json
└── assets/
    └── skill-template/
```

- `SKILL.md` 教 Agent 分析、提问并调用生成和校验脚本。
- `generate-skill` 确定输出位置、渲染骨架并复制鉴权运行时。
- Agent 填充业务命令、接口编排和 references。
- `validate-skill` 执行所有可机械验证的约束。
- 现有录制工具保持不变。

## 11. 版本兼容

- `manifest.spec_version` 和 CLI envelope 首版为 `1.0`。
- 鉴权副本单独记录 `auth_runtime_version`。
- `1.x` 只允许向后兼容地增加字段；删除字段或改变语义必须升级到 `2.0`。
- 运行时必须忽略未知可选字段。
- 未知必需能力通过 `required_features` 明确拒绝运行。

## 12. 验证与完成标准

产物只有同时满足以下条件才可标记为 `ready`：

- manifest schema 校验通过。
- SKILL.md、manifest 和 CLI 实际命令完全一致。
- 每个业务子命令的帮助包含输入来源、输出和下一步。
- 命令依赖不存在悬空引用或非法环。
- 接口参数映射和 JSON Path 可解析。
- 鉴权选择、回退、缓存隔离和脱敏测试通过。
- JSON envelope 和退出码契约测试通过。
- secret scanner 无发现。
- `doctor` 在无登录环境下返回规范错误而不崩溃。
- 脱敏 fixture 离线测试通过。
- 生成 skill 被复制到不含 browser-forge 源码的临时目录后仍能运行 `doctor`、`describe` 和 mock 业务命令。

测试分为 schema 单元测试、鉴权单元测试、生成快照测试和端到端脱敏 fixture 测试。鉴权网络测试默认使用本地 fake server，不读取真实 Cookie 或访问真实系统。真实环境只允许人工触发只读 smoke test；有副作用的真实请求不得自动执行。

## 13. 实施隔离

正式实现使用独立分支：

```text
codex/browser-forge-skill-generation
```

实施遵循测试先行。设计与实施计划获批后再创建或切换到该分支，不在当前阶段修改生产代码。
