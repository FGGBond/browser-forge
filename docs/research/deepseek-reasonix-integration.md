# DeepSeek-Reasonix × Browser Forge 接入调研与设计

## 0. 结论摘要

**推荐方案：把 Reasonix 作为一个由 Electron main 独占管理的长期 child process，直接使用其现成的 `reasonix acp`（ACP v1、NDJSON JSON-RPC 2.0、stdio）作为主协议；不要直接链接 Go 内核，也不要用一次性 CLI 作为正式运行时。**

核心原因：

1. Reasonix 的 Agent/Controller、provider、tool loop 都位于 Go `internal/` 包中，没有给外部 Node/Electron 消费的稳定 Agent SDK；现有 `sdk/go` 是 Extension Sidecar SDK，不是 Agent embedding SDK。
2. 一次性 `reasonix run --output-format stream-json` 可用于烟测或离线批处理，但每次起进程会丢失长驻会话、稳定 prefix/cache、双向权限请求和可靠取消语义。
3. `reasonix acp` 已经提供多 session、流式文本/思考/tool 事件、权限请求、MCP 注入、`session/cancel`、session resume/load/close/delete，且 stdout 专用于协议、stderr 专用于诊断，正好匹配 Electron main 管理 sidecar 的需求。
4. Browser Forge 当前安装的 `browser-forge` skill 可以被 Reasonix 发现（Reasonix 扫描 `~/.agents/skills`、`~/.claude/skills`；Browser Forge installer 正在安装这两个目标），但 **Reasonix 并不原生支持 Browser Forge tools**。录制路径校验、抽帧、生成/验证、验收执行和 app 内能力都需要 Browser Forge 适配层或由 Agent 通过受限 shell 调用现有 CLI。
5. 生产 secret 不应写入 Reasonix 当前使用的 `<REASONIX_HOME>/.env`。推荐 Electron main 从 macOS Keychain / Windows Credential Manager 取出上游 key，由 main 内的 loopback model gateway 代为附加 Authorization；Reasonix 只连接随机端口/随机路径并持有短期本地 token。这样 renderer 和 Reasonix tool subprocess 都看不到上游 key。

**当前总体判断：有条件 Go。** macOS Apple Silicon 可进入 sidecar PoC；Windows 和面向普通用户的生产分发暂时 No-Go，直到 Windows 抽帧二进制、Node runtime 调用策略、生成 CLI 的 Python 依赖策略、代码签名/杀软验证完成。

---

## 1. 审查基线与安全检查

### 1.1 Inspected ref

Reasonix 仓库根：`/Users/zhukai.129/AiWorkspace/browser-forge-optimization/opensource/DeepSeek-Reasonix`

- branch：`main-v2`
- commit：`710f3fb107d047d4879362d48f1451a9bc4e1635`
- tags：`v1.21.5`、`npm-v1.21.5`、`desktop-v1.21.5`
- commit date：`2026-08-10T00:32:07+08:00`
- 初始与最终源码审查期间 Reasonix `git status --porcelain=v2` 均无工作树修改；未 checkout、未 reset、未 restore、未 fetch，也未删除或覆盖任何文件。

Browser Forge 证据基线：

- 根：`/Users/zhukai.129/AiWorkspace/browser-forge-optimization/browser-forge/.worktrees/window-video-recording`
- branch：`feat/window-video-recording`
- inspected HEAD：`ba25e4fdc7435715c70e33b86e75a839d60919ed`
- 调研开始时 worktree clean；并行任务随后产生了与本调研无关的未跟踪文件。本任务不读取、删除、覆盖或提交这些并行产物，只提交本文档。

以下 `Reasonix:` 路径均相对 Reasonix 根，`Browser Forge:` 路径均相对 Browser Forge worktree 根；所有源码结论固定在上述 commit。

### 1.2 可执行验证

- Browser Forge skill-generation 测试：`npm run test:skill-generation`，**9 files / 82 tests passed**。
- 抽帧 CLI 结构化错误烟测：对不存在录制调用后输出单行 JSON：`VIDEO_MANIFEST_NOT_FOUND`，exit 1。
- Reasonix Go 测试未执行：当前环境没有 `go` 命令（`zsh: command not found: go`）。未按用户约束安装全局 Go/toolchain；因此 Reasonix 结论以本地源码、测试源码和文档为 primary source，不声称已在本机编译运行。

---

## 2. 项目定位、license、商用与分发

### 2.1 项目定位

Reasonix 是一个本地 coding agent engine，提供 CLI/TUI、桌面端、browser serve 和 ACP editor integration，共用同一 Controller/Agent 内核。README 明确强调 config-driven provider、OpenAI-compatible endpoint、MCP/Extension sidecar、cache-aware context 和单 Go binary 分发。（证据：Reasonix `README.md:42-44,57-72,74-123`；架构约束见 `REASONIX.md:7-24`。）

它不是“DeepSeek API SDK”，而是完整 Agent harness：包含 session、permission、sandbox、tools、MCP、skills、compaction、stream recovery 和多前端。对 Browser Forge 而言，应把它视为可替换的本地 Agent runtime，而不是 UI 组件。

### 2.2 License 结论

Reasonix 根许可证是 MIT：允许使用、复制、修改、合并、发布、分发、再许可和销售；条件是分发副本或实质部分时保留版权声明和许可声明；软件按现状提供、无担保。（证据：Reasonix `LICENSE:1-20`。）

**商用/分发结论：可以。** Browser Forge 可以商用集成、修改并随应用分发 Reasonix binary，但必须：

- 在应用 Third-Party Notices、安装包或随附许可证目录中保留 Reasonix MIT notice；
- 对 vendored Go/Node/Python 依赖生成 SBOM 并逐项保留其许可证；
- 单独遵守 DeepSeek 或其他模型供应商 API 条款、地区限制、商标和数据政策；MIT 不替代模型服务条款；
- 若修改 Reasonix，明确 fork commit、补丁和来源，避免让用户误以为 Browser Forge tool support 是 Reasonix upstream 原生能力。

这不是法律意见；上线前仍需法务完成 third-party/license scan。

---

## 3. Runtime、依赖、启动与配置

### 3.1 Reasonix runtime 与构建依赖

- 根模块要求 Go `1.25.0`，toolchain 固定 `go1.26.5`。（Reasonix `go.mod:1-6`。）
- 核心依赖包括 Bubble Tea/Lip Gloss、TOML、JSON Schema、tree-sitter、keyring compatibility、crypto/net/sys/text 等。（Reasonix `go.mod:7-65`。）
- CLI 构建是 `CGO_ENABLED=0 go build ... ./cmd/reasonix`，并可交叉构建 `darwin|linux|windows × amd64|arm64`。（Reasonix `Makefile:14-16,74-80`；`.goreleaser.yaml:8-30`。）
- 官方 npm 包只是 Node launcher + 平台 optional native package；Node 要求 `>=18`，launcher 按 `process.platform/process.arch` 找到 `reasonix[.exe]` 并 `spawnSync`。（Reasonix `npm/reasonix/package.json:1-38`；`npm/reasonix/bin/reasonix.js:1-21`。）

**运行已发布 Reasonix binary 不需要 Go、Python 或 Node。** Go 只用于从源码构建；npm 安装路径需要 Node 仅用于安装/launcher。Browser Forge 正式打包应直接 vendor native binary，不应在用户机器上执行 `npm i -g reasonix`。

### 3.2 启动方式

Reasonix 支持：

- TUI：`reasonix`
- 一次性：`reasonix run "..."` 或 `reasonix -p ...`
- Web：`reasonix serve`
- ACP：`reasonix acp [--model ...] [--profile economy|balanced|delivery]`

README 与 CLI 文档提供这些入口。（Reasonix `README.md:125-149`；`docs/CLI.md:13-40,127-143`；`docs/ACP.md:11-33`。）

一次性模式支持：

- `json`：最终单对象；
- `stream-json`：逐行 eventwire JSON，最后一个 result 对象；
- `--events-jsonl`：脱敏生命周期事件；
- `--trajectory`：包含 prompt、reasoning、tool args/results 的敏感完整轨迹。

（Reasonix `docs/CLI.md:160-235`。）生产集成不得默认启用 trajectory。

### 3.3 Provider、API key、model、base URL

Reasonix provider 是 TOML 配置项：`name`、`kind`、`base_url`、`model/models/default`、`api_key_env`、`context_window`、`effort` 等。官方例子使用 `kind="openai"` + `https://api.deepseek.com`；自定义 OpenAI-compatible endpoint 可设置 `reasoning_protocol = "deepseek"|"openai"|"none"`。（Reasonix `reasonix.example.toml:50-96`；`internal/config/config.go:1323-1369`。）

配置优先级为 flag > project `reasonix.toml` > `<Reasonix home>/config.toml` > defaults。（Reasonix `reasonix.example.toml:1-5`；`docs/CONFIG_PATHS.md:197-207`。）`REASONIX_HOME` 可建立完全隔离的 portable home；配置、state、cache 和数据均在该目录，且不扫描 OS-home fallback。（Reasonix `docs/CONFIG_PATHS.md:7-27`。）

Reasonix 在 boot 时把 `ProviderEntry` 转为 provider client，传入 BaseURL、Model、resolved API key、effort、headers、extra body、reasoning protocol 等。（Reasonix `internal/boot/boot.go:2621-2660`。）OpenAI adapter 要求 base URL 和 model，使用 `http.NewRequestWithContext` 发 streaming POST，Authorization 由 provider client 添加。（Reasonix `internal/provider/openai/openai.go:61-105,456-503`。）

### 3.4 Secret 配置的关键现实

README/示例强调 TOML 只保存 `api_key_env` 名称；实际 key 位于 `<REASONIX_HOME>/.env`。（Reasonix `.env.example:1-5`；`docs/CONFIG_PATHS.md:29-45,51-98`。）当前代码中 `ProviderEntry.APIKey()` 的正常 runtime 路径读取 Reasonix credential store；`storedCredentialValue` 明确读取 `UserCredentialsPath()` 的 `.env`。进程环境读取只用于 setup-time probe，不是正常 runtime。（Reasonix `internal/config/config.go:2115-2150`；`internal/config/credentials.go:224-269,586-615`。）`credentials_store` 在当前文档中是 legacy compatibility，provider keys 仍在 `.env`。（Reasonix `docs/CONFIG_PATHS.md:68-73`。）

因此有两个集成层级：

- **开发/内部 PoC**：Browser Forge 使用 app-private `REASONIX_HOME`，写 0600 `.env`。简单，但 key 仍以明文落盘，不满足严格 OS credential-manager 要求。
- **生产推荐**：Reasonix 不直接拿上游 key。Electron main 运行 loopback OpenAI-compatible gateway，从 Keychain/Credential Manager 解密 key 后向 DeepSeek 上游加 Authorization；Reasonix provider 指向 `127.0.0.1`，只持有每次启动轮换的本地 token。上游 key 永不进入 renderer、Reasonix config、Reasonix child env 或 tool subprocess。

生产推荐配置形态：

```toml
default_model = "browser-forge-gateway/<selected-model>"

[[providers]]
name = "browser-forge-gateway"
kind = "openai"
base_url = "http://127.0.0.1:<ephemeral-port>/<random-route>"
model = "<selected-model>"
api_key_env = ""
reasoning_protocol = "deepseek"
context_window = <model-specific-window>
headers = { "X-Browser-Forge-Session" = "<ephemeral-local-token>" }

[agent]
max_subagent_concurrency = 2
max_parallel_writers = 1

[tools]
bash_timeout_seconds = 120
mcp_call_timeout_seconds = 300
```

本地 token 可写入 app-private 0600 config，因为它只在本次进程生命周期内有效，不是上游 secret；退出时销毁并轮换。

---

## 4. Prefix/cache 优化：实际实现，而非宣传

Reasonix 的 cache 优化主要不是“显式调用 DeepSeek cache API”，而是**尽量维持 provider 请求前缀字节稳定，让 DeepSeek/OpenAI-compatible endpoint 的自动 prompt cache 命中**。

### 4.1 稳定 system prefix

Boot 只在 session 构建时组装一次 system prompt：

1. base/custom system prompt；
2. output style、核心策略、workspace/profile；
3. 持久化且缓存的 environment probe snapshot；
4. REASONIX/AGENTS/CLAUDE memory；
5. skill 的 name+description index，不把完整 skill body放进 system prefix。

（Reasonix `internal/boot/boot.go:547-639`。）Environment probe 特别持久化到 cache dir，避免 PATH/探测抖动让每次启动改写前缀。（同文件 `579-587`。）Mid-session memory 变化被放到 user turn tail，下个 session 才进入 stable prefix。（Reasonix `internal/control/input.go:152-216`。）

### 4.2 稳定 tool schema

Tool registry 输出 provider schemas 时按名称排序；provider 请求故意使用固定 `Schemas()`，不使用会随 workflow phase 变化的 contextual projection，以避免 tool contract churn。（Reasonix `internal/tool/tool.go:518-555`。）OpenAI adapter把这些 schema 规范化后按原 request 发出。（Reasonix `internal/provider/openai/openai.go:758-790`。）

### 4.3 Skill 延迟加载

Reasonix system prompt 只包含 skill 名称和一行描述，skill body 在 `run_skill` 或 slash invocation 时作为 tool result/turn 内容加载；skill list 排序以保持 index 稳定。（Reasonix `internal/skill/index.go:16-70`；`internal/skill/skill.go:1-12,635-640`；`internal/skill/tools.go:627-649`。）这对 Browser Forge 很重要：录制绝对路径、用户说明、skill body 和验收参数应留在当前 user turn，不应写入 system prompt。

### 4.4 Compaction 与 cache 取舍

配置区分 soft notice、tool-result snip、compact 和 force compact ratio，并支持冷 resume 时清理 stale tool results。（Reasonix `reasonix.example.toml:31-48`；`internal/config/config.go:1305-1317`。）Tool loop 在下一轮 sampling 前 compact，而最终 answer 只有达到阈值才 compact，以免普通 turn 无故冷 cache。（Reasonix `internal/agent/run_loop.go:1024-1027` 及 `827-895`。）

### 4.5 cache 计量而非伪造

OpenAI adapter解析 DeepSeek `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`，也兼容 OpenAI `prompt_tokens_details.cached_tokens` 和 Anthropic-shaped counters，统一到 `provider.Usage`。（Reasonix `internal/provider/openai/openai.go:1099-1152,1312-1329`。）Agent 每轮捕获 prompt/tool/rewrite shape 并比较，向 usage 发出 cache diagnostics。（Reasonix `internal/agent/run_loop.go:275-320`；`internal/agent/agent.go:2620-2635`。）

### 4.6 另一个“prefix”不要混淆

OpenAI adapter 还实现 DeepSeek Beta assistant-prefix continuation：当首个回答因 length 截断且没有 tool call 时，最多发起一次 continuation，并合并 usage。（Reasonix `internal/provider/openai/openai.go:43-55,507-590,860-868`。）这是输出续写恢复，不是 prompt cache 本身。

**Browser Forge 设计约束：** sidecar 必须长驻；同一任务复用同一 ACP session；不要在 system prompt/MCP schema 中注入 timestamp、session ID、录制路径或随机值；本地 gateway 不得重排/改写 request JSON body，否则可能破坏上游 prefix cache。

---

## 5. Tool-call loop、streaming、错误/重试与取消

### 5.1 Tool-call loop

Agent loop 每轮：

1. 获取稳定 tool schemas 和 prefix shape；
2. 冻结 sampling request；
3. 流式收集 text/reasoning/tool calls/usage；
4. 只有 clean terminal attempt 才把 assistant turn commit 到 session；
5. 无 tool call 时结束；有 tool calls 时执行 batch、写入配对 tool result，然后进入下一轮。

（Reasonix `internal/agent/run_loop.go:275-360`。）这避免失败的 speculative stream 执行半截 tool call。

Tool execution 支持 batch，并在取消时仍写配对的 tool result，避免后续 provider replay 因 assistant tool call 缺结果而 400。（Reasonix `internal/agent/run_loop.go:898-974`；OpenAI pairing repair `internal/provider/openai/openai.go:665-710`。）

### 5.2 Streaming

OpenAI provider发 SSE request，`stream_options.include_usage=true`。它实时发出：text delta、reasoning delta、tool-call start、tool args progress、完整 tool call、usage、done/error。（Reasonix `internal/provider/provider.go:697-729`；`internal/provider/openai/openai.go:758-790,870-1096`。）

SSE scanner 最大单 event 1 MiB；stream idle 默认 120 秒，context cancel 或 idle 会主动 close response body，避免半开连接永久挂起。（Reasonix `internal/provider/openai/openai.go:43-50,875-927`。）

### 5.3 Header-phase retry

`SendWithRetry` 对连接/response-header 阶段最多重试 10 次，指数退避上限 15 秒，`Retry-After` 上限 60 秒；401/403 对从未成功的 key fail fast，对曾成功 key 最多额外重试 2 次。重试 sleep 可被 context cancel。（Reasonix `internal/provider/retry.go:18-43,269-340`。）

### 5.4 Body-phase recovery

Body stream interruption 不在 provider 层重复预算；Agent 冻结同一 request，最多 5 次 recovery、共 6 attempts，失败 attempt 不写 session、不执行 tools。每次退避约 0.5/1/2/4/8 秒加 jitter，cancel 可中断。（Reasonix `internal/agent/agent.go:44-47`；`internal/agent/run_loop.go:363-500,519-537`。）

### 5.5 ACP cancellation

ACP `session/cancel` 是 notification。每个 session 的 active prompt 持有 `context.CancelFunc`；cancel 调用 `sess.abort()`，最终 `session/prompt` 返回 `stopReason="cancelled"`。（Reasonix `docs/ACP.md:81-101`；`internal/acp/service.go:311-348,1121-1180,2123-2132`。）ACP read loop 自身终止时也会 cancel 所有 in-flight handlers，并等待其 unwind。（Reasonix `internal/acp/server.go:104-159`。）

**接入策略：** 首选协议 cancel，不把 kill 进程当正常取消。仅当 5 秒内没有 prompt result，再 SIGTERM；2 秒后仍未退出才强杀。Windows 使用 Job Object，macOS 维护 process group，确保 sidecar 及其 MCP children 一并回收。

---

## 6. 三种接入方式比较

| 方式 | 优点 | 缺点/风险 | 结论 |
| --- | --- | --- | --- |
| 直接库 | 理论上函数调用、低 IPC 开销 | Go 内核都在 `reasonix/internal/*`；外部 module 不能稳定 import；Electron 是 Node；需维护 fork、Go toolchain、ABI/API 变化；现有 `sdk/go` 仅 Extension SDK | **不推荐**。只适合 upstream 将 Controller 暴露为稳定公共 SDK 后重评 |
| 一次性 CLI (`reasonix run`) | 接入最快；已有 `json/stream-json`；适合 CI/smoke | 每任务起进程；权限/问答双向交互弱；cancel 通常只能 kill；session/cache reuse 差；stdout 事件是运行输出而非长期 host protocol | **仅作 Phase 0/诊断 fallback** |
| 长期 child (`reasonix acp`) | 官方 NDJSON JSON-RPC；多 session；stream、tool、permission、cancel、MCP、resume；stdio 无监听端口；同 session 保持 cache | 需要 Electron main 实现 ACP host、process supervisor、权限/UI adapter；需 pin Reasonix 版本 | **明确推荐** |

直接库不可行的源码依据：根 module 是 `reasonix`，Controller/boot/provider 均在 `internal/`；桌面 nested module之所以能 import，是因为 module path 为 `reasonix/desktop`，仍处于 `reasonix/` internal boundary 内。（Reasonix `go.mod:1-6`；`desktop/go.mod:1-12`。）Extension SDK README/示例描述的是 stdin/stdout extension sidecar，不是 Agent host API。（Reasonix `sdk/go/README.md:1-22,67-122`。）

---

## 7. Electron main ↔ Reasonix sidecar 协议

### 7.1 传输决策

**使用 ACP 原生 JSONL/stdio，不再发明第二套 main↔Reasonix localhost 协议。**

启动：

```text
Electron main
  spawn(<absolute resources path>/reasonix[.exe], ["acp", "--profile", "delivery"], {
    cwd: <task-workspace>,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    env: <allowlisted env + REASONIX_HOME/STATE_HOME/CACHE_HOME>
  })
```

stdout 必须逐行解析 JSON-RPC；stderr 单独收集并脱敏。Reasonix 官方文档明确 stdout 只用于 ACP，diagnostics 在 stderr，禁止合并。（Reasonix `docs/ACP.md:11-33`。）

### 7.2 请求序列

1. `initialize`
2. `session/new { cwd: <absolute task workspace>, mcpServers: [...] }`
3. 可选 `session/set_config_option`：model、effort、work_mode、tool_approval
4. `session/prompt`
5. 运行中可 `_reasonix.io/session/steer`
6. 用户停止时 `session/cancel`
7. 任务结束 `session/close`；用户删除历史才 `session/delete`

现成 session lifecycle 与 config controls 见 Reasonix `docs/ACP.md:35-143`；session params/MCP fields 见 `internal/acp/protocol.go:171-260,464-517,712-717`。

### 7.3 建议 Browser Forge main 内部 schema

ACP wire 保持原样；main 再转成 renderer-safe 的领域事件，renderer 不直接持有 child pipes：

```json
{"v":1,"type":"agent.command","requestId":"uuid","taskId":"uuid","command":"start","recordingId":"uuid","workspace":"/absolute/path","model":"provider/model"}
{"v":1,"type":"agent.command","requestId":"uuid","taskId":"uuid","command":"prompt","text":"..."}
{"v":1,"type":"agent.command","requestId":"uuid","taskId":"uuid","command":"cancel"}
```

```json
{"v":1,"type":"agent.event","taskId":"uuid","seq":1,"event":"text.delta","text":"..."}
{"v":1,"type":"agent.event","taskId":"uuid","seq":2,"event":"reasoning.delta","text":"..."}
{"v":1,"type":"agent.event","taskId":"uuid","seq":3,"event":"tool.started","toolCallId":"...","name":"...","inputSummary":"redacted"}
{"v":1,"type":"agent.event","taskId":"uuid","seq":4,"event":"tool.finished","toolCallId":"...","status":"completed","outputSummary":"redacted"}
{"v":1,"type":"agent.event","taskId":"uuid","seq":5,"event":"permission.requested","permissionId":"...","toolCallId":"...","choices":[...]}
{"v":1,"type":"agent.event","taskId":"uuid","seq":6,"event":"turn.finished","stopReason":"end_turn|cancelled|error"}
```

映射来源：ACP `session/update` 支持 agent message/thought chunks、tool_call、tool_call_update、plan、available commands、config options。（Reasonix `docs/ACP.md:145-160`；`internal/acp/protocol.go:519-640`。）

### 7.4 Tool bridge

ACP host 的 fs/terminal 回调不是通用 Browser Forge tool API。推荐 Electron main 另开一个仅 loopback 的 **MCP Streamable HTTP bridge**，用随机端口 + 256-bit bearer token；在 `session/new.mcpServers` 中传入 URL/headers。Reasonix 已支持 session-scoped MCP specs，包括 stdio command/env 和 HTTP URL/headers。（Reasonix `docs/ACP.md:98-101`；`internal/acp/protocol.go:173-207`。）

首版桥接工具建议保持窄面：

```json
{
  "name": "browser_forge_recording_resolve",
  "input": {"recordingId":"uuid"},
  "output": {"absolutePath":"/managed/path","materialVersion":1,"videoState":"complete|partial|failed"}
}
```

```json
{
  "name": "browser_forge_extract_video_frame",
  "input": {"recordingId":"uuid","offsetMs":12345,"outputPath":"/task-workspace/frame.png","overwrite":false},
  "output": {"path":"/task-workspace/frame.png","offsetMs":12345,"width":0,"height":0}
}
```

```json
{
  "name": "browser_forge_generate_skill",
  "input": {"recordingId":"uuid","skillName":"...","description":"...","targetDomains":["..."],"outputRoot":"/task-workspace/generated"},
  "output": {"skillDir":"/task-workspace/generated/<name>","status":"generated"}
}
```

```json
{
  "name": "browser_forge_validate_skill",
  "input": {"skillDir":"/task-workspace/generated/<name>"},
  "output": {"valid":true,"issues":[],"findings":[]}
}
```

bridge 必须验证 recordingId 对应 managed root、拒绝 symlink escape、限制 outputPath 在 task workspace、对生成/覆盖保持 create-only。Browser Forge 现有 library 已实现 contained-path 与 no-symlink 约束，可复用其策略。（Browser Forge `src/main/recording-library/paths.js:21-49`；`src/main/recording-library/index.js:628-640`。）

**不要暴露任意 `exec` 或任意路径读写 MCP tool。** 生成 skill 的最终动态 CLI 命令仍由 Reasonix sandboxed bash 执行，并经过权限审批。

---

## 8. 注入 browser-forge skill 与完整工作流

### 8.1 现成能力

Browser Forge installer 默认把 managed skill 安装到：

- `$CODEX_HOME/skills/browser-forge` 或 `~/.codex/skills/browser-forge`
- `~/.agents/skills/browser-forge`
- `~/.claude/skills/browser-forge`

（Browser Forge `src/main/agent-skill-installer.js:8-33`。）它还复制 generator/validator runtime、AJV 依赖和 bundled video tools，并校验 hash/可执行位。（Browser Forge `src/main/agent-skill-installer.js:118-218,220-253`。）

Reasonix 默认扫描 project 和 home 下 `.reasonix/.agents/.agent/.claude/skills`，project > custom > global > builtin；skill path会随 invocation 文本暴露给模型。（Reasonix `internal/skill/skill.go:1-12,448-495,627-649`；`internal/config/paths.go:530-537`。）因此当前 `~/.agents/skills/browser-forge` 与 `~/.claude/skills/browser-forge` 可被 Reasonix 发现；`~/.codex/skills` 并非 Reasonix convention root。

生产启动时仍建议在 app-owned config 显式设置：

```toml
[skills]
paths = ["/absolute/user-home/.agents/skills"]
```

这样可诊断、可 pin，且即使未来 Browser Forge 只安装某一个 target，也能在启动前明确检测。

### 8.2 录制路径与提示注入

Browser Forge 已有 external agent prompt builder，会传递录制**绝对路径**，要求读取 `metadata.json`、`timeline.json`、HAR、tabs 和 video manifest，按 `videoOffsetMs` 抽帧，最终生成独立 skill+CLI 并实际执行验收任务。（Browser Forge `src/main/recording-library/external-agent-prompt.js:25-47`。）

推荐 `session/prompt` 直接显式 slash invocation，避免依赖模型是否自行选择 skill：

```text
/browser-forge

<Browser Forge buildExternalAgentPrompt(...) 的完整文本>

Host constraints:
- recording path is read-only
- generated output root is <task-workspace>/generated
- never write into the recording directory
- use the installed skill directory shown in the skill header for scripts
```

Reasonix slash invocation会把 skill name、description、scope 和**绝对 skill path**连同 body/arguments放入当前 turn。（Reasonix `internal/skill/tools.go:627-649`。）

### 8.3 `videoOffsetMs` 与零依赖抽帧

Browser Forge recorder用 `event.timestamp - video start epoch` 生成 non-negative rounded `videoOffsetMs`，并把它写入 timeline event。（Browser Forge `src/main/recorder/video-manifest.js:60-69`。）分析必须直接使用 timeline 提供的值，不自行做 epoch subtraction。（Browser Forge `skills/browser-forge/SKILL.md:18-35`；`skills/browser-forge/references/video-analysis.md:1-31`。）

抽帧 CLI：

```bash
node "<installed-skill-dir>/scripts/extract-video-frame.mjs" \
  --recording-dir "/absolute/path/to/recording" \
  --offset-ms 12345 \
  --output "/absolute/task-workspace/frame-12345.png"
```

它校验 manifest version/state/duration/coverage、文件存在性、目标覆盖、平台工具 hash；用临时 PNG + rename 保证失败时不破坏旧文件；stdout 恰好一个 JSON line。（Browser Forge `skills/browser-forge/scripts/extract-video-frame.mjs:1-115`。）

“零依赖”只指抽帧不需要 FFmpeg/Homebrew/pip/Python/system video utility；它仍需要 Node launcher 和随 skill 分发的 native extractor。当前 manifest 只包含 `darwin-arm64/bf-video-frame`；其他平台返回 `UNSUPPORTED_PLATFORM`。（Browser Forge `skills/browser-forge/assets/video-tools/manifest.json:1-10`；`skills/browser-forge/references/video-analysis.md:17-31`。）

### 8.4 生成独立 skill+CLI

生成：

```bash
bash "<installed-skill-dir>/scripts/generate-skill" \
  --recording-dir "/absolute/path/to/recording" \
  --skill-name "<new-name>" \
  --description "<description>" \
  --target-domain "<host>" \
  --output-root "/absolute/task-workspace/generated"
```

Generator 会验证录制、create-only reserve/publish，目标已存在时失败，不复制录制物料。（Browser Forge `src/skill-generation/generator.js:204-255`；`skills/browser-forge/scripts/generate-skill:1-9`。）

随后 Agent 只能填充新目录，必须保留 `doctor`、`auth-status`、`describe`，每个非 help invocation stdout 只输出一个 JSON 对象，日志只到 stderr，并运行 tests + validator。（Browser Forge `skills/browser-forge/references/artifact-spec.md:1-41`；`skills/browser-forge/SKILL.md:37-67`。）

验证：

```bash
bash "<installed-skill-dir>/scripts/validate-skill" \
  --skill-dir "/absolute/task-workspace/generated/<new-name>"
```

### 8.5 执行用户验收任务

顺序必须固定：

1. 运行 generated CLI `doctor`；
2. 运行 `auth-status`，只报告 provider/状态，不回显 Cookie/token；
3. 运行 `describe <command>` 核对输入输出和副作用；
4. 对副作用命令先执行 dry-run（若 manifest 声明可用）；
5. 执行用户给出的实际验收 invocation；
6. 保存结构化 stdout、exit code、必要 artifact 路径；
7. 按每一条 success criterion 输出 Pass/Fail/Blocked 和证据；
8. 任一 validator finding、secret finding、未知副作用或需要用户决策的歧义都阻止“ready”结论。

**不能伪造现成能力：** Reasonix 当前没有 `browser_forge_extract_video_frame`、`browser_forge_generate_skill` 等工具；以上 MCP tools 是建议适配层。没有适配层时只能由 Agent 通过 bash 调用 Browser Forge skill 内的脚本。

---

## 9. macOS / Windows 打包与依赖风险

### 9.1 Reasonix binary

Reasonix CLI 可生成无 CGO 的静态 binary，官方 release覆盖 macOS/Windows amd64/arm64。（Reasonix `README.md:79-104`；`.goreleaser.yaml:8-30`。）Browser Forge 应按 app build target vendor 固定版本：

```text
resources/sidecars/darwin-arm64/reasonix
resources/sidecars/darwin-x64/reasonix
resources/sidecars/win32-x64/reasonix.exe
resources/sidecars/win32-arm64/reasonix.exe
```

不要运行时下载，不要依赖用户 PATH，不要调用 npm global package。

### 9.2 Electron/ASAR 路径

Browser Forge 当前 `asar: true`，native tools 通过 `extraResource: ['native-tools']` 放到 app resources。（Browser Forge `forge.config.cjs:34-65`。）Reasonix executable 也必须在 ASAR 外，从 `process.resourcesPath` 构造绝对路径；spawn 使用 argument array、`shell:false`。

### 9.3 macOS 签名与 notarization

当前 Browser Forge postPackage 会把 recorder helper移入 `Contents/Helpers`，签 helper，再签 app并 verify。（Browser Forge `scripts/package-native-helpers.cjs:22-49`。）加入 Reasonix 后应：

1. 对 `reasonix`、video extractor、Node shim、helper app 内所有 Mach-O 分别签名；
2. 再签 helper app；
3. 最后签 Browser Forge app；
4. 使用 hardened runtime、notarize/staple DMG/ZIP；
5. 验证 Gatekeeper 从干净下载路径启动 child process。

不能只依赖 `codesign --deep` 补救未知 nested code；正式流水线应显式签每个 executable。

### 9.4 Windows 签名与杀软

- Reasonix `.exe`、未来 `bf-video-frame.exe`、Browser Forge 主 exe 与 installer都要 Authenticode 签名；
- 避免首次运行下载/解压/执行新 binary，这是 Defender/EDR 高风险模式；
- 用固定 resources 路径和 hash allowlist；
- 使用 Job Object 的 kill-on-close，避免 Electron 崩溃后遗留 agent/MCP children；
- 录制、skill 和 task workspace 路径必须使用 Windows long-path-safe API，不拼 shell command；
- 测试包含空格、CJK、UNC、OneDrive、只读目录和 antivirus quarantine。

### 9.5 Node 与 Python

Reasonix 本身不需要 Node/Python，但 Browser Forge workflow 有两项独立依赖：

- installed `browser-forge` generator/validator/frame launcher 是 Node 脚本；当前脚本调用 `node`，而普通 Electron 安装不保证系统 PATH 有 Node。生产必须提供受控 Node runtime：优先让 installer 写入 app-owned launcher，使用 `ELECTRON_RUN_AS_NODE=1` 调用当前 Electron executable，或把脚本迁为 Electron main/MCP 方法。不能把“用户恰好装了 Node”作为上线前提。
- 生成出来的独立 CLI 要求 Python `>=3.10`，声明 `browser-cookie3>=0.19.1`、`cryptography>=42.0.0`；install script会创建 venv 并 pip install。（Browser Forge `skills/browser-forge/assets/skill-template/scripts/cli/pyproject.toml.tmpl:1-16`；`skills/browser-forge/assets/skill-template/scripts/install.sh:1-65`；launcher `skills/browser-forge/assets/skill-template/scripts/browser_forge-skill.tmpl:1-41`。）

因此“抽帧零依赖”不等于“生成 CLI 零依赖”。面向普通用户分发前必须二选一：

1. 把 generated CLI runtime 迁到 Browser Forge 已经携带的 Node/Electron runtime；**推荐长期方案**。
2. 随 app 分发签名的 embedded Python + offline wheels；体积、C-extension、签名和杀软成本更高，只作为备选。

当前可在 developer/enterprise 环境把 Python 3.10 设为明确 prerequisite，但不能静默在线 pip 安装。

### 9.6 当前平台事实

Browser Forge 当前 package scripts/Forge makers只覆盖 darwin arm64 的 package/make，以及 DMG/ZIP makers。（Browser Forge `package.json:5-20`；`forge.config.cjs:68-81`。）Windows 集成不是“加一个 Reasonix exe”即可完成，仍需 Browser Forge 自身 Windows packaging、recorder/helper、frame extractor 和签名链。

---

## 10. API secret storage 与日志脱敏

### 10.1 Secret owner

- macOS：Keychain item，service=`com.browserforge.model-provider`，account=`<provider-id>`。
- Windows：Credential Manager generic credential，target=`BrowserForge/ModelProvider/<provider-id>`。
- renderer 只获得 `configured: true/false`、masked suffix 和 provider metadata；永不获得 secret、decrypted buffer、Reasonix `.env`、gateway token或 raw child env。
- Electron main 在发上游 request 前即时读取/解密，request 完成后释放 buffer；不把 key写入 JS error、telemetry context、IPC payload或 crash report。

### 10.2 为什么不直接依赖 Reasonix credential store

Reasonix 当前官方路径是 `<REASONIX_HOME>/.env`，不是 OS vault。（Reasonix `docs/CONFIG_PATHS.md:29-45,68-98`；`internal/config/credentials.go:608-615`。）虽然代码仍有 legacy platform keyring probe，当前正常 store/read path仍是 file；不能据此宣称“Reasonix 已使用 Keychain/Credential Manager”。

### 10.3 日志策略

允许记录：task/session/request id、Reasonix version/commit、model ref、event kind、duration、token counts、exit code、redacted error code。

默认禁止记录：

- Authorization/Cookie/CSRF/JWT；
- prompt、reasoning、tool raw input/output；
- HAR bodies；
- generated CLI stdout 中的个人数据；
- 录制绝对路径（telemetry 中使用 recordingId/hash，路径只留本地 debug）；
- ACP `session/request_permission` 的完整文本；
- loopback gateway request body。

Reasonix 自身有 credential redaction helper，Extension sidecar stderr/errors也经过 host redaction。（Reasonix `internal/secrets/redact.go:14-46`；`docs/EXTENSIONS.md:147-163`。）但 Browser Forge 必须在 ACP stderr、MCP/gateway和 renderer IPC 边界再次脱敏，不能依赖单一 regex。

Trajectory 明确包含 prompts、tool args/results、reasoning，应默认禁用；用户导出 debug bundle时单独确认并本地加密。（Reasonix `docs/CLI.md:160-170`。）

---

## 11. Cancellation、崩溃恢复、超时、并发与资源限制

### 11.1 Cancellation state machine

1. UI cancel → main 标记 task `cancelling`；
2. 向 ACP 发 `session/cancel` notification；
3. 等待对应 `session/prompt` 返回 `cancelled`，最多 5 秒；
4. 超时发送 SIGTERM / Windows graceful terminate；
5. 再等 2 秒，仍存活则 kill process group / Job Object；
6. 清理该 sidecar 的 loopback gateway token、MCP token和临时输出；
7. 已存在 generated files不自动删除，标为 interrupted，让用户决定保留或清理。

### 11.2 Crash recovery

- child exit 或 stdout 非法 JSON：立即停止向该 child 写入；所有 active task标为 `interrupted`；
- 保存最后 `sessionId`、task workspace、Reasonix version、最后 seq；
- 1s/2s/5s backoff 最多自动重启 3 次；连续 crash停止自动重启并要求用户操作；
- 重启后 `initialize`，优先 `session/resume`（不 replay）或 `session/load`（需要重建 UI）；Reasonix session API原生支持 load/resume/close/delete。（Reasonix `docs/ACP.md:81-101`。）
- 如果 persisted session不可用，新建 session并注入一个有界 recovery note，绝不把完整 raw logs重新塞给模型。

### 11.3 超时建议

- process spawn → initialize：10s；
- `initialize` RPC：5s；
- `session/new/load/resume`：15s；
- MCP bridge普通 metadata/read：30s；
- frame extraction：60s；
- generator/validator：120s；
- generated acceptance command：默认 10min，可按 manifest command override，上限 30min；
- model turn：不设短硬超时，由用户 cancel；后台 unattended task可设 30min policy timeout。

Reasonix 自带默认 bash timeout 120s、MCP startup 30s、MCP call 300s，可按工具 override。（Reasonix `reasonix.example.toml:122-126,171-180`。）

### 11.4 并发

Reasonix ACP 每个 session 同时只允许一个 active prompt，但一个 process可拥有多个独立 session。（Reasonix `docs/ACP.md:81-96`；`internal/acp/service.go:311-326,1136-1139`。）Browser Forge 首版策略：

- 1 个 Reasonix process / app instance；
- 最多 2 个 active ACP sessions；其余排队；
- 每个 recording/task 独立 task workspace 与 session；
- `max_subagent_concurrency=2`、`max_parallel_writers=1`；
- 同一 generated skill目录只允许一个 writer lease；
- 同一 recording可并发只读分析，但不可并发 publish同名 skill。

### 11.5 资源限制

- main 监控 child RSS/CPU；soft warning 1.5 GiB，hard recycle 2 GiB（先 cancel，后终止）；
- stderr/stdout 单行和累计 buffer设置上限，ACP 本身也有 message size cap和 terminal output 1 MiB cap。（Reasonix `internal/acp/server.go:162-180`；`internal/acp/clientio.go:90-103`。）
- Windows Job Object 限制 process tree；macOS 使用 process group，并在 app quit/crash recovery时清理；
- MCP/gateway只绑定 `127.0.0.1`，不用 `0.0.0.0`，token每次 spawn轮换；
- generated task workspace配额建议 2 GiB，video/recording 原物料只读、不复制进 skill package。

---

## 12. 分阶段路线、边界、风险与 Go/No-Go

### Phase 0：协议/二进制 spike

交付条件：

- vendor 固定 `v1.21.5` 对应 binary/hash/license；
- main 可 spawn `reasonix acp`、initialize、session/new、prompt、cancel、close；
- stdout/stderr严格分流；
- 用 fake/no-network provider 或受控测试 key完成事件映射。

### Phase 1：macOS read-only recording analysis

- 建 app-private `REASONIX_HOME/STATE_HOME/CACHE_HOME`；
- 显式注入 `~/.agents/skills`；
- 以 `/browser-forge` 调用 installed skill；
- 读取 managed recording绝对路径；
- 使用现有 darwin-arm64 frame extractor；
- 不生成、不执行副作用命令。

### Phase 2：skill generation 与 validation

- 每任务创建隔离 workspace；
- generator create-only 输出；
- Agent 填充新 skill；
- tests + `validate-skill` 全通过；
- 输出 artifact/manifest/command contract；
- Python prerequisite明确检测，缺失时 Blocked，不自动安装。

### Phase 3：安全生产化

- Keychain/Credential Manager；
- loopback model gateway；
- loopback MCP tool bridge；
- renderer-safe IPC；
- permission UI adapter；
- crash recovery、session resume、resource quotas、redacted diagnostics；
- Reasonix version pin、compatibility test matrix、SBOM/notice。

### Phase 4：跨平台与普通用户分发

- Windows Browser Forge packaging；
- `win32-x64`/必要时 arm64 frame extractor；
- Node runtime launcher不依赖系统 Node；
- generated CLI迁 Node或分发 embedded Python/wheels；
- macOS notarization、Windows Authenticode和主流 EDR smoke；
- 路径/CJK/long path/OneDrive测试。

### 明确不在本轮实现

- 不实现 Agent UI、renderer 页面或 IPC handler；
- 不实现 Reasonix process manager/ACP client；
- 不实现 MCP bridge/model gateway；
- 不修改 Reasonix 或 Browser Forge runtime 源码；
- 不实现 Keychain/Credential Manager；
- 不打包/签名任何二进制；
- 不生成真实 skill、不执行真实用户副作用验收；
- 不宣称 Reasonix upstream 已支持 Browser Forge tools。

### 主要风险

1. **Secret architecture**：Reasonix 当前正常 credential store为 `.env`；生产必须加 gateway/broker。
2. **Runtime availability**：installed skill脚本需要 Node；generated CLI需要 Python 3.10 + deps。
3. **Windows gap**：Browser Forge packaging与 frame extractor尚未具备 Windows可交付状态。
4. **Protocol drift**：ACP/Reasonix vendor extensions需 pin版本并做 contract tests。
5. **Tool authority**：Agent通过 bash/MCP可产生副作用；必须有路径 scope、permission和 sandbox defense-in-depth。
6. **Cache regression**：动态内容若进入 system/tool schema会降低 cache；需用真实 cache usage监控。
7. **Recording sensitivity**：HAR、DOM、screenshots、video和 generated fixtures可能含个人数据/credentials，validator secret scan不是唯一防线。
8. **Supply chain/signing**：嵌套 Go/Node/Python/native helpers会扩大签名、SBOM和杀软面。

### Go 条件

同时满足以下条件可进入 macOS beta：

- ACP initialize/session/prompt/cancel/close contract test通过；
- installed `browser-forge` skill可稳定发现并显式调用；
- managed recording只读、generated workspace只写；
- frame extraction使用 timeline `videoOffsetMs` 并遵守 coverage；
- generator create-only，tests + validator无 findings；
- 上游 API key不进入 renderer、日志、Reasonix child env或持久化明文文件；
- sidecar及所有 nested binaries已签名、notarized并通过干净机测试；
- cancellation与crash recovery不会遗留 child process或静默重放副作用。

### No-Go 条件

任一成立则不得生产发布：

- 必须把上游 key写入 Reasonix `.env` 才能工作；
- Windows仍无受支持的 frame extractor或 Browser Forge Windows package；
- 依赖用户系统 Node/Python但产品未明确 prerequisite/managed runtime；
- MCP bridge无法强制 recordingId/path/output scope；
- cancel只能 kill且可能导致同一 mutation自动重放；
- Reasonix升级后 ACP/tool event contract未通过 pinning tests；
- validator/secret scanner仍有 finding；
- nested binaries未完成签名/杀软验证；
- 用户验收任务没有逐项可审计结果。

---

## 13. 能力边界清单：现成 vs 适配

| 能力 | Reasonix/Browser Forge 现成 | Browser Forge 需新增 |
| --- | --- | --- |
| 长驻 Agent protocol | Reasonix ACP stdio NDJSON | Electron ACP host/supervisor |
| 多 session/stream/cancel | Reasonix 已有 | UI/IPC 映射、超时和 crash policy |
| OpenAI-compatible/DeepSeek client | Reasonix 已有 | OS-vault-backed local model gateway |
| Tool loop/retry/cache diagnostics | Reasonix 已有 | 产品 telemetry 与阈值 |
| Skill discovery | Reasonix 扫 `.agents/.claude`；BF installer已安装 | 显式 path pin与启动诊断 |
| Browser Forge workflow instructions | installed `browser-forge` skill 已有 | Reasonix-specific absolute runtime invocation guard |
| 录制物料 | BF managed/export layout 已有 | task grant/recordingId resolver |
| `videoOffsetMs` | recorder/skill 已有 | Agent流程约束和 UI证据展示 |
| 抽帧 | darwin-arm64 native extractor 已有 | Windows binary、签名、MCP wrapper |
| skill skeleton/validator | generator/validator 已有 | Agent自动 populate、权限与artifact管理 |
| 独立 generated CLI | Python模板已存在 | managed Python或Node迁移、验收runner |
| Browser Forge tools in Reasonix | **没有** | MCP bridge；不得伪装为 upstream 原生 |
| OS secret vault | Browser Forge 当前未见此实现；Reasonix runtime用 `.env` | Keychain/Credential Manager abstraction |

最终推荐保持两个清晰边界：

1. **Reasonix 是可升级、可替换、版本固定的 Agent sidecar。**
2. **Browser Forge 保持录制、路径授权、secret、model gateway、tool bridge和产品状态的唯一 owner。**

这样既利用 Reasonix 成熟的 Agent loop/ACP/cache，又不把 Browser Forge 的敏感资源和产品权限模型交给第三方 runtime。
