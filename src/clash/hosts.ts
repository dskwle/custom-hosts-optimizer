/**
 * `/clash/hosts.yaml` 的生成逻辑（纯函数，无 IO）。
 *
 * mihomo 的 `hosts:` 段和系统 hosts 文件语义接近，但结构是 YAML 映射：
 * 域名 → 一个或多个地址（v4 / v6 混排都可以）。相比把地址拼成空格分隔的
 * 多行文本，映射写法能让 mihomo 自己按 A / AAAA 查询分别取用，
 * 双栈环境下比「一个域名一条地址」更稳。
 *
 * 三条必须遵守的规则：
 * 1. 被屏蔽的域名不能出现在 hosts 里。屏蔽（REJECT / 0.0.0.0）优先级必须高于加速，
 *    否则同一个域名既指向优选 IP 又指向黑洞，行为取决于 mihomo 内部实现，不可接受。
 * 2. 同一个域名的多个地址只保留一次去重后的结果，但**不能只留一个** ——
 *    v4/v6 双栈时两族都要留，否则另一族只能走 DNS，优化就失效了。
 * 3. 非法域名/非法地址直接丢弃，不要试图"修一下"。mihomo 遇到坏值会整份配置加载失败，
 *    一个脏数据换整份 hosts 不可用，代价太大。
 */
import { comment, doubleQuoted, listItem } from "./yaml.ts"

/** [地址, 域名]，与 services/hosts.ts 的 HostEntry 顺序一致 */
export type HostTuple = readonly [string, string]

export interface ClashHostEntry {
  domain: string
  ips: string[]
}

export interface ClashHostsStats {
  /** 输入元组数 */
  input: number
  /** 输出域名数 */
  domains: number
  /** 输出地址数（去重后） */
  ips: number
  /** 域名非法被丢弃的元组数 */
  invalidDomain: number
  /** 地址非法被丢弃的元组数 */
  invalidIp: number
  /** 因在屏蔽清单中被剔除的元组数 */
  blocked: number
}

export interface ClashHosts {
  entries: ClashHostEntry[]
  stats: ClashHostsStats
}

/**
 * 域名合法性。
 *
 * 刻意不接受 `*`、`?`、`_`：hosts 段不做通配匹配，写进去只会让 mihomo
 * 加载失败或永远不命中。通配留给 rule-provider（behavior: domain）之外的类型。
 */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export function normalizeHostDomain(raw: string): string | null {
  let s = String(raw ?? "").trim().toLowerCase()
  if (!s) return null
  s = s.replace(/\.$/, "") // 完全限定名的结尾点
  if (s.length > 253) return null
  if (/[*?[\]{}_\s]/.test(s)) return null
  if (!DOMAIN_RE.test(s)) return null
  return s
}

export function isIPv4(ip: string): boolean {
  const parts = String(ip ?? "").split(".")
  if (parts.length !== 4) return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * IPv6 粗校验：不做完整的 RFC 校验（那需要处理 :: 压缩、嵌入 v4 等一堆情况），
 * 只拦掉明显不是地址的字符串——真正的严格校验交给 mihomo，它加载失败时会明确报错。
 */
export function isIPv6(ip: string): boolean {
  const s = String(ip ?? "").trim()
  if (!s.includes(":") || s.length > 45) return false
  // 去掉 zone id（fe80::1%eth0 这类）再判字符集
  const core = s.split("%")[0]
  if (!/^[0-9a-fA-F:.]+$/.test(core)) return false
  return core.split(":").length >= 3
}

export function isIpAddress(value: string): boolean {
  return isIPv4(value) || isIPv6(value)
}

/**
 * 把 [ip, domain] 元组整理成「域名 → 地址列表」。
 *
 * - 域名小写、去尾部点；地址去空格
 * - 地址去重（同一域名多轮探测可能给出重复 IP），保留首次出现的顺序
 * - 域名按字典序排序：输出稳定，便于 diff 与缓存命中
 */
export function buildClashHosts(
  entries: readonly HostTuple[],
  options: { blocked?: Iterable<string> } = {}
): ClashHosts {
  const blocked = new Set<string>()
  for (const d of options.blocked ?? []) {
    const n = normalizeHostDomain(d)
    if (n) blocked.add(n)
  }

  const byDomain = new Map<string, string[]>()
  const stats: ClashHostsStats = {
    input: entries.length,
    domains: 0,
    ips: 0,
    invalidDomain: 0,
    invalidIp: 0,
    blocked: 0,
  }

  for (const entry of entries) {
    const rawIp = String(entry?.[0] ?? "").trim()
    const domain = normalizeHostDomain(String(entry?.[1] ?? ""))
    if (!domain) {
      stats.invalidDomain++
      continue
    }
    if (blocked.has(domain)) {
      stats.blocked++
      continue
    }
    if (!isIpAddress(rawIp)) {
      stats.invalidIp++
      continue
    }

    const ips = byDomain.get(domain)
    if (!ips) {
      byDomain.set(domain, [rawIp])
      continue
    }
    if (!ips.includes(rawIp)) ips.push(rawIp)
  }

  const result: ClashHostEntry[] = [...byDomain.entries()]
    .map(([domain, ips]) => ({ domain, ips }))
    .sort((a, b) => a.domain.localeCompare(b.domain))

  stats.domains = result.length
  stats.ips = result.reduce((n, e) => n + e.ips.length, 0)
  return { entries: result, stats }
}

/**
 * `hosts:` 段。空数据时输出 `hosts: {}`——mihomo 对空映射和空列表都能接受，
 * 但 `hosts:` 后面什么都不写是 `null`，某些版本会报类型错误，所以给显式空映射。
 */
export function formatHostsSection(hosts: ClashHosts, indent = 0): string {
  const pad = " ".repeat(indent)
  if (!hosts.entries.length) return `${pad}hosts: {}`

  const lines: string[] = [`${pad}hosts:`]
  for (const item of hosts.entries) {
    lines.push(`${pad}  ${doubleQuoted(item.domain)}:`)
    for (const ip of item.ips) lines.push(listItem(ip, indent + 4))
  }
  return lines.join("\n")
}

export interface FormatClashHostsOptions {
  /** ISO 时间或毫秒时间戳；不传则不输出更新时间行（保证单测输出稳定） */
  updatedAt?: string | number | null
  /** 片段标题，默认「custom-hosts 优选地址」 */
  title?: string
}

export function formatClashHostsYaml(
  hosts: ClashHosts,
  options: FormatClashHostsOptions = {}
): string {
  const head: string[] = [
    `${options.title ?? "custom-hosts 优选地址"} · mihomo hosts 映射`,
    `域名 ${hosts.stats.domains} 条 / 地址 ${hosts.stats.ips} 条（v4 与 v6 混排，mihomo 按需取用）`,
  ]
  if (hosts.stats.blocked > 0) {
    head.push(`已剔除 ${hosts.stats.blocked} 条屏蔽域名（屏蔽优先级高于加速）`)
  }
  const ts = hostTs(options.updatedAt)
  if (ts) head.push(`数据更新时间：${ts}`)

  return `${comment(head)}\n${formatHostsSection(hosts)}\n`
}

/** 时间戳格式化成北京时间；非法值返回 null，让调用方直接省略该行 */
function hostTs(value?: string | number | null): string | null {
  if (value == null || value === "") return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour12: false })
}
