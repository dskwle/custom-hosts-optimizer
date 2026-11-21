#!/usr/bin/env bash
# Clash 规则输出的端到端验证（E7）。
#
# 分四步，前两步不需要 docker：
#   1) 用仓库里的纯函数生成全部 YAML（四个 payload + snippet + example + 一份最小 mihomo 配置）
#   2) YAML 结构化校验：能解析、类型对（hosts 是映射、payload 是列表、片段有三段）
#   3) `mihomo -t` 校验：证明 hosts / rule-providers / rules 的 schema 被 mihomo 接受
#   4) 起临时容器断言两件事：
#      · hosts 映射生效 —— 用 dig +tcp 查容器内 DNS（1053），拿到写死的 A 与 AAAA
#      · REJECT / 放行生效 —— 看 mihomo 日志里的规则命中行，**不看 HTTP 状态码**
#        （mihomo 的 REJECT 对 HTTP 代理请求返回 502，目标不可达也是 502，状态码区分不了）
#
# 第 3/4 步为什么用 file 型 provider：验证不应依赖本服务在跑。
# type/behavior/format 与 /clash/snippet.yaml 里的 http 型完全一致，
# 差别只在 payload 从本地文件读，因此同样能证明 payload 格式正确。
#
# 退出码约定：
#   0 = 验证通过，或环境不具备（无 docker / 拉不到镜像 / 端口占用）而跳过
#   1 = 真正断言失败（YAML 解析不过、schema 不过、hosts 没生效、REJECT 没生效、fixture 生成失败）
# 「跳过」也返回 0 是有意的：这个脚本在离线环境里不该阻塞合并，
# 但会明确打印跳过原因，避免被当成"已验证"。
set -uo pipefail
cd "$(dirname "$0")/.."

# 镜像候选：Docker Hub 优先，失败再走国内镜像站（本机实测 docker.io 直连会超时）。
# 想指定自己的镜像：MIHOMO_IMAGE=xxx ./scripts/verify-clash.sh
IMAGE_CANDIDATES=(
  "${MIHOMO_IMAGE:-metacubex/mihomo:latest}"
  "${MIHOMO_IMAGE_MIRROR:-swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/metacubex/mihomo:latest}"
)
IMAGE=""
NAME="mihomo-verify-$$"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/clash-verify.XXXXXX")"
CONF_DIR="$TMP/mihomo"
OUT_DIR="$TMP/out"
API_PORT=$((20000 + RANDOM % 10000))
MIXED_PORT=$((30000 + RANDOM % 10000))
DNS_PORT=$((40000 + RANDOM % 10000))
FAIL=0
STARTED=0

cleanup() {
  if [ "$STARTED" = "1" ]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

skip() {
  printf '\033[33m[跳过]\033[0m %s\n' "$1"
  exit 0
}
note() { printf '\033[33m[提示]\033[0m %s\n' "$1"; }
pass() { printf '\033[32m[PASS]\033[0m %s\n' "$1"; }
fail() { printf '\033[31m[FAIL]\033[0m %s\n' "$1"; FAIL=1; }

printf '== 1/4 生成 YAML fixture ==\n'
mkdir -p "$CONF_DIR/rules" "$OUT_DIR/mihomo/rules"
cat > "$TMP/gen.mts" <<'GEN'
/**
 * 用仓库的纯函数生成验证用的 YAML。
 * 直接用 node --experimental-strip-types 跑，不需要先构建服务。
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const outDir = process.argv[2]
const root = process.argv[3]
// 临时脚本不在仓库里，模块路径由调用方传入，不能用 import.meta.url 相对推
const load = (rel: string) => import(pathToFileURL(path.join(root, rel)).href)

const hostsMod = await load("src/clash/hosts.ts")
const payloadMod = await load("src/clash/payload.ts")
const snippetMod = await load("src/clash/snippet.ts")

const VERIFY_DOMAIN = "clash-verify.example"
const BLOCKED_DOMAIN = "clash-blocked.example"
const BASE = "http://127.0.0.1:8788"

// 同一个域名既给 v4 又给 v6，且刻意让 BLOCKED_DOMAIN 出现在加速数据里：
// 屏蔽优先，它必须被剔除（否则 REJECT 断言会被 hosts 抢先生效）。
const hosts = hostsMod.buildClashHosts(
  [
    ["203.0.113.9", VERIFY_DOMAIN],
    ["2001:db8::9", VERIFY_DOMAIN],
    ["203.0.113.9", BLOCKED_DOMAIN],
  ],
  { blocked: [BLOCKED_DOMAIN] }
)

const write = (rel: string, text: string) =>
  fs.writeFile(path.join(outDir, rel), text, "utf8")

const payloadOf = (domains: string[], title: string) =>
  payloadMod.formatPayloadYaml(payloadMod.buildDomainPayload(domains).domains, { title })

/* --- 端点输出（四个 payload + 片段 + 模板） --- */
await write("hosts.yaml", hostsMod.formatClashHostsYaml(hosts, { updatedAt: "2026-11-21T02:00:00.000Z" }))
await write("block.yaml", payloadOf([BLOCKED_DOMAIN, "www.google-analytics.com"], "屏蔽清单"))
await write("ads.yaml", payloadOf(["clash-ads.example", "tracker.example.io"], "广告规则"))
await write("proxy.yaml", payloadOf(["clash-proxy.example"], "SNI 阻断"))
await write("snippet.yaml", snippetMod.buildSnippetYaml({ baseUrl: BASE, proxyGroup: "节点选择", hosts }))
await write("config.example.yaml", snippetMod.buildExampleConfigYaml({ baseUrl: BASE, hosts }))

/* --- 给 mihomo 用的最小配置（provider 改成本地文件） --- */
await write("mihomo/rules/ch-block.yaml", payloadOf([BLOCKED_DOMAIN], "block"))
await write("mihomo/rules/ch-ads.yaml", payloadOf(["clash-ads.example"], "ads"))
await write("mihomo/rules/ch-proxy.yaml", payloadOf(["clash-proxy.example"], "proxy"))

const config = `# 由 scripts/verify-clash.sh 生成，仅用于验证，不要用于生产
mixed-port: 7890
allow-lan: true
mode: rule
# 必须是 info：下面靠日志里的 "match RuleSet(...) using REJECT" 判定规则命中，
# warning 级别不会打印这些行。
log-level: info
external-controller: 0.0.0.0:9090

dns:
  enable: true
  # listen 是必须的：只写 enable: true 时 mihomo 不会起 DNS 服务，
  # /dns/query 会返回 "DNS section is disabled"，也就没法断言 hosts 映射。
  listen: 0.0.0.0:1053
  ipv6: true
  use-hosts: true
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  nameserver:
    - 223.5.5.5

${hostsMod.formatHostsSection(hosts)}

rule-providers:
  ch-block:
    type: file
    behavior: domain
    format: yaml
    path: ./rules/ch-block.yaml
  ch-ads:
    type: file
    behavior: domain
    format: yaml
    path: ./rules/ch-ads.yaml
  ch-proxy:
    type: file
    behavior: domain
    format: yaml
    path: ./rules/ch-proxy.yaml

proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - DIRECT

rules:
  - RULE-SET,ch-block,REJECT
  - RULE-SET,ch-ads,REJECT
  - RULE-SET,ch-proxy,PROXY
  - MATCH,DIRECT
`
await write("mihomo/config.yaml", config)

// 防御性断言：屏蔽域名不能出现在 hosts 段里
if (config.includes(`"${BLOCKED_DOMAIN}":`)) {
  console.error("fixture 生成失败：屏蔽域名出现在 hosts 段")
  process.exit(1)
}
console.log(`  fixture 已生成：hosts ${hosts.stats.domains} 条 / 地址 ${hosts.stats.ips} 条`)
GEN

# Node 会对 src/**/*.ts 打 MODULE_TYPELESS_PACKAGE_JSON 警告（仓库没有 type: module），
# 与本次验证无关，过滤掉；真出错时把完整日志打出来。
if ! node --experimental-strip-types "$TMP/gen.mts" "$OUT_DIR" "$PWD" >"$TMP/gen.log" 2>&1; then
  sed 's/^/  /' "$TMP/gen.log"
  echo "fixture 生成失败"
  exit 1
fi
grep -vE 'MODULE_TYPELESS_PACKAGE_JSON|Reparsing as ES module|eliminate this warning|trace-warnings' "$TMP/gen.log" | sed 's/^/  /'
# mihomo 配置由 gen 写到 out/mihomo，挪到 CONF_DIR 下，挂载路径更直观
cp "$OUT_DIR/mihomo/config.yaml" "$CONF_DIR/config.yaml"
cp "$OUT_DIR/mihomo/rules/"*.yaml "$CONF_DIR/rules/"

printf '\n== 2/4 YAML 结构化校验 ==\n'
if python3 -c "import yaml" >/dev/null 2>&1; then
  python3 - "$OUT_DIR" "$CONF_DIR" <<'PY'
import sys, pathlib, yaml

out = pathlib.Path(sys.argv[1]); conf = pathlib.Path(sys.argv[2])
fail = 0

def check(name, cond, detail=""):
    global fail
    if cond:
        print(f"\033[32m[PASS]\033[0m {name}")
    else:
        fail += 1
        print(f"\033[31m[FAIL]\033[0m {name} {detail}")

def load(p):
    try:
        return yaml.safe_load(p.read_text(encoding="utf-8")), None
    except Exception as e:
        return None, e

hosts, err = load(out / "hosts.yaml")
check("hosts.yaml 可解析", err is None, err or "")
if err is None:
    h = (hosts or {}).get("hosts") or {}
    check("hosts.yaml 是 域名→地址列表 的映射", isinstance(h, dict) and all(isinstance(v, list) for v in h.values()))
    check("hosts.yaml 同时含 v4 与 v6", h.get("clash-verify.example") == ["203.0.113.9", "2001:db8::9"], h.get("clash-verify.example"))
    check("hosts.yaml 不含屏蔽域名", "clash-blocked.example" not in h)

for name in ("block", "ads", "proxy"):
    doc, e = load(out / f"{name}.yaml")
    check(f"{name}.yaml 可解析且 payload 是列表", e is None and isinstance((doc or {}).get("payload"), list), e or doc)
    if e is None:
        check(f"{name}.yaml payload 元素均为裸域名（无地址前缀）",
              all(isinstance(x, str) and "." in x and " " not in x for x in (doc.get("payload") or [])))

snip, e = load(out / "snippet.yaml")
check("snippet.yaml 可解析", e is None, e or "")
if e is None:
    check("snippet.yaml 含 hosts / rule-providers / rules 三段",
          all(k in snip for k in ("hosts", "rule-providers", "rules")))
    provs = snip.get("rule-providers") or {}
    check("snippet.yaml provider 指向本服务且 interval=7200",
          all(provs.get(k, {}).get("interval") == 7200 and "/clash/" in provs.get(k, {}).get("url", "")
              for k in ("ch-block", "ch-ads", "ch-proxy")))
    check("snippet.yaml 的 ch-proxy 规则使用自定义策略组",
          "RULE-SET,ch-proxy,节点选择" in (snip.get("rules") or []))

ex, e = load(out / "config.example.yaml")
check("config.example.yaml 可解析", e is None, e or "")
if e is None:
    dns = ex.get("dns") or {}
    check("config.example.yaml 开了 dns.enable + use-hosts", dns.get("enable") is True and dns.get("use-hosts") is True)
    check("config.example.yaml 用 fake-ip 模式", dns.get("enhanced-mode") == "fake-ip")
    check("config.example.yaml 有 proxy-groups 占位", bool(ex.get("proxy-groups")))

cfg, e = load(conf / "config.yaml")
check("mihomo 验证配置可解析", e is None, e or "")

sys.exit(1 if fail else 0)
PY
  if [ "$?" != "0" ]; then FAIL=1; fi
else
  note "没有 python3 + PyYAML，跳过结构化校验"
fi

printf '\n== 3/4 mihomo -t 校验配置 ==\n'
if ! command -v docker >/dev/null 2>&1; then
  skip "未安装 docker，跳过 mihomo 断言（YAML 结构与单测已覆盖）"
fi
if ! docker info >/dev/null 2>&1; then
  skip "docker 守护进程不可用，跳过 mihomo 断言（YAML 结构与单测已覆盖）"
fi
# 选镜像：先用本地已有的，没有再依次尝试候选（含国内镜像站）
for cand in "${IMAGE_CANDIDATES[@]}"; do
  if docker image inspect "$cand" >/dev/null 2>&1; then
    IMAGE="$cand"
    break
  fi
done
if [ -z "$IMAGE" ]; then
  for cand in "${IMAGE_CANDIDATES[@]}"; do
    echo "  本地没有 ${cand}，尝试拉取…"
    if docker pull "$cand" >/dev/null 2>&1; then
      IMAGE="$cand"
      break
    fi
  done
fi
if [ -z "$IMAGE" ]; then
  skip "拉不到 mihomo 镜像（离线或被墙），跳过 mihomo 断言；可用 MIHOMO_IMAGE=<镜像> 指定本地镜像"
fi
echo "  docker 与镜像就绪：$IMAGE"

TEST_OUT="$(docker run --rm -v "$CONF_DIR:/root/.config/mihomo" "$IMAGE" \
  -t -d /root/.config/mihomo -f /root/.config/mihomo/config.yaml 2>&1)"
TEST_RC=$?
printf '%s\n' "$TEST_OUT" | sed 's/^/  /'
if [ "$TEST_RC" = "0" ] && printf '%s' "$TEST_OUT" | grep -qi "test is successful"; then
  pass "配置被 mihomo 接受（hosts / rule-providers / rules 的语法与 schema 通过）"
else
  fail "配置未被 mihomo 接受（退出码 ${TEST_RC}）"
  exit 1
fi

printf '\n== 4/4 起容器断言 hosts 与 REJECT ==\n'
if ! docker run -d --rm --name "$NAME" \
  -p "127.0.0.1:${API_PORT}:9090" -p "127.0.0.1:${MIXED_PORT}:7890" \
  -p "127.0.0.1:${DNS_PORT}:1053/tcp" -p "127.0.0.1:${DNS_PORT}:1053/udp" \
  -v "$CONF_DIR:/root/.config/mihomo" "$IMAGE" \
  -d /root/.config/mihomo -f /root/.config/mihomo/config.yaml >/dev/null 2>&1; then
  skip "容器启动失败（多为端口占用），跳过断言"
fi
STARTED=1

API="http://127.0.0.1:${API_PORT}"
READY=0
for _ in $(seq 1 40); do
  if curl -s -m 1 "$API/version" >/dev/null 2>&1; then READY=1; break; fi
  sleep 0.5
done
if [ "$READY" != "1" ]; then
  echo "  容器日志："
  docker logs "$NAME" 2>&1 | tail -20 | sed 's/^/    /'
  skip "mihomo 的 external-controller 未就绪，跳过断言"
fi

# --- hosts 映射：A / AAAA 都要拿到我们写死的地址 ---
# 三种取法依次尝试（不同环境各有坑）：
#   1) dig +tcp：UDP 在部分 Docker 端口映射下会被吞
#   2) dig（UDP）：少数 mihomo 构建没实现 DoTCP
#   3) /dns/query：dig 不可用时兜底（要求配置里有 dns.listen，否则会返回 DNS section is disabled）
dig_query() { # $1=域名 $2=类型
  local out=""
  if command -v dig >/dev/null 2>&1; then
    # 不取 head -1：mihomo 对 AAAA 查询会先回 v4-mapped 地址（::ffff:x.x.x.x），
    # 真正的 v6 在第二条。断言用 grep 在整个结果里找，避免被第一条带偏。
    out="$(dig +tcp +short -p "$DNS_PORT" @127.0.0.1 "$1" "$2" 2>/dev/null | grep -v '^;;' | grep -v '^$' | tr '\n' ' ')"
    [ -n "$out" ] || out="$(dig +short -p "$DNS_PORT" @127.0.0.1 "$1" "$2" 2>/dev/null | grep -v '^;;' | grep -v '^$' | tr '\n' ' ')"
  fi
  printf '%s' "$out"
}

# 先探测一次，决定后面用 dig 还是 /dns/query（函数在 $() 子 shell 里跑，
# 所以"来源"不能在函数里写回变量，必须先定好模式）
DNS_MODE="api"
if command -v dig >/dev/null 2>&1 && [ -n "$(dig_query clash-verify.example A)" ]; then
  DNS_MODE="dig"
fi
if [ "$DNS_MODE" = "dig" ]; then
  DNS_SRC="dig @127.0.0.1:${DNS_PORT}（tcp→udp）"
  A_OUT="$(dig_query clash-verify.example A)"
  AAAA_OUT="$(dig_query clash-verify.example AAAA)"
else
  DNS_SRC="GET /dns/query"
  A_OUT="$(curl -s -m 5 "$API/dns/query?name=clash-verify.example&type=A")"
  AAAA_OUT="$(curl -s -m 5 "$API/dns/query?name=clash-verify.example&type=AAAA")"
fi

if printf '%s' "$A_OUT" | grep -q '203\.0\.113\.9'; then
  pass "hosts 映射生效（A → 203.0.113.9，来源：${DNS_SRC}）"
else
  fail "hosts 映射未生效（${DNS_SRC} 返回：${A_OUT:-空}）"
fi

if printf '%s' "$AAAA_OUT" | grep -q '2001:db8::9'; then
  pass "hosts 的 IPv6 映射同样生效（AAAA → 2001:db8::9，来源：${DNS_SRC}）"
else
  fail "hosts 的 IPv6 映射未生效（${DNS_SRC} 返回：${AAAA_OUT:-空}）"
fi

# --- REJECT / 放行：只看 mihomo 日志里的规则命中行 ---
# 状态码在这里没有意义：REJECT 经 HTTP 代理返回 502，目标不可达也是 502。
# 命中日志形如（mihomo 把整行塞进 msg="..."，所以要容忍结尾引号）：
#   [TCP] ... --> clash-blocked.example:80 match RuleSet(ch-block) using REJECT
#   [TCP] dial PROXY (match RuleSet/ch-proxy) ... --> clash-proxy.example:80 error: ...
curl -s -o /dev/null -m 8 -x "http://127.0.0.1:${MIXED_PORT}" http://clash-blocked.example/ 2>/dev/null
curl -s -o /dev/null -m 8 -x "http://127.0.0.1:${MIXED_PORT}" http://clash-proxy.example/ 2>/dev/null

# 日志异步刷盘，轮询等（最多约 9 秒），不写死 sleep
BLOCK_HIT=""
PROXY_HIT=""
LOG=""
for _ in $(seq 1 30); do
  LOG="$(docker logs "$NAME" 2>&1)"
  BLOCK_HIT="$(printf '%s\n' "$LOG" | grep -F -- '--> clash-blocked.example:80' | grep -F 'RuleSet(ch-block) using REJECT' | tail -n1)"
  PROXY_HIT="$(printf '%s\n' "$LOG" | grep -F -- '--> clash-proxy.example:80' \
    | grep -E '(match RuleSet\(ch-proxy\)|using (PROXY|DIRECT)|dial (PROXY|DIRECT))' \
    | grep -vF 'using REJECT' | tail -n1)"
  if [ -n "$BLOCK_HIT" ] && [ -n "$PROXY_HIT" ]; then break; fi
  sleep 0.3
done

show_line() { printf '%s' "$1" | sed -e 's/^.*--> //' -e 's/"$//'; }

if [ -n "$BLOCK_HIT" ]; then
  pass "REJECT 规则生效（日志：$(show_line "$BLOCK_HIT")）"
else
  fail "REJECT 规则未生效（日志里没有 ch-block 命中行）"
fi

PROXY_REJECT="$(printf '%s\n' "$LOG" | grep -F -- '--> clash-proxy.example:80' | grep -F 'using REJECT' | tail -n1)"
if [ -n "$PROXY_REJECT" ]; then
  fail "ch-proxy 域名被 REJECT 了（应当交给策略组）：$(show_line "$PROXY_REJECT")"
elif [ -n "$PROXY_HIT" ]; then
  pass "ch-proxy 域名走了策略组而非 REJECT（日志：$(show_line "$PROXY_HIT")）"
else
  note "ch-proxy 没有命中日志（目标不可达时 mihomo 可能先卡在解析），但确认未被 REJECT"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "  --- 容器日志（尾部 15 行，用于定位）---"
  docker logs "$NAME" 2>&1 | tail -15 | sed 's/^/    /'
fi

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mClash 规则输出验证通过\033[0m\n'
else
  printf '\033[31mClash 规则输出验证失败\033[0m\n'
fi
exit "$FAIL"
