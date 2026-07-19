# 鉴权实现模式

产出的每个 skill 中的 `scripts/auth.sh` 必须**自包含**以下两套鉴权逻辑，按优先级自动降级。

## 鉴权优先级

```
方案一（优先）：京ME SSO
    ↓ 失败（京ME未启动 / me_token 过期）
方案二（兜底）：本地浏览器 Cookie（Edge/Chrome）
    ↓ 失败
报错退出，提示用户
```

## 方案一：京ME SSO 实现

### 原理

1. 从 `~/Library/Application Support/ME/Cookies`（macOS）读取 `me_token`（明文存储，无需解密）
2. 用 `me_token` 调用 `eopen.getCode` API 获取一次性授权码
3. 用授权码调用 `jdmeUnionLogin` 换取 `sso.jd.com` Cookie
4. 如目标系统需要专属登录态，用 `--url` 参数走 OIDC 流程兑换 `ssa.{app}`
5. 缓存到 `~/.joyclaw/workspace/jd-sso-token.json`

### 适用条件

- 目标系统域名属于 `*.jd.com` 内网域
- 本机已安装并登录京ME桌面客户端

### auth.sh 中的调用模式

```bash
# 获取基础 sso.jd.com（不针对特定系统）
SSO_RESULT=$(bash scripts/auth.sh 2>/dev/null)
SSO_COOKIE=$(echo "$SSO_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['sso.jd.com'])" 2>/dev/null)

# 获取特定系统的专属 Cookie（如 to.jd.com）
AUTH_RESULT=$(bash scripts/auth.sh --url https://to.jd.com/ 2>/dev/null)
COOKIE_HEADER=$(echo "$AUTH_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['cookieHeader'])" 2>/dev/null)
curl -sS 'https://to.jd.com/api/...' -H "Cookie: $COOKIE_HEADER"
```

### 核心 Python 实现参考

完整实现参考 erp-sso-login skill：`~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/erp-sso-login/assets/scripts/extract_jdme_cookies.py`

关键 API 端点：
- `eopen.getCode`：`https://open.jd.com/getCode.do?appid=...&me_token=<me_token>`
- `jdmeUnionLogin`：`https://sso.jd.com/sso/login` POST

## 方案二：浏览器 Cookie 兜底

### 原理

1. 扫描本机 Edge（`~/Library/Application Support/Microsoft Edge/Default/Cookies`）或 Chrome 的 SQLite Cookie 数据库
2. 提取目标域名对应的 Cookie（macOS 下可能需要 Keychain 解密）
3. 构造 `Cookie` header 字符串
4. 缓存到 `~/.config/{skill-name}/auth-session.json`（TTL 14400s）

### 适用条件

- 方案一失败（京ME未启动/me_token 过期/非京东内网）
- 本机 Edge 或 Chrome 已登录目标系统

### auth.sh 中的调用模式

```bash
# 从 Edge/Chrome 提取目标域名的 Cookie
COOKIE_HEADER=$(python3 scripts/_browser_cookie.py --domain example.jd.com 2>/dev/null)
curl -sS 'https://example.jd.com/api/...' -H "Cookie: $COOKIE_HEADER"
```

### 关键实现细节

- Cookie 数据库路径（macOS）：
  - Edge：`~/Library/Application Support/Microsoft Edge/Default/Cookies`
  - Chrome：`~/Library/Application Support/Google/Chrome/Default/Cookies`
- 读取时需关闭浏览器或复制数据库后操作（SQLite 文件锁）
- macOS 的 Cookie 加密值需通过 Keychain 获取解密密钥（`security find-generic-password -w -s 'Microsoft Edge Safe Storage'`）
- 缓存文件权限应为 `0600`

## 安全约束（写入 auth.sh 时强制遵守）

- **凭证不落地**：`auth.sh` 中获取到的 Cookie 值只能保存在 Shell 变量中并写入缓存文件，不得打印到 stdout（仅走 stderr 的进度日志）
- **缓存文件权限**：`chmod 600 ~/.joyclaw/workspace/jd-sso-token.json`
- **占位符原则**：产出 skill 的文档、示例中，凭证位置统一写 `<SSO_COOKIE>` 或 `<COOKIE_HEADER>`，不写实际值
