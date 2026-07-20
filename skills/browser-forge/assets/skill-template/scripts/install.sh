#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
VENV_DIR="$SCRIPT_DIR/.venv"
WITH_TEST=false

if [ "${1:-}" = "--with-test" ]; then
  WITH_TEST=true
  shift
fi
if [ "$#" -ne 0 ]; then
  printf '%s\n' 'usage: install.sh [--with-test]' >&2
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

"$VENV_PYTHON" -m pip install --upgrade pip
if [ "$WITH_TEST" = true ]; then
  "$VENV_PYTHON" -m pip install "$SCRIPT_DIR/cli[test]"
else
  "$VENV_PYTHON" -m pip install "$SCRIPT_DIR/cli"
fi
