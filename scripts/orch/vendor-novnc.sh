#!/usr/bin/env bash
# 从运行中的 noVNC 容器重新同步前端静态资源到 public/novnc/。
#
# 为什么精简：完整 /usr/share/novnc 有 4.7MB，其中 vendor/sinon.js（测试用）
# 和 vendor/browser-es-module-loader（只给不支持 ES module 的老浏览器兜底）
# 在 Chromium/Edge/Firefox 里根本不会被请求。去掉后约 1MB / 97 个文件。
#
# 用法（在 NAS 上、容器已启动时）：
#   ./scripts/orch/vendor-novnc.sh [容器名]
set -euo pipefail

CONTAINER=${1:-custom-hosts-novnc}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEST="$ROOT/public/novnc"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "· 从 $CONTAINER 复制 noVNC 前端"
docker cp "$CONTAINER:/usr/share/novnc" "$TMP/novnc" >/dev/null

rm -rf \
  "$TMP/novnc/vendor/sinon.js" \
  "$TMP/novnc/vendor/browser-es-module-loader" \
  "$TMP/novnc/utils" \
  "$TMP/novnc/vnc_lite.html" \
  "$TMP/novnc/vnc_auto.html"

# 只保留运行时会被引用的部分
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$TMP/novnc/vnc.html" "$TMP/novnc/app" "$TMP/novnc/core" \
      "$TMP/novnc/include" "$TMP/novnc/vendor" "$DEST/"

echo "✓ 已同步到 $DEST（$(du -sh "$DEST" | cut -f1)，$(find "$DEST" -type f | wc -l | tr -d ' ') 个文件）"
echo "  记得把改动提交，并确认 iframe 的 path 参数仍指向 novnc/websockify"
