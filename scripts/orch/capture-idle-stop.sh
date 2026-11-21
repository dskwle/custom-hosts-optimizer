#!/usr/bin/env bash
# 抓包环境闲置自动停止
#
# 为什么要它：NAS 是 7x24 长期低负载设备，Chromium 常驻 300–500MB 很浪费，
# 而抓包是"偶尔用一次"的功能。这个脚本在确认没人用之后把 chromium 容器停掉，
# X 显示（novnc 容器）留着，下次 `start chromium` 秒开。
#
# 判定"有人在用"的两个信号（任一命中就重置计时）：
#   1. 容器 CPU 使用率 >= CPU_THRESHOLD（页面在渲染/加载/用户在看视频）
#   2. CDP /json/list 的标签页集合发生变化（新开了页面、导航到别的站点）
# 两个信号都拿不到（CDP 挂了、容器没跑）不算活动，直接进入倒计时——
# 浏览器崩了还留着占内存没有意义。
#
# 用法：
#   ./scripts/orch/capture-idle-stop.sh            单次检查（推荐 cron，每 5 分钟一次）
#   ./scripts/orch/capture-idle-stop.sh --loop     常驻，每 INTERVAL 秒检查一次
#   ./scripts/orch/capture-idle-stop.sh --status   只打印当前判定依据，不停容器
#
# 环境变量：
#   CAPTURE_CDP_URL    默认 http://127.0.0.1:9222
#   CAPTURE_CONTAINER  默认 custom-hosts-chromium
#   IDLE_MINUTES       默认 10
#   CPU_THRESHOLD      默认 5（百分比，整数或小数）
#   INTERVAL           默认 60（--loop 模式的检查间隔，秒）
#   STATE_FILE         默认 /tmp/capture-idle.state
#
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

CDP_URL=${CAPTURE_CDP_URL:-http://127.0.0.1:9222}
CONTAINER=${CAPTURE_CONTAINER:-custom-hosts-chromium}
IDLE_MINUTES=${IDLE_MINUTES:-10}
CPU_THRESHOLD=${CPU_THRESHOLD:-5}
INTERVAL=${INTERVAL:-60}
STATE_FILE=${STATE_FILE:-/tmp/capture-idle.state}

MODE=once
case "${1:-}" in
  --loop) MODE=loop ;;
  --status) MODE=status ;;
  "") ;;
  *) echo "未知参数：$1（可用：--loop / --status）" >&2; exit 2 ;;
esac

log() { printf '[capture-idle] %s %s\n' "$(date '+%F %T')" "$*"; }

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}

# 标签页指纹：把 /json/list 里的 page 类型 target 的 id+url 拼起来做校验和。
# 用 cksum 而不是 md5sum，busybox / macOS 都有。
target_signature() {
  local json
  json=$(curl -fsS -m 2 "$CDP_URL/json/list" 2>/dev/null) || { echo "down"; return; }
  printf '%s' "$json" \
    | tr '{' '\n' \
    | grep -o '"type": *"page"[^}]*' \
    | grep -o '"id": *"[^"]*"\|"url": *"[^"]*"' \
    | cksum \
    | tr -d ' '
}

# 容器 CPU 百分比（"0.12%" → "0.12"）；取不到返回空串
container_cpu() {
  docker stats --no-stream --format '{{.CPUPerc}}' "$CONTAINER" 2>/dev/null \
    | head -1 | tr -d '% ' || true
}

cpu_above_threshold() {
  local cpu=$1
  [ -n "$cpu" ] || return 1
  # 用 awk 做浮点比较，bash 只支持整数
  awk -v c="$cpu" -v t="$CPU_THRESHOLD" 'BEGIN { exit !(c >= t) }'
}

now() { date +%s; }

read_state() {
  LAST_ACTIVE=0
  LAST_SIG=""
  if [ -f "$STATE_FILE" ]; then
    read -r LAST_ACTIVE LAST_SIG _ <"$STATE_FILE" || true
    LAST_ACTIVE=${LAST_ACTIVE:-0}
  fi
}

write_state() {
  printf '%s %s\n' "$1" "$2" >"$STATE_FILE"
}

check_once() {
  if ! container_running; then
    log "容器 $CONTAINER 未运行，无需处理"
    return 0
  fi

  local sig cpu act=0 reason=""
  sig=$(target_signature)
  cpu=$(container_cpu)

  read_state
  # CDP 探测失败（sig=down）不算活动：浏览器崩了/正在重启时本来就拿不到标签页，
  # 把它当成"刚有操作"会让倒计时永远归零，容器永远停不下来。
  if [ "$sig" != "down" ] && [ "$sig" != "$LAST_SIG" ]; then
    act=1
    reason="标签页变化(${LAST_SIG:-none}→${sig})"
  fi
  if cpu_above_threshold "$cpu"; then
    act=1
    reason="${reason:+$reason, }CPU ${cpu}% ≥ ${CPU_THRESHOLD}%"
  fi

  local ts
  ts=$(now)
  if [ "$act" = "1" ]; then
    write_state "$ts" "$sig"
    log "有活动：${reason}，重置闲置计时"
    return 0
  fi

  # 没有活动：以 state 里的时间为准；首次运行时用当前时间起步，不立即停
  [ "$LAST_ACTIVE" -gt 0 ] || LAST_ACTIVE=$ts
  write_state "$LAST_ACTIVE" "$sig"

  local idle=$((ts - LAST_ACTIVE))
  local limit=$((IDLE_MINUTES * 60))
  log "无活动：已闲置 ${idle}s / ${limit}s（CPU ${cpu:-?}%，target=${sig}）"

  if [ "$MODE" = "status" ]; then
    return 0
  fi

  if [ "$idle" -ge "$limit" ]; then
    log "超过 ${IDLE_MINUTES} 分钟无活动，停止 ${CONTAINER}（X 显示保留，下次 start 秒开）"
    # 只停浏览器，不停 novnc：novnc 常驻 < 100MB，留着能让前端 iframe 直接重连
    if docker compose --profile capture stop chromium >/dev/null 2>&1; then
      log "已停止。恢复：docker compose --profile capture start chromium"
      rm -f "$STATE_FILE"
    else
      log "停止失败，请手工检查 docker compose --profile capture ps"
      return 1
    fi
  fi
  return 0
}

if [ "$MODE" = "loop" ]; then
  log "常驻模式启动：每 ${INTERVAL}s 检查一次，闲置阈值 ${IDLE_MINUTES} 分钟"
  while true; do
    check_once || true
    sleep "$INTERVAL"
  done
fi

check_once
