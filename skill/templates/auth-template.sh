#!/usr/bin/env bash
# auth.sh — 自包含鉴权脚本（方案一：京ME SSO；方案二：浏览器 Cookie）
#
# 用法:
#   bash scripts/auth.sh                          # 获取 sso.jd.com 基础登录态
#   bash scripts/auth.sh --url https://xxx.jd.com # 兑换目标系统专属 Cookie
#   bash scripts/auth.sh --cookie-header          # 仅输出可用于 curl 的 Cookie 字符串
#
# 输出（stdout，JSON 格式）:
#   基础模式: { "sso.jd.com": "BJ.xxx", "userCode": "xxx", "userName": "xxx" }
#   --url 模式: { "cookieHeader": "ssa.xxx=...; sso.jd.com=...", "cookies": {...} }
#
# 依赖:
#   - 方案一: 京ME桌面客户端已登录（~/Library/Application Support/ME/Cookies）
#   - 方案二: Edge 或 Chrome 已登录目标系统（本机 Cookie 数据库）
#   - Python 3 + requests + cryptography（可选，仅加密 Cookie 需要）
#     安装: bash scripts/install.sh
#
# 安全: 凭证不写入日志；缓存文件权限 0600；产出文档中统一使用占位符 <SSO_COOKIE>

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SKILL_NAME="{operation-name}"

log() { printf '[auth] %s\n' "$*" >&2; }

TARGET_URL=""
COOKIE_HEADER_ONLY=false
NO_CACHE=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) TARGET_URL="$2"; shift 2 ;;
    --cookie-header) COOKIE_HEADER_ONLY=true; shift ;;
    --no-cache) NO_CACHE=true; shift ;;
    --help|-h)
      cat >&2 <<'HELPEOF'
用法: bash scripts/auth.sh [选项]

功能:
  自动获取京东内部系统登录态（优先京ME SSO，失败后降级浏览器 Cookie）

输入参数:
  --url <URL>       (选填) 目标系统 URL，用于兑换专属 Cookie（如 https://to.jd.com）
  --cookie-header   (选填) 仅输出 Cookie 字符串（适合直接传给 curl -H）
  --no-cache        (选填) 忽略缓存，强制重新获取

输出:
  JSON: { "sso.jd.com": "...", "userCode": "...", "userName": "..." }
  --url 模式: { "cookieHeader": "...", "cookies": {...} }

依赖:
  - 京ME 已登录（方案一）或浏览器已登录目标系统（方案二）
  - Python 3 + requests（bash scripts/install.sh 安装）

下一步建议:
  → COOKIE=$(bash scripts/auth.sh --url https://xxx.jd.com --cookie-header 2>/dev/null)
  → curl -sS 'https://xxx.jd.com/api/...' -H "Cookie: $COOKIE"
HELPEOF
      exit 0
      ;;
    *) log "未知参数: $1"; exit 1 ;;
  esac
done

detect_python() {
  for cmd in python3 python python.exe; do
    if command -v "$cmd" >/dev/null 2>&1; then
      local ver
      ver=$("$cmd" -c "import sys; print(sys.version_info.major)" 2>/dev/null)
      [ "$ver" = "3" ] && { echo "$cmd"; return 0; }
    fi
  done
  return 1
}

PYTHON=$(detect_python) || {
  log "未找到 Python 3，请运行 bash scripts/install.sh"
  exit 1
}

try_jdme_sso() {
  log "尝试方案一：京ME SSO..."
  local args=""
  [ -n "$TARGET_URL" ] && args="--url $TARGET_URL"
  [ "$COOKIE_HEADER_ONLY" = true ] && args="$args --cookie-header"
  [ "$NO_CACHE" = true ] && args="$args --no-cache"
  $PYTHON "$SCRIPT_DIR/_jdme_sso.py" $args
}

try_browser_cookie() {
  log "方案一失败，尝试方案二：浏览器 Cookie..."
  local domain=""
  if [ -n "$TARGET_URL" ]; then
    domain=$(echo "$TARGET_URL" | $PYTHON -c "import sys,urllib.parse; print(urllib.parse.urlparse(sys.stdin.read().strip()).hostname)")
  fi
  [ -z "$domain" ] && domain="jd.com"
  $PYTHON "$SCRIPT_DIR/_browser_cookie.py" --domain "$domain"
}

if try_jdme_sso; then
  exit 0
fi

if try_browser_cookie; then
  exit 0
fi

log "鉴权失败：请确认京ME已登录，或在 Edge/Chrome 中登录目标系统后重试"
log "调试：bash scripts/auth.sh --no-cache"
exit 1
