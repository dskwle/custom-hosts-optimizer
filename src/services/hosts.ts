import { connect } from "cloudflare:sockets"
import { ALL_DOMAINS, DNS_PROVIDERS, HOSTS_TEMPLATE, SITE_GROUPS } from "../constants"
import { Bindings } from "../types"
import type { BlockEntry } from "./blocklist"

import {
  filterByFamily,
  formatV6OnlySection,
  completeAddrFamilies,
  parseAddrInput,
  isUsableTarget,
} from "./dualstack.ts"
import { pickLatest } from "./timestamp.ts"

export type HostEntry = [string, string]

// 解析结果：IP + 域名 + TCP 握手延迟（ms）。latency 为 null 表示连不通，仅保留解析结果兜底。
export interface ResolvedHost {
  ip: string
  domain: string
  latency: number | null
}

interface DomainData {
  ip: string
  /** IPv6 优选地址；与 ip 同域名的第二族地址。少数环境只支持 v4，输出时按需过滤 */
  ipv6?: string
  /**
   * v4 可用但 v6 解析出的地址全都不通。
   * 为 true 时输出 `::  域名` 到屏蔽区，阻止客户端回落到坏 v6 地址。
   */
  v6Broken?: boolean
  lastUpdated: string
  lastChecked: string
  responseTime?: number
  provider?: string
  isOptimized?: boolean
  resolvedAt?: string
}

interface DomainDataList {
  [key: string]: DomainData
}

interface KVData {
  domain_data: DomainDataList
  lastUpdated: string
  updateCount?: number
  version?: string
}

interface DnsQuestion {
  name: string
  type: number
}

interface DnsAnswer {
  name: string
  type: number
  TTL: number
  data: string
}

interface DnsResponse {
  Status: number
  TC: boolean
  RD: boolean
  RA: boolean
  AD: boolean
  CD: boolean
  Question: DnsQuestion[]
  Answer: DnsAnswer[]
}

// 重试机制 - DoH 正常响应在 200ms 内，重试只用于应对偶发抖动。
// 原 2 次重试配合 8s 超时，最坏单域名耗时 24s，是 cron 跑不完的主因。
async function retry<T>(
  fn: () => Promise<T>,
  retries: number = 1,
  delay: number = 300
): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (retries === 0) throw error
    await new Promise((resolve) => setTimeout(resolve, delay))
    return retry(fn, retries - 1, delay * 1.5)
  }
}

// DNS查询超时控制：DoH 通常 <500ms，5s 已足够宽松
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => 
      setTimeout(() => reject(new Error('DNS query timeout')), timeoutMs)
    )
  ])
}

// 使用 DNS API 获取 IP，基于 TinsFox 项目的实现
export async function fetchIPFromDNS(
  domain: string,
  providerName?: string
): Promise<string | null> {
  const provider =
    DNS_PROVIDERS.find((p) => p.name === providerName) || DNS_PROVIDERS[0]

  try {
    const response = await withTimeout(
      retry(() =>
        fetch(provider.url(domain), { 
          headers: provider.headers,
          signal: AbortSignal.timeout(4000)
        })
      )
    )

    if (!response.ok) return null

    const data = (await response.json()) as DnsResponse

    // 查找类型为 1 (A记录) 的答案
    const aRecord = data.Answer?.find((answer) => answer.type === 1)
    const ip = aRecord?.data

    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      return ip
    }
  } catch (error) {
    console.error(`Error with DNS provider ${provider.name}:`, error)
  }

  return null
}

// 多DNS提供商重试机制
export async function fetchIPFromMultipleDNS(domain: string): Promise<string | null> {
  for (const provider of DNS_PROVIDERS) {
    try {
      const ip = await fetchIPFromDNS(domain, provider.name)
      if (ip) {
        console.log(`Successfully resolved ${domain} via ${provider.name}: ${ip}`)
        return ip
      }
      console.log(`Failed to resolve ${domain} via ${provider.name}`)
    } catch (error) {
      console.error(`Error resolving ${domain} via ${provider.name}:`, error)
    }
  }
  
  console.error(`Failed to resolve ${domain} from all DNS providers`)
  return null
}

// TCP 握手延迟探测：对目标 IP 的 443 端口发起连接，测量握手耗时。
// 注意：1 次 TCP 连接算 1 个 subrequest，调用方需控制并发总量（免费版每请求 50 个）。
export async function measureLatency(
  ip: string,
  port: number = 443,
  timeoutMs: number = 1800
): Promise<number | null> {
  const start = Date.now()
  let socket: any = null
  try {
    socket = connect({ hostname: ip, port })
    await Promise.race([
      socket.opened,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("tcp timeout")), timeoutMs)
      ),
    ])
    return Date.now() - start
  } catch {
    return null
  } finally {
    try {
      socket?.close()
    } catch {
      /* 已关闭，忽略 */
    }
  }
}

// 解析单个域名并选出延迟最低的 IP。
// 只查前两家 DoH（第三家爬网页太慢），每家可能给出不同 IP，全部参与测速。
// subrequest 成本：≤2 次 DNS + ≤2 次 TCP。
export async function resolveBestIP(domain: string): Promise<ResolvedHost | null> {
  const ips = new Set<string>()

  for (const provider of DNS_PROVIDERS.slice(0, 2)) {
    const ip = await fetchIPFromDNS(domain, provider.name)
    if (ip) ips.add(ip)
  }

  const candidates = [...ips]
  if (candidates.length === 0) return null

  if (candidates.length === 1) {
    return { ip: candidates[0], domain, latency: await measureLatency(candidates[0]) }
  }

  const probed = await Promise.all(
    candidates.map(async (ip) => ({ ip, latency: await measureLatency(ip) }))
  )
  const alive = probed.filter(
    (p): p is { ip: string; latency: number } => p.latency !== null
  )

  if (alive.length === 0) {
    // 全部连不通时保留解析结果，避免整条记录消失
    return { ip: candidates[0], domain, latency: null }
  }

  alive.sort((a, b) => a.latency - b.latency)
  return { ip: alive[0].ip, domain, latency: alive[0].latency }
}

// 批量获取最新 hosts 数据
export async function fetchLatestHostsData(
  domains: string[] = ALL_DOMAINS
): Promise<ResolvedHost[]> {
  const results: ResolvedHost[] = []
  // 每个域名最多 4 个 subrequest（2 DNS + 2 TCP），批次 4 → 单批约 16 个，留足余量
  const batchSize = 4

  console.log(`Starting fetch for ${domains.length} domains (batch ${batchSize})`)

  for (let i = 0; i < domains.length; i += batchSize) {
    const batch = domains.slice(i, i + batchSize)
    const settled = await Promise.all(batch.map((domain) => resolveBestIP(domain)))

    for (const item of settled) {
      if (item) {
        results.push(item)
        console.log(`Domain: ${item.domain}, IP: ${item.ip}, latency: ${item.latency ?? "n/a"}ms`)
      }
    }

    if (i + batchSize < domains.length) {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }

  console.log(`Total resolved: ${results.length}/${domains.length}`)
  return results
}

// 存储数据
export async function storeData(
  env: Bindings,
  data: ResolvedHost[]
): Promise<void> {
  await updateHostsData(env, data)
}

// 获取 hosts 数据 - 优化缓存策略，参考 TinsFox/github-hosts 最佳实践
export async function getHostsData(env: Bindings, forceRefresh: boolean = false): Promise<HostEntry[]> {
  try {
    const kvData = (await env.custom_hosts.get("domain_data", {
      type: "json",
    })) as KVData | null

    // 检查缓存是否有效（6小时内的数据认为有效，而不是1小时）
    // 缓存有效期略大于 cron 周期（2 小时），留 1 小时容错，
    // 这样即使某次 cron 失败，已有数据仍可继续服务，不会立刻回源全量抓取。
    const cacheValidTime = 3 * 60 * 60 * 1000 // 3小时
    const isDataValid = kvData?.lastUpdated && 
      (new Date(kvData.lastUpdated).getTime() + cacheValidTime > Date.now()) &&
      Object.keys(kvData.domain_data || {}).length > 0

    // 只有在强制刷新或数据无效时才获取新数据
    if (forceRefresh || !isDataValid) {
      console.log(`${forceRefresh ? 'Force refresh requested' : 'Cache expired or invalid'}, fetching new data...`)
      const resolved = await fetchLatestHostsData()
      await storeData(env, resolved)
      return resolved.map((r) => [r.ip, r.domain] as HostEntry)
    }

    // 从缓存获取数据
    // 只输出 isOptimized 为 true 的记录：该字段表示该 IP 通过了连通性验证。
    // 历史上有一批只测了 DNS 就写入、TLS 实际握不上手的记录（isOptimized=false），
    // 把它们输出到 hosts 会让对应域名彻底不可用，必须过滤掉。
    const entries: HostEntry[] = []
    const v6BrokenDomains: string[] = []
    // KV 里没有可用地址的域名（脏数据 / 探测彻底失败），跳过并记录
    const skippedUnusable: string[] = []
    for (const domain of ALL_DOMAINS) {
      const domainData = kvData!.domain_data[domain]
      if (domainData && domainData.isOptimized !== false) {
        /**
         * 输出前再挡一道：0.0.0.0 / :: / 回环都不是可用地址。
         *
         * 探测层已经拦过一次（server/probe.ts 的候选池），这里是第二道保险。
         * 因为 KV 里可能残留旧版本写入的脏数据（github.io 就曾被写成
         * ip=0.0.0.0、v6=::），不清掉的话照样会让域名看起来被屏蔽。
         */
        const usableAddrs: string[] = []
        if (domainData.ip && isUsableTarget(domainData.ip)) usableAddrs.push(domainData.ip)
        // v4/v6 任一缺失时，需要给缺的那一族补屏蔽地址吗？
        // 不需要：这里的语义是"优选地址"，缺族就让客户端走 DNS，
        // 是否屏蔽 v6 由 v6Broken 单独决定，别把两件事混在一起。
        if (
          domainData.ipv6 &&
          domainData.ipv6 !== domainData.ip &&
          isUsableTarget(domainData.ipv6)
        ) {
          usableAddrs.push(domainData.ipv6)
        }

        // 一个可用地址都没有：这条记录等于报废，跳过而不是输出屏蔽地址
        if (!usableAddrs.length) {
          skippedUnusable.push(domain)
          continue
        }

        for (const a of usableAddrs) entries.push([a, domain])
        if (domainData.v6Broken) v6BrokenDomains.push(domain)
      }
    }

    const skipped = ALL_DOMAINS.filter((d) => {
      const dd = kvData!.domain_data[d]
      return dd && dd.isOptimized === false
    }).length
    if (skippedUnusable.length) {
      console.warn(
        `[hosts] 跳过 ${skippedUnusable.length} 个无可用地址的域名：` +
          skippedUnusable.slice(0, 8).join(", ") +
          (skippedUnusable.length > 8 ? " …" : ""),
      )
    }
    const cacheAge = Math.round((Date.now() - new Date(kvData!.lastUpdated).getTime()) / 60000)
    console.log(
      `Loaded ${entries.length} entries from cache (age: ${cacheAge} minutes)` +
        (skipped > 0 ? `, skipped ${skipped} unverified` : "")
    )
    return entries
  } catch (error) {
    console.error("Error getting hosts data:", error)
    // 降级处理：如果出错，尝试获取新数据
    try {
      const resolved = await fetchLatestHostsData()
      await storeData(env, resolved)
      return resolved.map((r) => [r.ip, r.domain] as HostEntry)
    } catch (fallbackError) {
      console.error("Fallback also failed:", fallbackError)
      return []
    }
  }
}

// 更新 hosts 数据
export async function updateHostsData(
  env: Bindings,
  newEntries?: ResolvedHost[]
): Promise<void> {
  try {
    const currentTime = new Date().toISOString()
    const kvData = (await env.custom_hosts.get("domain_data", {
      type: "json",
    })) as KVData | null || { 
      domain_data: {} as DomainDataList, 
      lastUpdated: currentTime,
      updateCount: 0,
      version: "1.0.0"
    }

    if (!newEntries) {
      // 只更新检查时间
      for (const domain in kvData.domain_data) {
        kvData.domain_data[domain] = {
          ...kvData.domain_data[domain],
          lastChecked: currentTime,
        }
      }
    } else {
      // 更新域名数据
      for (const { ip, domain, latency } of newEntries) {
        const oldData = kvData.domain_data[domain]
        const hasChanged = !oldData || oldData.ip !== ip

        kvData.domain_data[domain] = {
          ip,
          lastUpdated: hasChanged ? currentTime : oldData?.lastUpdated || currentTime,
          lastChecked: currentTime,
          responseTime: latency ?? undefined,
          provider: 'multiple-dns',
          isOptimized: latency !== null,
          resolvedAt: currentTime
        }
      }
    }

    kvData.lastUpdated = currentTime
    kvData.updateCount = (kvData.updateCount || 0) + 1
    await env.custom_hosts.put("domain_data", JSON.stringify(kvData))
    console.log(`Updated ${Object.keys(kvData.domain_data).length} domains in KV`)
  } catch (error) {
    console.error("Error updating hosts data:", error)
  }
}

// 格式化 hosts 文件
// updatedAt 传入数据的真实更新时间（KV 里的 lastUpdated）。
// 不传则回退到当前时间——但每次请求都会变，无法据此判断数据新旧，
// 因此调用方应尽量传入。

/** 优选区：说明头 + 「地址 域名」列表。blocked 只用于剔除同名条目，不渲染屏蔽段 */
export function formatFastHosts(
  entries: HostEntry[],
  updatedAt?: string | number | null,
  blocked?: BlockEntry[] | null,
  ipv4Only = false,
  pausedAccel?: Iterable<string> | null
): string {
  const blockedSet = new Set((blocked ?? []).map((b) => b.domain.toLowerCase()))
  // 用户手动暂停的内置加速域名：不写进优选区，等于让客户端走正常 DNS
  const pausedSet = new Set<string>()
  for (const d of pausedAccel ?? []) pausedSet.add(String(d).toLowerCase())

  // 屏蔽优先级最高：被屏蔽的域名不能留在优选区，
  // 否则 v4 的优选地址会比 0.0.0.0 先生效，屏蔽形同虚设。
  const v4Filtered = filterByFamily(entries, ipv4Only)
  const visible = v4Filtered.filter(
    ([, domain]) => !blockedSet.has(domain.toLowerCase()) && !pausedSet.has(domain.toLowerCase())
  )

  // 对齐宽度按实际最长地址动态计算。
  // 固定 padEnd(30) 在 IPv4 下够用（最长 15 字符），
  // 但 IPv6 完整形式可达 39 字符，会导致列错位。
  const maxIpLen = visible.reduce((m, [ip]) => Math.max(m, ip.length), 0)
  const pad = Math.max(maxIpLen + 2, 28)

  const content = visible
    .map(([ip, domain]) => `${ip.padEnd(pad)}${domain}`)
    .join("\n")

  // 用数据自身的更新时间，而不是「本次请求的时间」。
  // 后者每次调用都变，会让使用者误以为数据刚刷新过。
  const ts = updatedAt != null ? new Date(updatedAt) : null
  const updateTime =
    ts && !Number.isNaN(ts.getTime())
      ? ts.toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour12: false })
      : "未知（KV 中无时间戳）"

  const groups = SITE_GROUPS.map((g) => g.name).join(" / ")

  // 用 replaceAll：{updateTime} 在模板里出现两次（头部与尾部），
  // String.replace 只换第一处，会让文件末尾一直残留字面量 {updateTime}。
  return HOSTS_TEMPLATE.replaceAll("{groups}", groups)
    .replaceAll("{content}", content)
    .replaceAll("{updateTime}", updateTime)
}

/**
 * 屏蔽区：广告规则 + 自定义屏蔽。
 * 两者都是「域名 → 不可用地址」，因此合并成一段输出，
 * 每条域名固定 v4 + v6 两行，避免双栈机器从另一族绕过去。
 */
export function formatBlockHosts(
  ads?: { content: string; ruleCount: number; fetchedAt?: string } | null,
  blocked?: BlockEntry[] | null,
  v6Broken?: readonly string[] | null,
  pausedShield?: Iterable<string> | null
): string {
  const blockedSet = new Set((blocked ?? []).map((b) => b.domain.toLowerCase()))
  // 暂停屏蔽的内置域名：从屏蔽区剔除，恢复其可达性
  const pausedSet = new Set<string>()
  for (const d of pausedShield ?? []) pausedSet.add(String(d).toLowerCase())
  // 只屏蔽 v6：v4 那条优选记录照常输出，所以不能整域名放进 blocked
  const v6Only = (v6Broken ?? []).filter((d) => !blockedSet.has(d.toLowerCase()))
  const parts: string[] = []

  if (ads?.content) {
    // 与屏蔽清单重叠的域名只保留屏蔽区那一条，避免同一域名出现两次
    const adsLines = ads.content
      .split("\n")
      .filter((line) => {
        const p = line.trim().split(/\s+/)
        return !(p[1] && blockedSet.has(p[1].toLowerCase()))
      })
    parts.push(
      [
        "# ============================================================",
        "# 广告拦截规则（AWAvenue-Ads-Rule）",
        "# 来源：https://github.com/TG-Twilight/AWAvenue-Ads-Rule",
        `# 域名数：${ads.ruleCount}（每条同时写入 IPv4 与 IPv6）${ads.fetchedAt ? `，抓取时间：${new Date(ads.fetchedAt).toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour12: false })}` : ""}`,
        "# ============================================================",
        adsLines.join("\n"),
      ].join("\n")
    )
  }

  const effectiveBlocked = blocked?.filter((b) => !pausedSet.has(b.domain.toLowerCase()))
  if (effectiveBlocked?.length) {
    const blockPad = 10
    const lines: string[] = []
    for (const b of effectiveBlocked) {
      lines.push(`${"0.0.0.0".padEnd(blockPad)}${b.domain}`)
      lines.push(`${"::".padEnd(blockPad)}${b.domain}`)
    }
    parts.push(
      [
        "# ============================================================",
        "# 自定义屏蔽（0.0.0.0 与 :: 各一条，IPv4/IPv6 均不可达）",
        `# 域名数：${effectiveBlocked.length}`,
        "# ============================================================",
        lines.join("\n"),
      ].join("\n")
    )
  }

  const v6Section = formatV6OnlySection(v6Only, { blocked: blockedSet })
  if (v6Section) parts.push(v6Section)

  return parts.length ? parts.join("\n\n") + "\n" : ""
}

/** 完整 hosts：优选区 + 屏蔽区 */
export function formatHostsFile(
  entries: HostEntry[],
  updatedAt?: string | number | null,
  ads?: { content: string; ruleCount: number; fetchedAt?: string } | null,
  blocked?: BlockEntry[] | null,
  ipv4Only = false,
  v6Broken?: readonly string[] | null,
  pausedAccel?: Iterable<string> | null,
  pausedShield?: Iterable<string> | null
): string {
  const fast = formatFastHosts(entries, updatedAt, blocked, ipv4Only, pausedAccel)
  const block = formatBlockHosts(ads, blocked, v6Broken, pausedShield)
  // 空行分隔两个区段，方便使用者只截取上半部分（优选区）
  return block ? `${fast}\n${block}` : fast
}

/**
 * 取出「v4 可用但 v6 全废」的域名清单。
 *
 * 这些域名要在屏蔽区补一条 `::  域名`，否则客户端自己解析 AAAA 时
 * 仍会拿到坏地址、等待超时才回落 v4。读不到就返回空数组：
 * 少一条屏蔽不至于让整份 hosts 不可用。
 */
export async function getV6BrokenDomains(env: Bindings): Promise<string[]> {
  try {
    const kvData = (await env.custom_hosts.get("domain_data", {
      type: "json",
    })) as KVData | null
    if (!kvData?.domain_data) return []
    const out: string[] = []
    for (const domain of ALL_DOMAINS) {
      if (kvData.domain_data[domain]?.v6Broken) out.push(domain)
    }
    return out
  } catch (error) {
    console.error("Error reading v6Broken domains:", error)
    return []
  }
}

/**
 * 自定义域名内容最后变更时间。
 *
 * 为什么不直接改 domain_data.lastUpdated：那个字段身兼两职——
 * 既是"数据更新时间"，也是「缓存是否有效」的判据（getHostsData 里
 * 3 小时窗口）。手动加个域名就把它推到当前时间，会让本该回源的旧数据
 * 被当成新鲜的，反而掩盖问题。
 *
 * 所以单独存一个时间戳，读取时取两者中较新的那个。
 */
const CUSTOM_TOUCHED_KEY = "custom_touched_at"

/** 标记自定义域名内容发生了变化 */
export async function touchCustomChanged(env: Bindings): Promise<void> {
  try {
    await env.custom_hosts.put(CUSTOM_TOUCHED_KEY, new Date().toISOString())
  } catch (error) {
    console.error("Error touching custom changedAt:", error)
  }
}

// 读取 hosts 内容的更新时间，供文件头部标注。
// 取「全量刷新时间」与「自定义域名最后变更时间」中较新的那个：
// 手动加/删域名也算内容变化，头部时间应该跟着走，否则用户会以为没生效。
export async function getDataUpdatedAt(env: Bindings): Promise<string | null> {
  try {
    const [kvData, customTouched] = await Promise.all([
      env.custom_hosts.get("domain_data", { type: "json" }) as Promise<{ lastUpdated?: string } | null>,
      env.custom_hosts.get(CUSTOM_TOUCHED_KEY) as Promise<string | null>,
    ])
    return pickLatest(kvData?.lastUpdated, customTouched)
  } catch {
    return null
  }
}

// 获取单个域名数据
export async function getDomainData(
  env: Bindings,
  domain: string
): Promise<DomainData | null> {
  try {
    const ip = await fetchIPFromMultipleDNS(domain)
    if (!ip) {
      return null
    }

    const currentTime = new Date().toISOString()
    const kvData = (await env.custom_hosts.get("domain_data", {
      type: "json",
    })) as KVData | null || { 
      domain_data: {} as DomainDataList, 
      lastUpdated: currentTime,
      updateCount: 0,
      version: "1.0.0"
    }

    const newData: DomainData = {
      ip,
      lastUpdated: currentTime,
      lastChecked: currentTime,
      responseTime: Date.now() - new Date(currentTime).getTime(),
      provider: 'multiple-dns',
      isOptimized: true,
      resolvedAt: currentTime
    }

    kvData.domain_data[domain] = newData
    kvData.lastUpdated = currentTime
    await env.custom_hosts.put("domain_data", JSON.stringify(kvData))

    return newData
  } catch (error) {
    console.error(`Error getting data for domain ${domain}:`, error)
    return null
  }
}


// 自定义域名相关功能
export interface CustomDomain {
  domain: string
  /**
   * 主地址。保留单值字段是为了向后兼容旧数据与旧调用方。
   * 新的多地址信息看 ips；读到旧数据时两者等价。
   */
  ip: string
  /**
   * 全部地址（v4 / v6 混排，按输入顺序）。
   *
   * 与 ip 的关系：ips[0] 就是 ip。省略 ips 表示"只有 ip 一个地址"。
   * 为什么要多地址：一个域名可能有多个可用 A 记录，也可能要同时指定 v4 与 v6。
   */
  ips?: string[]
  addedAt: string
  resolvedAt?: string
  standardIp?: string
  optimizedIp?: string
  resolveMethod?: string
  isActive?: boolean
  isUpdate?: boolean  // 新增：标识是否为更新操作

  /**
   * 归属分组（站点组 id 列表）。
   *
   * 语义：
   *   - 省略 / 空数组 / 含 "all" → 出现在**所有分组**（默认，向后兼容旧数据）
   *   - 指定 id 列表 → 只出现在这些分组里
   *
   * 为什么自定义域名的优先级最高：用户手填 IP 说明他要的是"就是这个地址"，
   * 任何内置优选结果都不该覆盖它。分组只决定它出现在哪些分类下，
   * 不参与"谁是最终 IP"的竞争。
   */
  groups?: string[]
}

/**
 * 取出某个自定义条目的全部地址（自动兼容只有 ip 的旧数据）。
 *
 * 还会补齐地址族：只给 v4 就补 ::，只给 v6 就补 0.0.0.0。
 * 这是需求要的行为——防止双栈客户端从真实 DNS 拿到另一族的坏地址。
 */
export function customDomainAddrs(cd: CustomDomain): string[] {
  // 有 ips = 用户显式指定过多地址 → 按新规则补齐缺失的地址族。
  // 只有旧的单值 ip = 历史上自动探测写入的结果，**不补族**：
  // 那种记录只存了当时最优的一族（常见是 v6），补族会把另一族屏蔽掉，
  // 而用户从没要求过——等于把原本能用的域名按族切了一半。
  // 实测踩过：72 条旧自定义域名里有一批 ip 是 v6，补族后凭空多出
  // 0.0.0.0 行，v4 用户直接访问不了。
  if (cd.ips?.length) return completeAddrFamilies(cd.ips).addrs
  return cd.ip ? [cd.ip] : []
}

/** 主地址（供只支持单值的旧调用方使用） */
export function customDomainPrimaryIp(cd: CustomDomain): string {
  const raw = cd.ips?.length ? cd.ips : cd.ip ? [cd.ip] : []
  return raw[0] ?? ""
}

/** 分组的特殊值：表示全部分组 */
export const GROUP_ALL = "all"

/**
 * 解析自定义域名的分组归属。
 *
 * @returns 生效的分组 id 集合；null 表示"全部分组"
 */
export function resolveCustomGroups(
  groups: string[] | undefined | null,
  validIds: ReadonlySet<string>,
): Set<string> | null {
  if (!groups || groups.length === 0) return null
  const cleaned = groups
    .map((g) => String(g).trim().toLowerCase())
    .filter(Boolean)
  if (cleaned.length === 0) return null
  // 只要包含 all，就视为全部分组
  if (cleaned.includes(GROUP_ALL)) return null
  const picked = cleaned.filter((g) => validIds.has(g))
  // 全是非法 id 时按全部分组处理：宁可多显示，也不要让条目凭空消失
  return picked.length ? new Set(picked) : null
}

/** 自定义域名是否应归入某个分组（null=全部分组） */
export function customBelongsTo(
  resolved: Set<string> | null,
  groupId: string,
): boolean {
  return resolved === null || resolved.has(groupId)
}

// 添加自定义域名
/**
 * @param ips 可以是单个地址、多个地址的数组，或逗号/空格/换行分隔的字符串。
 *            传空则尝试自动解析。
 */
export async function addCustomDomain(
  env: Bindings,
  domain: string,
  ips?: string | string[],
  groups?: string[]
): Promise<CustomDomain | null> {
  try {
    console.log(`Adding custom domain: ${domain}`)

    // 统一解析成一个地址数组，过滤掉非法值
    const parsed = parseAddrInput(ips).filter(Boolean)

    let addrs: string[] = []
    let standardIp: string | undefined
    let optimizedIp: string | undefined
    let resolveMethod = 'manual'

    if (!parsed.length) {
      // 没有提供地址：自动解析一条
      const resolvedResult = await fetchIPFromMultipleDNS(domain)
      if (!resolvedResult) {
        console.error(`Failed to resolve domain: ${domain}`)
        return null
      }
      addrs = [resolvedResult]
      standardIp = resolvedResult
      optimizedIp = resolvedResult
      resolveMethod = 'dns'
    } else {
      addrs = parsed
      // 顺带取一次系统解析做对照，失败不影响写入
      standardIp = (await fetchIPFromMultipleDNS(domain)) || undefined
      optimizedIp = addrs[0]
      resolveMethod = 'manual'
    }

    // 落盘时补齐地址族：只给 v4 会补 ::，只给 v6 会补 0.0.0.0。
    // 存补齐后的结果而不是只存用户输入，读取端（hosts/clash/json）才能拿到完整语义。
    const completed = completeAddrFamilies(addrs)

    const customDomain: CustomDomain = {
      domain,
      // ip 保留主地址（第一个非屏蔽地址），兼容旧调用方
      ip: completed.addrs.find((a) => a !== "0.0.0.0" && a !== "::") ?? completed.addrs[0],
      ips: completed.addrs,
      addedAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      standardIp,
      optimizedIp,
      resolveMethod,
      isActive: true
    }
    // 只在明确指定时才写 groups，避免给旧客户端凭空塞字段
    if (groups && groups.length) customDomain.groups = groups

    // 获取现有的自定义域名列表
    const existing = await env.custom_hosts.get("custom_domains", { type: "json" }) as CustomDomain[] || []
    
    // 检查是否已存在
    const existingIndex = existing.findIndex(cd => cd.domain === domain)
    let isUpdate = false
    
    if (existingIndex >= 0) {
      // 没传 groups 时保留原有归属，否则"改个 IP"会把分组设置悄悄清掉
      if (!groups || !groups.length) {
        const prev = existing[existingIndex].groups
        if (prev) customDomain.groups = prev
      }
      existing[existingIndex] = customDomain
      isUpdate = true
      console.log(`Updated existing custom domain: ${domain}`)
    } else {
      existing.push(customDomain)
      console.log(`Added new custom domain: ${domain}`)
    }

    await env.custom_hosts.put("custom_domains", JSON.stringify(existing))
    // 自定义域名也是 hosts 内容的一部分，加了就该体现在头部时间上
    await touchCustomChanged(env)

    console.log(
      `Custom domain ${domain} -> [${completed.addrs.join(", ")}] saved successfully` +
        (completed.synthesized.length ? `（自动屏蔽：${completed.synthesized.join(", ")}）` : ""),
    )
    // 返回结果，包含是否为更新操作的信息
    return {
      ...customDomain,
      isUpdate,
      // 告知前端哪些地址是系统补的屏蔽地址
      synthesized: completed.synthesized,
    } as CustomDomain & { synthesized: string[] }
  } catch (error) {
    console.error(`Error adding custom domain ${domain}:`, error)
    return null
  }
}

// 获取自定义域名列表
export async function getCustomDomains(env: Bindings): Promise<CustomDomain[]> {
  try {
    return await migrateCustomDomainsData(env)
  } catch (error) {
    console.error("Error getting custom domains:", error)
    return []
  }
}

// 删除自定义域名
export async function removeCustomDomain(env: Bindings, domain: string): Promise<boolean> {
  try {
    const existing = await env.custom_hosts.get("custom_domains", { type: "json" }) as CustomDomain[] || []
    const filtered = existing.filter(cd => cd.domain !== domain)
    
    if (filtered.length < existing.length) {
      await env.custom_hosts.put("custom_domains", JSON.stringify(filtered))
      await touchCustomChanged(env)
      console.log(`Removed custom domain: ${domain}`)
      return true
    }
    
    console.log(`Custom domain not found: ${domain}`)
    return false
  } catch (error) {
    console.error(`Error removing custom domain ${domain}:`, error)
    return false
  }
}

// 获取包含自定义域名的完整数据
export async function fetchCustomDomainsData(env: Bindings): Promise<HostEntry[]> {
  try {
    const customDomains = await getCustomDomains(env)
    console.log(`Raw custom domains from storage: ${customDomains?.length || 0}`)
    
    // 一个域名可能对应多个地址（多 A 记录 / v4+v6 双栈），
    // 所以这里展开成多条 [地址, 域名]，而不是只取一个。
    const customEntries: HostEntry[] = customDomains
      .filter(cd => cd.isActive !== false)
      .flatMap(cd => {
        const addrs = customDomainAddrs(cd)
        console.log(`Processing custom domain: ${cd.domain} -> [${addrs.join(", ")}]`)
        return addrs.map((a) => [a, cd.domain] as HostEntry)
      })
    
    console.log(`Found ${customEntries.length} active custom domains`)
    return customEntries
  } catch (error) {
    console.error("Error fetching custom domains data:", error)
    return []
  }
}

// 获取包含自定义域名的完整 hosts 数据 - 优化缓存策略
export async function getCompleteHostsData(env: Bindings, forceRefresh: boolean = false): Promise<HostEntry[]> {
  try {
    console.log(`Fetching complete hosts data (GitHub + Custom)${forceRefresh ? ' with force refresh' : ''}`)
    
    // 获取 GitHub 域名数据，传递 forceRefresh 参数
    const githubEntries = await getHostsData(env, forceRefresh)
    console.log(`GitHub entries: ${githubEntries.length}`)
    
    // 获取自定义域名数据（自定义域名通常数量少，可以每次获取）
    const customEntries = await fetchCustomDomainsData(env)
    console.log(`Custom entries: ${customEntries.length}`)
    if (customEntries.length > 0) {
      console.log('Custom domains sample:', customEntries.slice(0, 3).map(([ip, domain]) => `${domain} -> ${ip}`))
    }
    
    // 合并数据，避免重复域名。自定义域名优先覆盖同名 GitHub 域名；
    // 同一域名可有多条（v4 + v6），所以 value 用数组而非单个字符串。
    const domainMap = new Map<string, string[]>()

    const push = (ip: string, domain: string) => {
      const list = domainMap.get(domain) ?? []
      if (!list.includes(ip)) list.push(ip)
      domainMap.set(domain, list)
    }

    // 先加 GitHub 域名
    for (const [ip, domain] of githubEntries) push(ip, domain)

    // 自定义域名覆盖同名的 GitHub 域名。
    // 注意要整组替换（可能多个地址），而不是逐条 set —— 后者会让
    // 同名域名的多条自定义地址互相覆盖，只剩最后一条。
    const customByDomain = new Map<string, string[]>()
    for (const [ip, domain] of customEntries) {
      const list = customByDomain.get(domain) ?? []
      if (!list.includes(ip)) list.push(ip)
      customByDomain.set(domain, list)
    }
    for (const [domain, ips] of customByDomain) {
      domainMap.set(domain, ips)
      console.log(`Added custom domain to map: ${domain} -> [${ips.join(", ")}]`)
    }

    const allEntries: HostEntry[] = [...domainMap.entries()].flatMap(([domain, ips]) =>
      ips.map((ip) => [ip, domain] as HostEntry),
    )
    console.log(`Total entries after deduplication: ${allEntries.length}`)
    
    return allEntries
  } catch (error) {
    console.error("Error getting complete hosts data:", error)
    return await getHostsData(env, forceRefresh) // 降级到只返回 GitHub 数据
  }
}

// 数据迁移：将旧格式转换为新格式
async function migrateCustomDomainsData(env: Bindings): Promise<CustomDomain[]> {
  try {
    // 尝试获取新格式数据
    const newData = await env.custom_hosts.get("custom_domains", { type: "json" }) as CustomDomain[]
    if (newData && Array.isArray(newData) && newData.length > 0) {
      console.log(`Found new format data with ${newData.length} domains`)
      return newData
    }

    // 尝试获取旧格式数据
    const oldData = await env.custom_hosts.get("custom_domains", { type: "json" }) as Record<string, any>
    if (!oldData || typeof oldData !== 'object') {
      console.log("No custom domains data found")
      return []
    }

    // 检查是否是旧格式（对象）
    if (!Array.isArray(oldData)) {
      console.log("Found old format data, migrating...")
      const migratedData: CustomDomain[] = Object.values(oldData).map((item: any) => ({
        domain: item.domain || '',
        ip: item.ip || '',
        addedAt: item.addedAt || new Date().toISOString(),
        resolvedAt: item.addedAt || new Date().toISOString(),
        standardIp: item.ip,
        optimizedIp: item.ip,
        resolveMethod: 'migrated',
        isActive: true
      }))

      // 保存新格式数据
      await env.custom_hosts.put("custom_domains", JSON.stringify(migratedData))
      console.log(`Migrated ${migratedData.length} domains to new format`)
      return migratedData
    }

    return oldData as CustomDomain[]
  } catch (error) {
    console.error("Error migrating custom domains data:", error)
    return []
  }
}
