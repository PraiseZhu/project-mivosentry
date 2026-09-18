#!/bin/sh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
export TZ=Asia/Shanghai
export GIT_OPTIONAL_LOCKS=0
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 2
command -v node >/dev/null 2>&1 || { printf '%s\n' '夜巡失败: Node 不可用' >&2; exit 2; }
exec node "$SCRIPT_DIR/nightly-runner.mjs" "$@"
