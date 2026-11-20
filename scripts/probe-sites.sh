#!/usr/bin/env bash
#
# 探测域名是否值得加入 hosts 加速列表。
#
# 原理：hosts 只能修复「DNS 解析层」的问题。
#   - TLS 完整握手成功  -> 域名可直连，若存在 DNS 污染则 hosts 有价值
#   - TCP 通但 TLS 断    -> 典型 TLS SNI 阻断，hosts 无效
#   - TCP 都不通         -> IP 层封锁或解析失败，hosts 也救不了
#
# 用法：
#   ./probe-sites.sh socialclub.rockstargames.com store.epicgames.com
#   ./probe-sites.sh -f candidates.txt
#   CONCURRENCY=8 ./probe-sites.sh -f candidates.txt
#
# 建议在网络干净的环境（手机热点 / 无代理）中运行，并临时 unset 代理变量。

set -u

TIMEOUT="${TIMEOUT:-8}"
CONCURRENCY="${CONCURRENCY:-6}"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"

# 避免代理干扰（探测必须直连，否则测的是代理的连通性）
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY 2>/dev/null || true

probe_one() {
  local domain="$1"
  local http_code tls_ok tcp_ok result

  # 一次请求同时完成 DNS + TCP + TLS + HTTP
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    --max-time "$TIMEOUT" --noproxy '*' -A "$UA" \
    "https://${domain}/" 2>/dev/null)

  if [ -n "$http_code" ] && [ "$http_code" != "000" ]; then
    printf 'DIRECT\t%s\tHTTP %s\t可直连，若被 DNS 污染则 hosts 有效\n' "$domain" "$http_code"
    return
  fi

  # TLS 失败，退一步测 TCP 443
  if nc -z -G 3 "$domain" 443 >/dev/null 2>&1; then
    printf 'SNI\t%s\tTCP 通 / TLS 断\t疑似 SNI 阻断，hosts 无效\n' "$domain"
  else
    printf 'BLOCK\t%s\tTCP 不通\tIP 封锁或解析失败，hosts 无效\n' "$domain"
  fi
}

domains=()
if [ "${1:-}" = "-f" ] && [ -n "${2:-}" ]; then
  while IFS= read -r line; do
    line="${line%%#*}"
    line="$(echo "$line" | tr -d '[:space:]')"
    [ -n "$line" ] && domains+=("$line")
  done < "$2"
else
  domains=("$@")
fi

if [ ${#domains[@]} -eq 0 ]; then
  echo "用法: $0 [-f 文件] 域名..."
  exit 1
fi

echo "探测 ${#domains[@]} 个域名（超时 ${TIMEOUT}s，并发 ${CONCURRENCY}）"
echo "--------------------------------------------------------------------------------"
printf '%-6s %-42s %-16s %s\n' "结论" "域名" "检测" "说明"
echo "--------------------------------------------------------------------------------"

export -f probe_one
export TIMEOUT UA

printf '%s\n' "${domains[@]}" | xargs -P "$CONCURRENCY" -I{} bash -c 'probe_one "$@"' _ {} \
  | sort -k1,1

echo "--------------------------------------------------------------------------------"
echo "DIRECT = 可直连（值得加，前提是本地解析被污染）"
echo "SNI    = TLS 握手被阻断（加 hosts 无效，需代理）"
echo "BLOCK  = 连 TCP 都不通（加 hosts 无效）"
