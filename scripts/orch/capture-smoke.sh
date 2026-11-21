#!/usr/bin/env bash
# 抓包环境冒烟：拉起来 → 验 noVNC 网页 → 验 CDP 是「真有头」的 Chrome → 收拾干净
#
# 存在的意义：A 的原方案里镜像 entrypoint 自带 --headless，容器看着是起来的、
# CDP 也通，但 /json/version 返回 HeadlessChrome —— noVNC 画面里根本没有浏览器。
# 这条脚本把"必须有头"固化成断言，换镜像/改参数后能立刻发现退化。
#
# 用法：
#   ./scripts/orch/capture-smoke.sh            跑完自动清理（只清 capture 的两个容器）
#
# 断言三条：noVNC 网页 200 / CDP 是 Chrome 且非 Headless / CDP 只监听 loopback。
#   ./scripts/orch/capture-smoke.sh --keep     跑完保留容器，方便人工看 noVNC 画面
#
# 环境变量：CAPTURE_CDP_PORT(9223) / CAPTURE_NOVNC_PORT(6080) / SMOKE_TIMEOUT(90)
# 没有 docker 或 docker 不可用时打印跳过并 exit 0（本地 Mac 开发机上不阻塞门禁）。
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

CDP_PORT=${CAPTURE_CDP_PORT:-9223}
NOVNC_PORT=${CAPTURE_NOVNC_PORT:-6080}
WAIT_SECONDS=${SMOKE_TIMEOUT:-90}
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '\033[31m✗\033[0m %s\n' "$*"; }
info() { printf '· %s\n' "$*"; }

FAIL=0
cleanup() {
  if [ "$KEEP" = "1" ]; then
    info "保留容器（--keep），人工验证后可执行：docker compose --profile capture stop chromium novnc"
    return
  fi
  # 只清 capture 的两个容器：docker compose down 会把 app 也一起停掉，NAS 上不能这么干
  info "清理 capture 容器"
  docker compose --profile capture stop chromium novnc >/dev/null 2>&1
  docker compose --profile capture rm -f chromium novnc >/dev/null 2>&1
}

if ! command -v docker >/dev/null 2>&1; then
  info "未安装 docker，跳过冒烟"
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  info "docker daemon 不可用，跳过冒烟"
  exit 0
fi

trap cleanup EXIT

# ---------- 1) 启动 ----------
info "启动 novnc + chromium"
if ! docker compose --profile capture up -d novnc chromium >/tmp/capture-smoke-up.log 2>&1; then
  bad "启动失败，日志见 /tmp/capture-smoke-up.log"
  tail -20 /tmp/capture-smoke-up.log
  exit 1
fi
ok "容器已创建"

# ---------- 2) noVNC 网页 ----------
code=""
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  code=$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:${NOVNC_PORT}/vnc.html" 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 2
done
if [ "$code" = "200" ]; then
  ok "noVNC 网页 200（:${NOVNC_PORT}/vnc.html）"
else
  bad "noVNC 网页不可用（:${NOVNC_PORT}，最后状态码 ${code:-无响应}）"
  docker logs --tail 20 custom-hosts-novnc 2>&1 | sed 's/^/    /'
  FAIL=1
fi

# ---------- 3) CDP：必须是真有头的 Chrome ----------
version=""
deadline=$(( $(date +%s) + WAIT_SECONDS ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  version=$(curl -s -m 3 "http://127.0.0.1:${CDP_PORT}/json/version" 2>/dev/null)
  [ -n "$version" ] && break
  sleep 2
done

if [ -z "$version" ]; then
  bad "CDP 不可达（http://127.0.0.1:${CDP_PORT}/json/version 无响应）"
  docker logs --tail 20 custom-hosts-chromium 2>&1 | sed 's/^/    /'
  FAIL=1
else
  browser=$(printf '%s' "$version" | grep -o '"Browser": *"[^"]*"' | head -1)
  info "CDP $browser"
  # 断言一：必须是 Chrome / Chromium
  if printf '%s' "$version" | grep -q '"Browser": *"\(Headless\)\{0,1\}Chrom\(e\|ium\)/'; then
    ok "CDP 返回 Chrome 系浏览器"
  else
    bad "CDP 返回的不是 Chrome：$browser"
    FAIL=1
  fi
  # 断言二：绝不能是 HeadlessChrome —— 是的话 noVNC 里看不到浏览器
  if printf '%s' "$version" | grep -q 'Headless'; then
    bad "浏览器处于 headless 模式（HeadlessChrome），noVNC 画面里不会有窗口；检查 entrypoint 是否被覆盖"
    FAIL=1
  else
    ok "不是 headless 模式"
  fi

  # 断言三：CDP 必须只监听 loopback。
  # 防止以后有人图省事把 chromium 改成 bridge 网络再绑 0.0.0.0，把浏览器控制权
  # 暴露给整个局域网。容器内 /proc/net/tcp 的 local_address 里 0100007F = 127.0.0.1，
  # 00000000 = 0.0.0.0。
  hexport=$(printf '%04X' "$CDP_PORT")
  listen=$(docker exec custom-hosts-chromium sh -c "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null" 2>/dev/null \
    | awk -v p=":${hexport}" '$2 ~ p"$" {print $2}' | head -1)
  if [ -z "$listen" ]; then
    bad "容器内没找到监听 ${CDP_PORT} 的 socket（hex ${hexport}），CDP 可能没起来"
    FAIL=1
  else
    addr=${listen%%:*}
    case "$addr" in
      0100007F) ok "CDP 只监听容器 loopback（${listen}）" ;;
      00000000|"") bad "CDP 监听了所有网卡（${listen}），局域网可直接控制浏览器；必须用 host 网络 + loopback" ; FAIL=1 ;;
      *) bad "CDP 监听地址异常：${listen}（期望 0100007F = 127.0.0.1）" ; FAIL=1 ;;
    esac
  fi
fi

# ---------- 4) 结果 ----------
if [ "$FAIL" -eq 0 ]; then
  printf '\n\033[32m冒烟通过\033[0m\n'
else
  printf '\n\033[31m冒烟失败\033[0m\n'
fi
exit "$FAIL"
