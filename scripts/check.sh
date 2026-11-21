#!/usr/bin/env bash
# 统一质量门禁：任何 worktree 里都能跑，且结果可信。
# 用法：./scripts/check.sh          快速（类型 + 构建 + 内嵌 JS + 单测）
#       ./scripts/check.sh --full   额外做一次本地服务冒烟
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
step() { printf '\n== %s ==\n' "$1"; }

step "TypeScript"
if ! npx tsc --noEmit; then FAIL=1; fi

step "Build (local runtime)"
if npm run local:build >/tmp/chs-check-build.log 2>&1; then
  tail -3 /tmp/chs-check-build.log
else
  cat /tmp/chs-check-build.log
  FAIL=1
fi

step "Console inline JS syntax"
if ! node scripts/check-console-js.mjs; then FAIL=1; fi

step "Unit tests"
TESTS=$(find server src -name '*.test.ts' -not -path '*/node_modules/*' 2>/dev/null | sort)
if [ -n "$TESTS" ]; then
  # 纯函数模块才能这样直接跑；有跨目录值依赖的测试请改用 .test.mjs 自己 bundle
  if ! node --experimental-strip-types --test $TESTS; then FAIL=1; fi
else
  echo "（暂无测试文件，跳过）"
fi

if [ "${1:-}" = "--full" ]; then
  step "Smoke: 本地服务"
  PORT=8891 node dist-server/index.mjs >/tmp/chs-check-server.log 2>&1 &
  SRV=$!
  for _ in $(seq 1 20); do curl -s -o /dev/null http://127.0.0.1:8891/local/health && break; sleep 0.5; done
  for p in /host /host_fast /host_block /local/health; do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:8891$p")
    printf '%-16s %s\n' "$p" "$code"
    [ "$code" = "200" ] || FAIL=1
  done
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8891/)
  printf '%-16s %s（期望 401）\n' "/" "$code"
  [ "$code" = "401" ] || FAIL=1
  kill $SRV 2>/dev/null
  wait $SRV 2>/dev/null
fi

if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[32m全部通过\033[0m\n'
else
  printf '\n\033[31m存在失败项\033[0m\n'
fi
exit "$FAIL"
