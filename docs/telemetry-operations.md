# Browser Forge SLS Telemetry Operations

## 数据最终上报到哪里

JD 内部采集版会把埋点以 **阿里云日志服务 SLS WebTracking** 方式直接写入指定 Logstore：

```text
https://{BROWSER_FORGE_SLS_PROJECT}.{BROWSER_FORGE_SLS_HOST}/logstores/{BROWSER_FORGE_SLS_LOGSTORE}/track?APIVersion=0.6.0
```

上报体使用 SLS WebTracking 标准结构：

```json
{
  "__logs__": [{ "event_name": "app_launched", "erp": "zhangsan" }],
  "__topic__": "browser-forge",
  "__source__": "browser-forge-electron",
  "__tags__": { "app": "browser-forge", "channel": "jd-internal" }
}
```

主 App 先写本地 best-effort JSONL 队列，再批量 flush 到 SLS；生成后的 skill CLI 使用同一套 SLS WebTracking 配置直接 best-effort 上报 `generated_skill_used`。

## Required Aliyun SLS configuration

请提供以下配置，用于 telemetry 构建和生成 skill 的运行环境：

| 环境变量 | 含义 | 示例 |
|---|---|---|
| `BROWSER_FORGE_TELEMETRY_BUILD` | 是否启用 App telemetry 构建 | `true` |
| `BROWSER_FORGE_SLS_HOST` | SLS 地域 endpoint，填 host 即可 | `cn-hangzhou.log.aliyuncs.com` |
| `BROWSER_FORGE_SLS_PROJECT` | SLS Project | `browser-forge` |
| `BROWSER_FORGE_SLS_LOGSTORE` | SLS Logstore | `main-trace` |
| `BROWSER_FORGE_SLS_TOPIC` | 可选 topic | `browser-forge` |
| `BROWSER_FORGE_SLS_SOURCE` | 可选 source | `browser-forge-electron` |
| `BROWSER_FORGE_TELEMETRY_DISABLED` | 运行期紧急关闭开关 | `1` / `true` |

生成 skill 的使用埋点复用 `BROWSER_FORGE_SLS_HOST`、`BROWSER_FORGE_SLS_PROJECT`、`BROWSER_FORGE_SLS_LOGSTORE`，也支持同一个 `BROWSER_FORGE_TELEMETRY_DISABLED` 关闭开关。

## Build variants

无采集版本：

```bash
npm run make:mac:private
```

JD 内部采集版本：

```bash
BROWSER_FORGE_SLS_HOST=cn-hangzhou.log.aliyuncs.com \
BROWSER_FORGE_SLS_PROJECT=browser-forge \
BROWSER_FORGE_SLS_LOGSTORE=main-trace \
npm run make:mac:telemetry
```

`make:mac:private` 会把编译期 telemetry 开关固定为 `false`；即使运行环境误设置 SLS 变量，也不会启用上报。`make:mac:telemetry` 会把 SLS 目标以编译期默认值打入 Electron main bundle，同时仍允许 `BROWSER_FORGE_TELEMETRY_DISABLED=1` 临时关闭。

## Recommended SLS indexes

建议为这些字段开启查询分析索引：

- `event_name`
- `event_time`
- `erp`
- `erp_source`
- `app_name`
- `app_version`
- `channel`
- `source_commit`
- `skill_id`
- `skill_name`
- `command_id`
- `ok`
- `status`
- `duration_ms`
- `error_code`

## Core queries

```sql
* | select count(distinct erp) as dau where event_name = 'app_launched'
```

```sql
* | select erp, count(1) as uses group by erp order by uses desc limit 100
```

```sql
* | select skill_id, command_id, count(1) as uses, sum(case when ok = 'true' then 1 else 0 end) as successes where event_name = 'generated_skill_used' group by skill_id, command_id order by uses desc
```

## Privacy guardrails

- 不上传 HAR、DOM、截图、脚本、请求/响应 body。
- 不上传 Cookie、Token、Authorization、Password、Secret 字段。
- 不上传本地路径原文；错误信息只上传 hash。
- 录制 URL 仅上传 host 摘要；query 不上传。
- SLS WebTracking 是公开写入入口，必须在 SLS 侧配置 WebTracking、索引、限流/告警和访问控制；不要把密钥写入客户端。
