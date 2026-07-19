#!/usr/bin/env bash
# install.sh — 安装 {operation-name} skill 的运行时依赖
# 运行：bash scripts/install.sh

set -euo pipefail

log() { printf '[install] %s\n' "$*" >&2; }
die() { printf '[install] ERROR: %s\n' "$*" >&2; exit 1; }

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

PYTHON=$(detect_python) || die "未找到 Python 3，请先安装：https://www.python.org"
log "使用 Python: $PYTHON ($($PYTHON --version))"

$PYTHON -m pip install requests --quiet || log "pip install requests 失败，继续（可能已安装）"
$PYTHON -m pip install cryptography --quiet || log "pip install cryptography 失败，继续（明文 Cookie 场景不需要此库）"

log "依赖安装完成"
log "下一步：bash scripts/auth.sh --url https://your-system.jd.com/"
