#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
VENV_DIR="$SCRIPT_DIR/.venv"
PACKAGE_NAME="{{PACKAGE_NAME}}"
WITH_TEST=false
OFFLINE=false

if [ "${BROWSER_FORGE_INSTALL_\
OFFLINE:-0}" = "1" ]; then
  OFFLINE=true
fi
while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-test)
      WITH_TEST=true
      ;;
    --offline)
      OFFLINE=true
      ;;
    *)
      printf '%s\n' 'usage: install.sh [--with-test] [--offline]' >&2
      exit 2
      ;;
  esac
  shift
done
if [ "$OFFLINE" = true ] && [ "$WITH_TEST" = true ]; then
  printf '%s\n' '--with-test is unavailable in offline mode because it requires external test dependencies.' >&2
  exit 2
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  PYTHON=python
else
  printf '%s\n' 'Python 3.10 or newer is required.' >&2
  exit 127
fi

"$PYTHON" -m venv "$VENV_DIR"
if [ -x "$VENV_DIR/bin/python" ]; then
  VENV_PYTHON="$VENV_DIR/bin/python"
elif [ -x "$VENV_DIR/Scripts/python.exe" ]; then
  VENV_PYTHON="$VENV_DIR/Scripts/python.exe"
else
  printf '%s\n' 'Virtual environment Python executable was not found.' >&2
  exit 1
fi

if [ "$OFFLINE" = true ]; then
  PURELIB=$("$VENV_PYTHON" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
  mkdir -p "$PURELIB"
  printf '%s\n' "$SCRIPT_DIR/cli/src" > "$PURELIB/${PACKAGE_NAME}_source.pth"
  exit 0
fi

"$VENV_PYTHON" -m pip install --upgrade pip
if [ "$WITH_TEST" = true ]; then
  "$VENV_PYTHON" -m pip install "$SCRIPT_DIR/cli[test]"
else
  "$VENV_PYTHON" -m pip install "$SCRIPT_DIR/cli"
fi
