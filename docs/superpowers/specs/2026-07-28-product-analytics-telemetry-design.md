# Browser Forge 数据采集与埋点设计

**日期：** 2026-07-28  
**目标分支：** `codex/product-analytics-telemetry`  
**基线分支：** `codex/integrate-product-main`  
**产品形态：** 同时维护两个版本：

1. **无数据采集版本**：完全不采集、不读取 ERP、不发起遥测网络请求。
2. **内部数据采集版本**：面向京东内部用户，采集 ERP 标识、使用频率、关键工具行为和非敏感结果摘要，用于用户反馈、产品优化和问题定位。

---

## 1. 设计原则

### 1.1 必须满足的目标

- 能回答“谁在用”：以京东 ERP 作为可查询用户标识。
- 能回答“用得多不多”：按 ERP、版本、日期统计启动、录制、生成、失败、成功、留存。
- 能回答“做了哪些操作”：记录 App 内关键动作、录制流程状态、Skill 生成流程状态和错误类别。
- 能帮助后续收集反馈：报表可定位具体 ERP、版本、失败场景、最近一次使用时间。
- 数据采集逻辑只存在于 telemetry 分支/telemetry 构建中，普通版本具备可验证的“零上报”能力。

### 1.2 明确不采集的内容

为降低内部站点、账号、业务数据泄露风险，默认**不上传**以下内容：

- HAR、DOM、截图、JS 脚本、Console 原文、网络请求/响应 body。
- 输入框内容、表单值、Cookie、Token、Authorization header、URL query。
- 本地输出目录绝对路径、Chrome 用户目录、机器用户名等可泄露本地环境的原文。
- 被录制页面的完整 URL。默认只采集 hostname、去 query 的路径层级摘要或 hash。

如果未来确实要采集完整录制物料，必须作为单独功能做显式确认、独立开关、独立上传链路和脱敏审计；不放进本方案的默认遥测中。

---

## 2. 双版本方案

### 2.1 分支策略

- `codex/integrate-product-main`：产品主线，保持无数据采集默认能力。
- `codex/product-analytics-telemetry`：长期基于 `codex/integrate-product-main` 维护的内部采集分支。
  - 定期从 `codex/integrate-product-main` merge/rebase。
  - telemetry 相关文件、构建配置、测试只在此分支维护。

### 2.2 构建开关

使用**编译期硬开关 + 运行期保险开关**：

| 开关 | 作用 | 无采集版本 | 采集版本 |
|---|---|---:|---:|
| `BROWSER_FORGE_TELEMETRY_BUILD` | 编译期是否打入 telemetry 模块 | `false` | `true` |
| `BROWSER_FORGE_SLS_HOST` | SLS 所在地域 Endpoint，例如 `cn-hangzhou.log.aliyuncs.com` | 空 | 阿里云 SLS host |
| `BROWSER_FORGE_SLS_PROJECT` | SLS Project 名称 | 空 | 内部 telemetry project |
| `BROWSER_FORGE_SLS_LOGSTORE` | SLS Logstore 名称 | 空 | browser-forge 行为日志 Logstore |
| `BROWSER_FORGE_SLS_TOPIC` | SLS topic | 空 | `browser-forge` |
| `BROWSER_FORGE_SLS_SOURCE` | SLS source | 空 | `browser-forge-electron` |
| `BROWSER_FORGE_TELEMETRY_CHANNEL` | 版本渠道 | `private` | `jd-internal` |
| `BROWSER_FORGE_TELEMETRY_DISABLED` | 运行期强制禁用 | `true` | 默认 `false`，可临时置 `true` |

### 2.3 可验证的“无采集版本”保证

无采集版本必须具备测试证明：

- 打包产物中不包含 SLS host/project/logstore 配置字符串。
- 启动 App 后不读取 ERP，不创建 telemetry queue 文件。
- 用测试 stub 拦截网络请求，确认不会请求采集域名。
- `window.electronAPI` 不暴露 telemetry API。

---

## 3. 用户身份设计

### 3.1 采集字段

| 字段 | 示例 | 说明 |
|---|---|---|
| `erp` | `zhangsan` | 京东 ERP，采集版本的主用户标识 |
| `erp_source` | `sso` / `env` / `manual` / `unknown` | ERP 来源 |
| `install_id` | UUID v4 | 本机安装标识，用于同一 ERP 多设备区分 |
| `app_session_id` | UUID v4 | 每次 App 启动生成 |
| `machine_hash` | sha256 截断 | 用于粗略设备识别，不上传机器名原文 |

### 3.2 ERP 获取优先级

建议做成 `resolveIdentity()` 适配器，按顺序尝试：

1. **京东内部 SSO/统一登录接口**：如果公司内有可用的本机登录态或内网接口，这是首选，返回可信 ERP。
2. **环境变量兜底**：读取 `JD_ERP`、`ERP`、`USER` 等候选值，但只把明确符合 ERP 格式的值作为 `erp_source=env`。
3. **首次启动手动填写**：采集版本如果无法自动识别 ERP，弹出一次“填写 ERP 用于内部反馈”的输入框，保存到本地 userData。
4. **unknown 降级**：仍可上报匿名使用指标，但用户反馈追踪能力下降。

### 3.3 本地缓存

- 保存位置：Electron `app.getPath('userData')/identity.json`。
- 内容：`erp`、`erp_source`、`install_id`、`first_seen_at`、`last_seen_at`。
- ERP 变化时发 `identity_changed` 事件。

---

## 4. 事件模型

### 4.1 通用事件 Envelope

所有事件统一结构：

```json
{
  "event_id": "uuid-v4",
  "event_name": "recording_started",
  "event_time": "2026-07-28T06:30:00.000Z",
  "schema_version": 1,
  "app": {
    "name": "browser-forge",
    "version": "0.1.0",
    "channel": "jd-internal",
    "source_commit": "48c0ffc"
  },
  "user": {
    "erp": "zhangsan",
    "erp_source": "sso",
    "install_id": "uuid-v4",
    "app_session_id": "uuid-v4",
    "machine_hash": "sha256:12chars"
  },
  "runtime": {
    "platform": "darwin",
    "arch": "arm64",
    "electron": "43.1.1",
    "node": "..."
  },
  "properties": {}
}
```

### 4.2 App 生命周期事件

| 事件 | 触发时机 | 关键 properties |
|---|---|---|
| `app_launched` | App ready 后 | `startup_ms`, `is_first_launch`, `telemetry_build` |
| `app_window_created` | 主窗口创建成功 | `width`, `height` |
| `app_quit` | 正常退出前 | `uptime_ms`, `recording_active` |
| `app_error` | main/renderer 捕获异常 | `error_code`, `message_hash`, `stack_hash`, `phase` |

### 4.3 用户配置与入口事件

| 事件 | 触发时机 | 关键 properties |
|---|---|---|
| `identity_resolved` | ERP 识别完成 | `erp_source`, `has_erp` |
| `chrome_path_detected` | 自动探测 Chrome | `success`, `path_type`, `duration_ms` |
| `output_dir_selected` | 用户选择输出目录 | `selected=true`, `path_hash`, `path_depth` |
| `setup_start_clicked` | 点击开始录制 | `has_chrome_path`, `has_output_dir` |

> `path_hash` 只用于识别同一目录是否复用，不上传路径原文。

### 4.4 录制流程事件

| 事件 | 触发时机 | 关键 properties |
|---|---|---|
| `recording_start_requested` | 调用开始录制 API | `requested_port_mode`, `chrome_path_source` |
| `chrome_launch_started` | launchChrome 前 | `port`, `user_data_dir_hash` |
| `chrome_launch_succeeded` | debug endpoint ready | `duration_ms`, `chrome_pid_present` |
| `chrome_launch_failed` | Chrome 启动失败 | `error_code`, `message_hash`, `log_file_exists` |
| `recording_started` | RecordingSession.start 成功 | `recording_id`, `port` |
| `recording_summary_tick` | 录制中定时采样，建议 30s 一次 | `elapsed_ms`, `tab_count`, `event_count`, `network_count`, `console_count`, `artifact_count` |
| `recording_stopped` | 用户停止录制成功 | `duration_ms`, `tab_count`, `network_count`, `click_count`, `input_count`, `scroll_count`, `screenshot_count`, `dom_snapshot_count`, `console_error_count`, `artifact_size_bucket`, `host_count`, `top_hosts` |
| `recording_stop_failed` | 停止录制失败 | `error_code`, `message_hash`, `duration_ms` |
| `recording_abandoned` | App 退出/Chrome 崩溃导致录制中断 | `duration_ms`, `reason` |

`top_hosts` 默认最多 5 个，只保留 hostname，不含 query、path、账号、token。

### 4.5 录制内容摘要事件

这些事件来自 CDP 采集器，但只上传**统计摘要**：

| 事件 | 采样/触发 | 关键 properties |
|---|---|---|
| `recorded_tab_seen` | 新 Tab attach | `target_type`, `hostname`, `url_path_hash` |
| `recorded_navigation` | 主 frame 导航 | `hostname`, `url_path_depth`, `same_host_as_previous` |
| `recorded_user_action_summary` | stop 时聚合 | `click_count`, `input_count`, `scroll_count`, `navigation_count` |
| `recorded_network_summary` | stop 时聚合 | `request_count`, `status_4xx_count`, `status_5xx_count`, `api_host_count`, `largest_body_bucket` |
| `recorded_console_summary` | stop 时聚合 | `log_count`, `warn_count`, `error_count`, `exception_count` |

### 4.6 Skill 自动安装与生成事件

当前项目包含 `agent-skill-installer` 和 `src/skill-generation`，需要覆盖：

| 事件 | 触发时机 | 关键 properties |
|---|---|---|
| `skill_install_started` | 自动安装开始 | `package_version`, `source_commit` |
| `skill_install_succeeded` | 自动安装成功 | `duration_ms`, `target_type` |
| `skill_install_failed` | 自动安装失败 | `error_code`, `message_hash`, `phase` |
| `skill_generation_started` | CLI/生成器开始 | `input_artifact_types`, `has_auth_template`, `dependency_count_bucket` |
| `skill_generation_validation_failed` | manifest/secret/依赖校验失败 | `validator`, `reason_code` |
| `skill_generation_succeeded` | 生成成功 | `duration_ms`, `file_count`, `cli_count`, `skill_doc_present` |
| `skill_generation_failed` | 生成失败 | `error_code`, `message_hash`, `phase` |



### 4.7 统一 key-value 字段规范

所有写入 SLS 的日志最终采用扁平 key-value，避免嵌套 JSON 影响查询。字段命名统一使用 snake_case。

#### 必选公共字段

| 字段 | 含义 | 示例 |
|---|---|---|
| `event_id` | 事件 UUID | `0f4...` |
| `event_name` | 事件名 | `recording_stopped` |
| `event_time` | ISO 时间 | `2026-07-28T06:30:00.000Z` |
| `schema_version` | schema 版本 | `1` |
| `app_name` | 应用/产物名 | `browser-forge` / `browser-forge-generated-skill` |
| `app_version` | App 版本 | `0.1.0` |
| `channel` | 渠道 | `jd-internal` |
| `source_commit` | 构建 commit | `48c0ffc` |
| `erp` | 用户 ERP | `zhangsan` |
| `erp_source` | ERP 来源 | `jd_erp` / `erp` / `user` / `unknown` |
| `install_id` | 安装 ID | UUID |
| `app_session_id` | App/CLI 会话 ID | UUID |
| `machine_hash` | 机器摘要 | sha256 前 12 位 |
| `platform` | 平台 | `darwin` |
| `arch` | 架构 | `arm64` |

#### 场景字段

| 场景 | 字段 |
|---|---|
| App 生命周期 | `startup_ms`, `phase`, `recording_active` |
| 录制 | `recording_id`, `duration_ms`, `tab_count`, `event_count`, `network_count`, `console_count`, `artifact_count`, `top_hosts` |
| Chrome 启动 | `port`, `duration_ms`, `chrome_pid_present`, `error_code`, `message_hash` |
| Skill 安装/生成 | `target_count`, `installed_count`, `skipped_count`, `failed_count`, `skill_id`, `skill_name`, `file_count`, `validator`, `reason_code` |
| 生成 skill 使用 | `skill_id`, `skill_name`, `command_id`, `ok`, `status`, `duration_ms`, `error_code` |

#### 生成 skill 使用事件

生成出来的 skill CLI 模板内置 `generated_skill_used` 事件。任何生成 skill 被调用时，只要运行环境中存在 `BROWSER_FORGE_SLS_HOST`、`BROWSER_FORGE_SLS_PROJECT`、`BROWSER_FORGE_SLS_LOGSTORE`，并且未设置 `BROWSER_FORGE_TELEMETRY_DISABLED=1`，就会 best-effort 上报：

```json
{
  "event_name": "generated_skill_used",
  "app_name": "browser-forge-generated-skill",
  "channel": "jd-internal",
  "erp": "zhangsan",
  "skill_id": "order-tools",
  "skill_name": "order-tools",
  "command_id": "get-order",
  "ok": "true",
  "status": "success",
  "duration_ms": "123"
}
```

该上报不影响 CLI stdout 的 JSON envelope；上报失败会被吞掉，不影响 skill 命令结果。

---

## 5. 上报链路

### 5.1 客户端链路

1. App/CLI 调用 `telemetry.track(eventName, properties)`。
2. `TelemetryClient` 补齐 envelope、身份、版本、运行时字段。
3. 事件先写入本地 JSONL 队列：`userData/telemetry/events.jsonl`。
4. 后台批量 flush：
   - 每 10 条或每 15 秒上传一次。
   - App 退出前尝试 flush，最多等待 1500ms。
   - 失败后指数退避，最多保留 7 天或 10MB。
5. 上传成功后从队列中删除对应事件。

### 5.2 阿里云 SLS WebTracking 接入

初步方案采用 **阿里云日志服务 SLS WebTracking**，客户端直接写入指定 Logstore，不再自建 telemetry 接入网关。

采集版本构建时注入以下配置：

```js
{
  host: process.env.BROWSER_FORGE_SLS_HOST,
  project: process.env.BROWSER_FORGE_SLS_PROJECT,
  logstore: process.env.BROWSER_FORGE_SLS_LOGSTORE,
  time: 10,
  count: 10,
  topic: process.env.BROWSER_FORGE_SLS_TOPIC || 'browser-forge',
  source: process.env.BROWSER_FORGE_SLS_SOURCE || 'browser-forge-electron',
  tags: {
    app: 'browser-forge',
    channel: 'jd-internal'
  }
}
```

客户端事件仍保留本方案定义的统一 envelope，但最终通过 WebTracking SDK 的 `send` / `sendBatchLogs` 写入 SLS。每条 SLS log 对应一个 telemetry event，字段扁平化，便于 SLS 建索引和查询分析。

### 5.3 SLS 资源与查询建议

- Project：建议独立创建，例如 `browser-forge-telemetry`，避免和业务日志混用。
- Logstore：建议独立 Logstore，例如 `browser-forge-events`，开启 WebTracking 写入能力。
- 索引：为 `event_name`、`event_time`、`erp`、`app_version`、`channel`、`source_commit`、`recording_id`、`error_code` 建字段索引。
- Dashboard：直接基于 SLS 查询分析能力创建 DAU、录制漏斗、失败率、问题用户列表等看板。
- 数据保留：初期建议 30-90 天；稳定后按内部成本和排障需要调整。

> 安全备注：如果采用匿名 WebTracking 直传，需要开启 Logstore WebTracking/匿名写入能力，存在被伪造写入和数据污染风险；生产化时建议评估 SLS STS 插件模式，用临时凭证限制写入权限。

---

## 6. Dashboard 与查询目标

### 6.1 核心指标

| 指标 | 计算方式 |
|---|---|
| DAU/WAU | `count(distinct erp)` where `event_name=app_launched` |
| 人均启动次数 | `app_launched count / active erp count` |
| 录制启动率 | `recording_started users / app_launched users` |
| 录制成功率 | `recording_stopped count / recording_started count` |
| Chrome 启动失败率 | `chrome_launch_failed / chrome_launch_started` |
| 平均录制时长 | avg `recording_stopped.duration_ms` |
| Skill 生成成功率 | `skill_generation_succeeded / skill_generation_started` |
| 最近活跃用户 | group by `erp`, max `event_time` |
| 问题用户列表 | 最近 N 天有 failed/error 事件的 ERP |

### 6.2 反馈定位视图

按 ERP 查询：

- 最近一次启动时间、App 版本、source commit。
- 最近 10 次录制的成功/失败、时长、摘要计数。
- 最近错误类别和 stack hash。
- 是否完成 skill 自动安装。
- 是否发生 skill 生成失败，失败阶段是什么。

---

## 7. 脱敏与合规控制

### 7.1 字段脱敏规则

| 数据 | 处理方式 |
|---|---|
| ERP | 明文采集，仅内部采集版本启用 |
| 本地路径 | sha256 hash + path depth，不传原文 |
| URL | 仅 hostname + path hash/path depth，query 永不上传 |
| 错误栈 | 只传 stack hash；本地日志保留原文 |
| Console | 不传原文，只传级别计数 |
| DOM/HAR/截图/脚本 | 不上传，只传数量和体积 bucket |

### 7.2 运行期保护

- 所有 track 调用走白名单事件名；未知事件默认拒绝上报。
- properties 做 schema 校验，禁止对象中出现 `cookie`、`token`、`authorization`、`password` 等敏感 key。
- 单事件大小限制，建议 16KB；超限丢弃并本地记录。
- SLS host/project/logstore 必须只在 telemetry 构建中注入；非 telemetry 构建中为空。

---

## 8. 代码落点建议

### 8.1 新增模块

| 文件 | 职责 |
|---|---|
| `src/main/telemetry/config.js` | 读取构建开关、SLS host/project/logstore/topic/source、channel、采样配置 |
| `src/main/telemetry/identity.js` | ERP/install_id/machine_hash 解析与缓存 |
| `src/main/telemetry/sanitizer.js` | URL、路径、错误、properties 脱敏 |
| `src/main/telemetry/client.js` | `track()`、事件 envelope、本地队列、SLS WebTracking SDK flush |
| `src/main/telemetry/noop.js` | 无采集版本使用的 no-op 实现 |
| `src/main/telemetry/events.js` | 事件名和 schema 白名单 |
| `src/main/telemetry/ipc.js` | renderer 侧安全埋点桥接，可选 |

### 8.2 修改现有模块

| 文件 | 修改点 |
|---|---|
| `src/main/index.js` | App 生命周期、window created、quit、skill install 埋点 |
| `src/main/recorder/http-server.js` | start/stop/chrome launch/summary/error 埋点 |
| `src/main/recorder/index.js` | 输出录制统计摘要，供 stop 事件使用 |
| `src/main/agent-skill-installer.js` | 安装成功/失败埋点 |
| `src/skill-generation/cli.mjs` | CLI 开始/成功/失败/校验失败埋点 |
| `src/preload/index.js` | 如需要 renderer 事件，暴露受限 `trackUiEvent` |
| `src/renderer/src/App.jsx` | 页面切换和按钮点击埋点，可只记录语义事件 |
| `forge.config.cjs` / `electron.vite.config.js` | 注入 telemetry build constants |
| `package.json` | 增加 `make:mac:telemetry`、`make:mac:private` 脚本 |

---

## 9. 推荐落地顺序

1. 先实现 no-op telemetry 接口，所有调用点都依赖同一接口。
2. 增加采集版本构建常量，保证无采集版本默认 no-op。
3. 实现身份解析和本地 install_id。
4. 实现本地 JSONL 队列和批量上传。
5. 给 App 生命周期、录制 start/stop/chrome failure 加第一批埋点。
6. 给 skill install/generation 加第二批埋点。
7. 增加脱敏/schema 测试和“无采集版本零上报”测试。
8. 接入 SLS WebTracking staging Logstore 后做灰度：先 5-10 个 ERP 试用，再扩大。

---

## 10. 验收标准

- 能构建两个 macOS 包：一个无采集，一个内部采集。
- 无采集版本测试证明不会读 ERP、不会落队列、不会包含或访问 SLS host/project/logstore。
- 采集版本能在离线情况下正常使用，事件进入本地队列，联网后补发。
- 每条事件都包含 ERP 或明确的 `erp_source=unknown`。
- 停止一次录制后，后台可按 ERP 查询到：启动、开始录制、停止录制、录制时长、tab/network/action 摘要。
- 任何上报事件中不包含 HAR、DOM、截图、脚本、Cookie、Token、完整 URL query 或本地路径原文。
