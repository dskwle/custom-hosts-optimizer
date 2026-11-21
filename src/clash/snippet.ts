/**
 * 可直接粘进 mihomo 配置的片段（snippet.yaml）与完整模板（config.example.yaml）。
 *
 * 为什么要提供「片段」而不是只给三个 payload 端点：用户的 mihomo 配置里
 * 已经有自己的 proxies / proxy-groups / rules，让他们照着文档手抄三段 YAML，
 * 抄错的概率远高于抄对的概率。片段把「必须一致的三处」——
 * hosts、rule-providers、rules——一次给全，用户只需要整段粘贴。
 *
 * 两个刻意的取舍：
 * 1. rule-providers 的 url 默认指向本服务，interval 用 7200 秒（2 小时），
 *    与本项目刷新周期一致。间隔太长会让新加的屏蔽域名迟迟不生效，
 *    太短则每次拉取都打到服务上、还拖慢 mihomo 启动。
 * 2. ch-proxy 那条规则的目标是 PROXY（策略组），不是 DIRECT/REJECT。
 *    SNI 阻断的域名喂给 REJECT 也"能用"（表现为连不上），
 *    但用户就失去了"换节点绕过去"的可能，所以必须交给用户自己的策略组。
 */
import type { ClashHosts } from "./hosts.ts"
import { formatHostsSection } from "./hosts.ts"
import { comment } from "./yaml.ts"

/** provider 名称：前缀 ch- 便于和用户已有 provider 区分 */
export const PROVIDER_BLOCK = "ch-block"
export const PROVIDER_ADS = "ch-ads"
export const PROVIDER_PROXY = "ch-proxy"

/** 两个刷新周期一致：都按 7200 秒 */
export const DEFAULT_INTERVAL = 7200

export interface SnippetOptions {
  /** 本服务的访问地址，如 http://192.168.1.10:8788；末尾斜杠会被去掉 */
  baseUrl: string
  /** 交给 ch-proxy 的策略组名，默认 PROXY */
  proxyGroup?: string
  /** 要嵌入的 hosts 数据；不传则输出空映射 */
  hosts?: ClashHosts
  /** 生成时间，仅进注释；不传则省略该行 */
  generatedAt?: string | number | null
  /** provider 刷新间隔（秒） */
  interval?: number
}

/** 没有 hosts 数据时的占位，保证输出是合法的空映射而不是 null */
const EMPTY_HOSTS: ClashHosts = {
  entries: [],
  stats: { input: 0, domains: 0, ips: 0, invalidDomain: 0, invalidIp: 0, blocked: 0 },
}

function trimBase(baseUrl: string): string {
  return String(baseUrl || "").trim().replace(/\/+$/, "")
}

function providerUrl(base: string, file: string): string {
  return `${trimBase(base)}/clash/${file}`
}

function stamp(value?: string | number | null): string | null {
  if (value == null || value === "") return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour12: false })
}

/** `rule-providers:` 段。每条 provider 都显式写 format: yaml 与 path */
export function formatRuleProvidersSection(
  baseUrl: string,
  interval = DEFAULT_INTERVAL,
  indent = 0
): string {
  const pad = " ".repeat(indent)
  const base = trimBase(baseUrl)
  const one = (name: string, file: string) =>
    [
      `${pad}  ${name}:`,
      `${pad}    type: http`,
      `${pad}    behavior: domain`,
      `${pad}    format: yaml`,
      `${pad}    url: "${providerUrl(base, file)}"`,
      // path 是 mihomo 的本地缓存文件，必须给；放在 ./ruleset 下便于统一清理
      `${pad}    path: ./ruleset/${name}.yaml`,
      `${pad}    interval: ${interval}`,
    ].join("\n")

  return [
    `${pad}rule-providers:`,
    one(PROVIDER_BLOCK, "block.yaml"),
    one(PROVIDER_ADS, "ads.yaml"),
    one(PROVIDER_PROXY, "proxy.yaml"),
  ].join("\n")
}

/** `rules:` 三条。顺序有讲究：屏蔽要排在最后那条 MATCH 之前，且先于任何代理规则 */
export function formatRulesSection(proxyGroup = "PROXY", indent = 0): string {
  const pad = " ".repeat(indent)
  return [
    `${pad}rules:`,
    `${pad}  - RULE-SET,${PROVIDER_BLOCK},REJECT`,
    `${pad}  - RULE-SET,${PROVIDER_ADS},REJECT`,
    `${pad}  - RULE-SET,${PROVIDER_PROXY},${proxyGroup}`,
    // 用户自己的其余规则接在这三行之后；这里给一条兜底提示，粘的时候整段替换即可
    `${pad}  # ↓ 你自己的规则从这里继续（如 GEOIP,CN,DIRECT / MATCH,PROXY）`,
  ].join("\n")
}

export function buildSnippetYaml(options: SnippetOptions): string {
  const base = trimBase(options.baseUrl)
  const group = (options.proxyGroup || "PROXY").trim() || "PROXY"
  const interval = options.interval ?? DEFAULT_INTERVAL
  const hosts = options.hosts ?? EMPTY_HOSTS

  const head = [
    "custom-hosts · mihomo/Clash 合并片段（可直接粘贴）",
    "三步粘贴：",
    "  1) 把下面的 hosts: 整段放到配置顶层（已有 hosts 段则合并键值，不要出现两个 hosts:）",
    "  2) 把 rule-providers: 整段放到配置顶层（与 rules 同级）",
    "  3) 把 rules: 里的三行加到你的 rules 列表里（建议放在最前面）",
    `第 3 步里的 ${group} 必须改成你自己的策略组名；改完检查 group 名与 proxy-groups 里的一致。`,
    `rule-providers 的 url 指向本服务（${base || "未提供地址"}）。`,
    "若 mihomo 跑在容器/另一台机器上，127.0.0.1 会指向它自己，请换成局域网地址或容器可达的地址。",
  ]
  const ts = stamp(options.generatedAt)
  if (ts) head.push(`生成时间：${ts}`)

  const parts = [
    comment(head),
    formatHostsSection(hosts),
    "",
    comment([
      `rule-provider：屏蔽清单（内置 + 手动），命中后 REJECT`,
      `每 ${interval} 秒（${Math.round(interval / 60)} 分钟）拉一次`,
    ]),
    formatRuleProvidersSection(base, interval),
    "",
    comment([
      "三条规则的语义：",
      `  ${PROVIDER_BLOCK} / ${PROVIDER_ADS} → REJECT：直接拒绝，比指向 0.0.0.0 更快失败`,
      `  ${PROVIDER_PROXY} → ${group}：SNI 阻断域名改 hosts 无效，只能走代理`,
    ]),
    formatRulesSection(group),
  ]

  return `${parts.join("\n")}\n`
}

/** 完整模板：snippet 的全部内容 + dns/tun/proxy-groups 等必需骨架 */
export function buildExampleConfigYaml(options: SnippetOptions): string {
  const base = trimBase(options.baseUrl)
  const group = (options.proxyGroup || "PROXY").trim() || "PROXY"
  const interval = options.interval ?? DEFAULT_INTERVAL
  const hosts = options.hosts ?? EMPTY_HOSTS
  const ts = stamp(options.generatedAt)

  const head = [
    "custom-hosts · mihomo 配置模板（示例，按需删改）",
    "这是「从零开始」用的完整骨架；已有配置请用 /clash/snippet.yaml 只取三段。",
    "把 proxies / proxy-groups 换成你自己的节点与策略组后再启动。",
  ]
  if (ts) head.push(`生成时间：${ts}`)

  const body = [
    comment(head),
    "mixed-port: 7890",
    "allow-lan: false",
    "mode: rule",
    "log-level: info",
    "external-controller: 127.0.0.1:9090",
    "",
    comment([
      "DNS 必须开 use-hosts，否则 hosts 段的映射只对「直连 TCP」生效，",
      "域名解析仍走 nameserver，加速等于没配。",
    ]),
    "dns:",
    "  enable: true",
    "  ipv6: true",
    "  use-hosts: true",
    "  enhanced-mode: fake-ip",
    "  fake-ip-range: 198.18.0.1/16",
    "  fake-ip-filter:",
    "    - '+.lan'",
    "    - '+.local'",
    "    - 'localhost.ptlogin2.qq.com'",
    "  nameserver:",
    "    - 223.5.5.5",
    "    - 119.29.29.29",
    "  fallback:",
    "    - 1.1.1.1",
    "    - 8.8.8.8",
    "",
    comment([
      "TUN 模式（可选）：下面整段默认注释掉。开启后接管全部流量，适合路由器/全局代理场景；",
      "Windows 需要 wintun.dll，macOS 需要授予网络权限，Linux 需要 root 与 /dev/net/tun。",
      "tun:",
      "  enable: true",
      "  stack: system",
      "  auto-route: true",
      "  auto-detect-interface: true",
      "  dns-hijack:",
      "    - any:53",
    ]),
    "",
    "proxies: []",
    comment("↑ 换成你自己的节点（ss/vmess/trojan/hysteria2 等）"),
    "",
    "proxy-groups:",
    `  - name: ${group}`,
    "    type: select",
    "    proxies:",
    "      - DIRECT",
    "      # ↑ 在这里加上你的节点名；DIRECT 仅用于先把配置跑起来",
    "",
    formatHostsSection(hosts),
    "",
    formatRuleProvidersSection(base, interval),
    "",
    formatRulesSection(group),
    "  - GEOIP,CN,DIRECT",
    "  - MATCH," + group,
  ]

  return `${body.join("\n")}\n`
}
