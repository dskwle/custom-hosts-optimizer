/**
 * 本地版专用探测能力。
 *
 * 与 Cloudflare 版的根本差异：没有「每请求 50 个 subrequest」限制，
 * 可以放开手脚做完整探测：
 *   - 查询多家 DoH，收集同一域名的全部候选 IP（而不是解析出一个就收手）
 *   - 对每个候选 IP 并发做 TCP 443 握手测速，选最快的一个
 *   - 同时用 node:dns 做系统解析，比对是否被污染
 *
 * 这不是把 Cloudflare 版逻辑搬过来，而是把它因平台限制做不了的检测补全。
 */
import dns from "node:dns/promises"
import net from "node:net"
import tls from "node:tls"
import { getCachedMany, setCached, cacheKey } from "./ipcache.js"
import { measureQuality, type QualityResult } from "./probe-quality.js"

/** 单家 DNS 服务商的查询结果 */
export interface DohProviderResult {
  name: string
  /** 该家解析出的 IPv4 列表 */
  ips: string[]
  /** 该家解析出的 IPv6 列表 */
  ips6?: string[]
  /** 查询耗时（ms），失败时为 null */
  ms: number | null
  /** 失败原因；成功时为 undefined */
  error?: string
  /** IPv6 查询的失败原因（若启用 IPv6） */
  error6?: string
}

/** SNI 阻断判定：区分「IP 不通」与「TCP 通了但 TLS 被切断」 */
export type SniVerdict =
  /** TLS 握手成功，无阻断 */
  | "ok"
  /** TCP 可连接，但 TLS 握手被重置/超时——典型 SNI 阻断特征 */
  | "sni-blocked"
  /** TCP 都连不上，属于 IP 层封锁 */
  | "tcp-blocked"
  /** 未能建立任何连接，且原因不明 */
  | "unknown"

export interface SniCheckResult {
  verdict: SniVerdict
  /** 用真实域名作 SNI 时的握手结果 */
  withSni: { ok: boolean; ms: number | null; error?: string }
  /** 用占位 SNI 时的握手结果，用于区分是 SNI 匹配触发阻断还是目标本身拒绝 */
  withoutSni: { ok: boolean; ms: number | null; error?: string }
  /** 人类可读的结论 */
  explanation: string
}

export interface ProbeResult {
  domain: string
  /** 主地址：有 v4 取 v4，否则取 v6（兼容只认单地址的消费方） */
  bestIp: string | null
  /** IPv4 族里的最优地址；没有可用 v4 时为 null */
  bestIpV4?: string | null
  /** IPv6 族里的最优地址；没有可用 v6 时为 null */
  bestIpV6?: string | null
  /** 最优 IP 的 TCP 握手延迟（ms） */
  latency: number | null
  /** 最优 IP 的 TLS 握手耗时（ms） */
  tlsMs: number | null
  /** 多轮连接质量明细（成功率 / 平均耗时），仅在 qualityRounds>1 且候选>1 时存在 */
  quality?: QualityResult[]
  /** 全部候选 IP 的检测结果：TLS 成功的按多轮成功率优先，其余按 TCP 延迟；tlsOk=false 不可用于 hosts */
  candidates: ProbeCandidate[]
  /** 每家 DoH 分别返回了什么，按配置顺序 */
  providers: DohProviderResult[]
  /** 本机实际使用的 IP（已合并 /etc/hosts，即 dns.lookup 的结果） */
  systemIps: string[]
  /** 本机实际使用的 IPv6 地址 */
  systemIps6?: string[]
  /** 绕过 hosts 的上游 DNS 结果（dns.resolve4），用于对照是否被 hosts 覆盖 */
  upstreamIps: string[]
  /** 绕过 hosts 的上游 IPv6 结果 */
  upstreamIps6?: string[]
  /** 该域名是否被 /etc/hosts 覆盖 */
  hostsOverride: boolean
  /** 去重后的候选 IP 总数（含 IPv4 与 IPv6） */
  uniqueIpCount: number
  /** 其中 IPv4 数量 */
  v4Count?: number
  /** 其中 IPv6 数量 */
  v6Count?: number
  /** 本次从缓存复用的候选数 */
  cacheHits?: number
  /** 各 DNS 源返回的原始条目数之和（含重复），用于说明去重效果 */
  totalResolvedEntries: number
  /** TLS 握手成功的候选数——只有这些才值得写进 hosts */
  tlsOkCount: number
  /** 多个 DoH 结果不一致，说明可能存在地域性解析差异 */
  inconsistent: boolean
  /** 系统 DNS 与 DoH 结果不同，强烈提示本地被污染 */
  systemDiffers: boolean
  /** SNI 阻断检测结果 */
  sni: SniCheckResult | null
  error?: string
}

/** 单个候选 IP 的检测结果 */
export interface ProbeCandidate {
  ip: string
  /** 地址族：用于前端区分展示 */
  family: IpFamily
  /** TCP 握手耗时；null 表示连不上 */
  latency: number | null
  /** TLS 握手是否成功。这是能否用于 hosts 的硬性条件 */
  tlsOk: boolean
  /** TLS 握手耗时；失败时为 null */
  tlsMs: number | null
  /** TLS 失败原因，如 ECONNRESET / 证书错误 */
  tlsError?: string
}

/**
 * DoH 服务商列表。
 *
 * 分两类：
 *   国内（AliDNS / DNSPod）—— 默认启用，实测稳定（33ms / 162ms）
 *   国际（Cloudflare / Google）—— 默认禁用
 *
 * 为什么默认禁用国际源：这台设备长期在国内网络下运行，
 * 1.1.1.1 与 dns.google 完全不可达（连接直接超时）。
 * 保留它们只会让每次探测白等 3 秒，且日志里堆满红色错误，
 * 反而掩盖真正的问题。
 *
 * 但也不删——如果哪天换了网络环境（或临时挂代理），
 * 通过 ENABLE_INTL_DOH=true 环境变量即可启用，
 * 无需改代码。多源交叉验证仍是排查 DNS 污染的有力手段。
 */
/** 是否启用 IPv6（默认开启；可用 ENABLE_IPV6=false 关闭） */
export const IPV6_ENABLED = process.env.ENABLE_IPV6 !== "false"

export type IpFamily = "v4" | "v6"

/** 判断地址族。IPv4 是点分十进制，其余含冒号的视为 IPv6 */
export function ipFamily(ip: string): IpFamily | null {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return "v4"
  // 宽松校验：至少两个冒号且只含十六进制字符与冒号（含 :: 压缩形式）
  if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":")) return "v6"
  return null
}

/** DNS 记录类型：1=A(IPv4)，28=AAAA(IPv6) */
const DNS_TYPE_A = 1
const DNS_TYPE_AAAA = 28

const DOH_PROVIDERS = [
  {
    name: "AliDNS",
    region: "cn" as const,
    url: (d: string, type: "A" | "AAAA" = "A") =>
      `https://dns.alidns.com/resolve?name=${d}&type=${type}`,
    headers: { accept: "application/dns-json" },
  },
  {
    name: "DNSPod",
    region: "cn" as const,
    url: (d: string, type: "A" | "AAAA" = "A") =>
      `https://doh.pub/dns-query?name=${d}&type=${type}`,
    headers: { accept: "application/dns-json" },
  },
  {
    name: "Cloudflare",
    region: "intl" as const,
    url: (d: string, type: "A" | "AAAA" = "A") =>
      `https://1.1.1.1/dns-query?name=${d}&type=${type}`,
    headers: { accept: "application/dns-json" },
  },
  {
    name: "Google",
    region: "intl" as const,
    url: (d: string, type: "A" | "AAAA" = "A") =>
      `https://dns.google/resolve?name=${d}&type=${type}`,
    headers: { accept: "application/dns-json" },
  },
]

/** 是否启用国际 DoH（默认关闭，可用 ENABLE_INTL_DOH=true 开启） */
export const INTL_DOH_ENABLED = process.env.ENABLE_INTL_DOH === "true"

/** 当前实际参与查询的服务商 */
const ACTIVE_PROVIDERS = DOH_PROVIDERS.filter(
  (p) => p.region === "cn" || INTL_DOH_ENABLED
)

/**
 * DoH 熔断器。
 *
 * 问题：Cloudflare(1.1.1.1) 与 Google(dns.google) 在国内网络基本不可达，
 * 每次查询必然等到超时。142 个域名 × 2 个不可达源 × 5s ≈ 24 分钟纯浪费，
 * 而且会让每个域名的探测时间被这两家拖到 10 秒以上。
 *
 * 策略：连续失败 N 次后进入熔断，一段时间内直接跳过（记 cachedError），
 * 冷却期过后再试探一次。这样既省时间，又能在网络恢复后自动接回来。
 */
interface BreakerState {
  consecutiveFailures: number
  /** 熔断到期时间戳，0 表示未熔断 */
  openUntil: number
  /** 熔断期间对外展示的原因 */
  lastError?: string
}

const DOH_BREAKER = new Map<string, BreakerState>()
const BREAKER_THRESHOLD = 3
const BREAKER_COOLDOWN_MS = 10 * 60 * 1000

function getBreaker(name: string): BreakerState {
  let s = DOH_BREAKER.get(name)
  if (!s) {
    s = { consecutiveFailures: 0, openUntil: 0 }
    DOH_BREAKER.set(name, s)
  }
  return s
}

/** 查询熔断器状态，供接口/前端展示 */
export function getBreakerStatus(): {
  name: string
  region: "cn" | "intl"
  /** 是否参与当前查询 */
  enabled: boolean
  open: boolean
  consecutiveFailures: number
  retryAfterSec: number
  lastError?: string
}[] {
  const now = Date.now()
  return DOH_PROVIDERS.map((p) => {
    const s = getBreaker(p.name)
    const enabled = p.region === "cn" || INTL_DOH_ENABLED
    return {
      name: p.name,
      region: p.region,
      enabled,
      open: s.openUntil > now,
      consecutiveFailures: s.consecutiveFailures,
      retryAfterSec: s.openUntil > now ? Math.ceil((s.openUntil - now) / 1000) : 0,
      lastError: s.lastError,
    }
  })
}

/** 手动重置所有熔断状态 */
export function resetBreakers(): void {
  DOH_BREAKER.clear()
}

interface DohAnswer {
  type: number
  data: string
}

/** 向单家 DoH 查询 A 记录，连同耗时和错误一起返回 */
async function queryDoh(
  domain: string,
  provider: (typeof DOH_PROVIDERS)[number],
  timeoutMs = 3000
): Promise<DohProviderResult> {
  const breaker = getBreaker(provider.name)

  // 熔断中：直接跳过，不发起网络请求。
  // 明确标注原因，避免前端显示成「超时」让人误以为是偶然现象。
  if (breaker.openUntil > Date.now()) {
    const wait = Math.ceil((breaker.openUntil - Date.now()) / 1000)
    return {
      name: provider.name,
      ips: [],
      ms: null,
      error: `已熔断（连续失败 ${breaker.consecutiveFailures} 次，${wait}s 后重试）`,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const t0 = Date.now()

  /** 网络层失败：累计失败次数，达阈值则熔断 */
  const onNetworkFailure = (msg: string): DohProviderResult => {
    breaker.consecutiveFailures += 1
    breaker.lastError = msg

    // 安全阀：若其它 provider 当前全部处于熔断，则本家不熔断。
    // 否则可能因偶发波动把所有源都熔断，导致整个探测无 DNS 可用。
    const othersAllOpen = ACTIVE_PROVIDERS.filter((p) => p.name !== provider.name).every(
      (p) => {
        const s = getBreaker(p.name)
        return s.openUntil > Date.now()
      }
    )

    if (breaker.consecutiveFailures >= BREAKER_THRESHOLD && !othersAllOpen) {
      breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS
      console.warn(
        `[doh] ${provider.name} 熔断 ${BREAKER_COOLDOWN_MS / 60000} 分钟（${msg}）`
      )
    }
    return { name: provider.name, ips: [], ms: null, error: msg }
  }

  try {
    /**
     * 查单个记录类型。返回解析出的地址列表与失败原因。
     * IPv6 查询失败不算 provider 故障（很多域名本就没有 AAAA），
     * 因此不参与熔断计数。
     */
    const queryType = async (
      type: "A" | "AAAA"
    ): Promise<{ ips: string[]; ms: number | null; error?: string }> => {
      const res = await fetch(provider.url(domain, type), {
        headers: provider.headers,
        signal: controller.signal,
      })
      const ms = Date.now() - t0
      if (!res.ok) {
        return { ips: [], ms, error: `HTTP ${res.status}` }
      }
      const data = (await res.json()) as { Answer?: DohAnswer[]; Status?: number }
      const wantType = type === "A" ? DNS_TYPE_A : DNS_TYPE_AAAA
      const ips = (data.Answer || [])
        .filter((a) => a.type === wantType)
        .map((a) => a.data)
        .filter((ip) => ipFamily(ip) !== null)

      if (ips.length === 0) {
        const reason =
          data.Status === 3
            ? "NXDOMAIN（域名不存在）"
            : type === "A"
              ? "无 A 记录"
              : "无 AAAA 记录"
        return { ips: [], ms, error: reason }
      }
      return { ips, ms }
    }

    const [v4, v6] = await Promise.all([
      queryType("A"),
      IPV6_ENABLED ? queryType("AAAA") : Promise.resolve({ ips: [], ms: null, error: "未启用" }),
    ])

    // HTTP 层通了就算这家可达，重置失败计数（即便返回 4xx/5xx）
    breaker.consecutiveFailures = 0
    breaker.openUntil = 0

    const out: DohProviderResult = {
      name: provider.name,
      ips: v4.ips,
      ms: v4.ms,
    }
    if (IPV6_ENABLED) {
      out.ips6 = v6.ips
      if (v6.error) out.error6 = v6.error
    }

    // IPv4 与 IPv6 都无结果才算这家失败
    if (v4.ips.length === 0 && (!out.ips6 || out.ips6.length === 0)) {
      out.error = v4.error || v6.error || "无记录"
    }
    return out
  } catch (err) {
    const msg =
      (err as Error).name === "AbortError"
        ? `超时（>${timeoutMs}ms）`
        : (err as Error).message
    return onNetworkFailure(msg)
  } finally {
    clearTimeout(timer)
  }
}

/** 系统 DNS 解析，用于比对污染情况 */
/**
 * 查询「本机实际会用的地址」。
 *
 * 关键区别（这里踩过坑）：
 *   dns.resolve4()  用 c-ares 直接向 DNS 服务器查询，**不读 /etc/hosts**
 *   dns.lookup()    走系统解析器，**会读 /etc/hosts**
 *
 * 对 hosts 工具而言，必须用 dns.lookup()：
 * 用户改了 hosts 之后，想知道的就是「本机现在会连哪个 IP」。
 * 早期版本误用 resolve4，导致已改 hosts 仍报告「系统 DNS 与被篡改」，
 * 而且显示的是绕过 hosts 的上游结果，与用户预期相反。
 *
 * 同时也返回 upstream（调用 resolve4）作为对照：
 * 若 hosts 已生效，lookup 结果来自 hosts，upstream 才是运营商返回的。
 */
async function querySystemDns(domain: string): Promise<{
  /** 本机实际使用（含 /etc/hosts 覆盖） */
  lookup: string[]
  /** 本机实际使用的 IPv6 地址 */
  lookup6: string[]
  /** 绕过 hosts 的上游 DNS 结果，用于对照 */
  upstream: string[]
  /** 绕过 hosts 的上游 IPv6 结果 */
  upstream6: string[]
  /** 该域名是否被 hosts 覆盖（lookup 与 upstream 不同且 lookup 有值） */
  hostsOverride: boolean
}> {
  const [lookupAll, upstreamV4, upstreamV6] = await Promise.all([
    // 走系统解析器，能读到 /etc/hosts
    (async () => {
      try {
        return await dns.lookup(domain, { all: true })
      } catch {
        return [] as { address: string; family: number }[]
      }
    })(),
    // 绕过 hosts，直接问上游 DNS
    (async () => {
      try {
        return await dns.resolve4(domain)
      } catch {
        return [] as string[]
      }
    })(),
    // 上游 AAAA：很多域名没有 IPv6，失败属正常
    IPV6_ENABLED
      ? (async () => {
          try {
            return await dns.resolve6(domain)
          } catch {
            return [] as string[]
          }
        })()
      : Promise.resolve([] as string[]),
  ])

  const lookupRes = lookupAll.filter((a) => ipFamily(a.address) === "v4").map((a) => a.address)
  const lookup6 = lookupAll.filter((a) => ipFamily(a.address) === "v6").map((a) => a.address)
  const upstreamRes = upstreamV4.filter((ip) => ipFamily(ip) === "v4")
  const upstream6 = upstreamV6.filter((ip) => ipFamily(ip) === "v6")

  // 只比 IPv4：hosts 通常只覆盖 IPv4，且 IPv6 记录常缺失会造成误判
  const lookupSet = new Set(lookupRes)
  const upstreamSet = new Set(upstreamRes)
  const hostsOverride =
    lookupRes.length > 0 &&
    upstreamRes.length > 0 &&
    (lookupRes.some((ip) => !upstreamSet.has(ip)) ||
      upstreamRes.some((ip) => !lookupSet.has(ip)))

  return {
    lookup: lookupRes,
    lookup6,
    upstream: upstreamRes,
    upstream6,
    hostsOverride,
  }
}

/**
 * 带并发上限的 map。
 *
 * 为什么需要：单域名可能有十几个候选 IP，而批量刷新本身还有并发。
 * 两者相乘会产生数百个瞬时 socket，触发本地或运营商的连接数限制，
 * 表现为「刚测还通、批量测就全不可达」的伪失败。
 * 实测 adult 组并发 16 时 2/5 失败，改成并发 2 后 5/5 全通。
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++
        if (i >= items.length) return
        results[i] = await fn(items[i])
      }
    }
  )
  await Promise.all(workers)
  return results
}

/** 单域名内部对候选 IP 的探测并发上限 */
const CANDIDATE_CONCURRENCY = 6

/** TCP 443 握手测速（单次） */
function measureTcpOnce(
  ip: string,
  port = 443,
  timeoutMs = 3000
): Promise<number | null> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = new net.Socket()
    let settled = false

    const done = (value: number | null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }

    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(Date.now() - start))
    socket.once("timeout", () => done(null))
    socket.once("error", () => done(null))
    socket.connect(port, ip)
  })
}

/**
 * TCP 握手测速，失败后重试一次。
 *
 * 单次失败不足以判定「不可达」：实测同一 IP 在并发压力下会瞬时失败，
 * 串行重测又恢复正常。多给一次机会能显著减少伪阴性，
 * 而真正被封的 IP 两次都失败，代价只是多等一个 timeout。
 */
async function measureTcp(
  ip: string,
  port = 443,
  timeoutMs = 3000
): Promise<number | null> {
  const first = await measureTcpOnce(ip, port, timeoutMs)
  if (first !== null) return first
  // 二次探测稍收紧超时，避免整体耗时过长
  return measureTcpOnce(ip, port, Math.min(timeoutMs, 2500))
}

/**
 * 校验该 IP 能否与指定域名完成 TLS 握手。
 *
 * 这是筛选 hosts 候选的硬性条件：TCP 能连上不代表能正常提供服务。
 * 实测见过 TCP 96ms 但 TLS 阶段 ECONNRESET 的 IP——
 * 这种地址写进 hosts 会让该域名彻底不可用，比不加速更糟。
 *
 * servername 必须传真实域名，否则 CDN 会返回错误证书或直接拒绝。
 * rejectUnauthorized 置 false 是因为我们只关心能否完成握手，
 * 证书链有效性由另一套逻辑判断，不该把「自签证书」误判为不可用。
 */
export function checkTlsHandshake(
  domain: string,
  ip: string,
  timeoutMs = 5000
): Promise<{ ok: boolean; ms: number | null; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now()
    let settled = false

    const finish = (ok: boolean, error?: string) => {
      if (settled) return
      settled = true
      resolve({ ok, ms: ok ? Date.now() - start : null, error })
    }

    const socket = tls.connect({
      host: ip,
      port: 443,
      servername: domain,
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
    })

    socket.setTimeout(timeoutMs)

    socket.once("secureConnect", () => {
      socket.destroy()
      finish(true)
    })
    socket.once("timeout", () => {
      socket.destroy()
      finish(false, "TLS 握手超时")
    })
    socket.once("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code
      socket.destroy()
      finish(false, code || (err as Error).message)
    })
  })
}

/**
 * SNI 阻断检测。
 *
 * 判定逻辑：对同一个 IP 做两次 TLS 握手——
 *   1. 用真实域名作 SNI：正常应该成功
 *   2. 用无关域名作 SNI：如果这个能成功、而第一次失败，
 *      说明阻断是「按 SNI 域名匹配」触发的，即典型 SNI 阻断
 *
 * 之所以要做对照组，是因为 TLS 握手失败还有很多别的原因
 * （证书不匹配、服务器要求特定协议版本、限流等），
 * 只看单次失败无法归因。
 *
 * knownTcpMs：调用方若已测过该 IP 的 TCP 延迟，传进来即可跳过重复测量。
 */
export async function checkSniBlock(
  domain: string,
  ip: string,
  timeoutMs = 6000,
  knownTcpMs?: number | null
): Promise<SniCheckResult> {
  /**
   * 对指定 IP 发起 TLS 握手，SNI 用 servername。
   *
   * 注意：这里必须显式传 IP。早期版本让对照域名复用被测目标的 IP，
   * 等于向 mikanani 的服务器发 SNI=example.com 的握手，服务端自然拒绝，
   * 导致对照组永远失败、结论在 sni-blocked 与 unknown 之间摇摆。
   * 对照组必须连「它自己解析出的地址」才有意义。
   */
  const handshake = (servername: string, targetIp: string) =>
    new Promise<{ ok: boolean; ms: number | null; error?: string }>((resolve) => {
      const start = Date.now()
      let settled = false
      const finish = (ok: boolean, error?: string) => {
        if (settled) return
        settled = true
        resolve({ ok, ms: ok ? Date.now() - start : null, error })
      }

      const socket = tls.connect(
        {
          host: targetIp,
          port: 443,
          servername,
          // 不校验证书：这里只关心握手能否完成，证书有效性另行判断
          rejectUnauthorized: false,
          ALPNProtocols: ["http/1.1"],
        },
        () => {
          const ms = Date.now() - start
          socket.destroy()
          if (!settled) {
            settled = true
            resolve({ ok: true, ms })
          }
        }
      )

      socket.setTimeout(timeoutMs)
      socket.once("timeout", () => {
        socket.destroy()
        finish(false, "握手超时")
      })
      socket.once("error", (err) => {
        finish(false, (err as NodeJS.ErrnoException).code || (err as Error).message)
      })
    })

  // 先确认 TCP 是否可达，不可达就没必要做 TLS 判定了。
  // 调用方已测过就直接复用，避免对同一 IP 重复握手。
  const tcpMs =
    knownTcpMs !== undefined ? knownTcpMs : await measureTcp(ip, 443, 4000)
  if (tcpMs === null) {
    return {
      verdict: "tcp-blocked",
      withSni: { ok: false, ms: null, error: "TCP 不可达" },
      withoutSni: { ok: false, ms: null, error: "TCP 不可达" },
      explanation: `无法与 ${ip}:443 建立 TCP 连接，属于 IP 层封锁或该 IP 已失效，与 SNI 无关。`,
    }
  }

  // 真实 SNI 也重试：单次 ECONNRESET 可能是抖动。
  // 并发发两次，任一成功即判定无阻断——串行重试会让最坏耗时翻倍。
  const withSniAttempts = await Promise.all([
    handshake(domain, ip),
    handshake(domain, ip),
  ])
  const withSni = withSniAttempts.find((r) => r.ok) ?? withSniAttempts[0]

  if (withSni.ok) {
    return {
      verdict: "ok",
      withSni,
      withoutSni: { ok: true, ms: null },
      explanation: `使用真实 SNI（${domain}）TLS 握手成功，耗时 ${withSni.ms}ms，不存在 SNI 阻断。`,
    }
  }

  // 真实 SNI 失败，用无关域名做对照。
  //
  // 对照组必须连接「它自己解析出的地址」，不能复用被测目标的 IP，
  // 否则等于向目标服务器索要别的域名的证书，服务端必然拒绝，
  // 会让结论永远落入 unknown。
  const CONTROL_DOMAINS = ["example.com", "cloudflare.com", "wikipedia.org"]

  const controlResults = await Promise.all(
    CONTROL_DOMAINS.map(async (cd) => {
      let controlIp: string | null = null
      try {
        const ips = await dns.resolve4(cd)
        controlIp = ips[0] ?? null
      } catch {
        controlIp = null
      }
      // 解析不出就跳过，不能拿被测 IP 顶替
      if (!controlIp) {
        return { ok: false, ms: null, error: "对照域名解析失败" } as {
          ok: boolean
          ms: number | null
          error?: string
        }
      }
      return handshake(cd, controlIp)
    })
  )

  const control =
    controlResults.find((r) => r.ok) ?? controlResults[controlResults.length - 1]

  if (control.ok) {
    return {
      verdict: "sni-blocked",
      withSni,
      withoutSni: control,
      explanation:
        `TCP 可连接（${tcpMs}ms），但用真实 SNI「${domain}」握手失败（${withSni.error}）；` +
        `改用无关 SNI 则握手成功（${control.ms}ms）。` +
        `说明中间设备是按 SNI 域名匹配切断连接的——这是典型 SNI 阻断，改 hosts 无效，必须走代理。`,
    }
  }

  return {
    verdict: "unknown",
    withSni,
    withoutSni: control,
    explanation:
      `TCP 可连接（${tcpMs}ms），但真实 SNI 握手失败（${withSni.error}），` +
      `且对照 SNI 也无法完成握手（${control.error}）。` +
      `对照失败说明当前网络对外连接不稳定，本次结果不可采信，建议稍后重测；` +
      `若持续如此，可能是该 IP 上的服务异常或限流。`,
  }
}

/**
 * 完整探测一个域名：多源解析 -> 候选去重 -> 逐个测速 -> 取最优。
 * 相比 Cloudflare 版「解析出一个 IP 就用」的做法，这里才真正做了优选。
 */
export async function probeDomain(
  domain: string,
  options: {
    checkSni?: boolean
    useCache?: boolean
    /** 多轮连接质量测量轮数；默认 3，传 1 关闭（延迟诊断页自己做了多轮，避免重复测） */
    qualityRounds?: number
  } = {}
): Promise<ProbeResult> {
  const result: ProbeResult = {
    domain,
    bestIp: null,
    latency: null,
    tlsMs: null,
    candidates: [],
    providers: [],
    systemIps: [],
    upstreamIps: [],
    hostsOverride: false,
    uniqueIpCount: 0,
    totalResolvedEntries: 0,
    tlsOkCount: 0,
    cacheHits: 0,
    inconsistent: false,
    systemDiffers: false,
    sni: null,
  }

  const [dohResults, sysDns] = await Promise.all([
    Promise.all(ACTIVE_PROVIDERS.map((p) => queryDoh(domain, p))),
    querySystemDns(domain),
  ])

  // 保留每家 DoH 的明细，前端可以逐条展示
  result.providers = dohResults
  // systemIps 现在是「本机实际会连的地址」（含 hosts 覆盖）
  result.systemIps = sysDns.lookup
  result.systemIps6 = sysDns.lookup6
  result.upstreamIps = sysDns.upstream
  result.upstreamIps6 = sysDns.upstream6
  result.hostsOverride = sysDns.hostsOverride
  const systemIps = sysDns.lookup

  // 关键：用 Set 做全局去重。
  // 多家 DoH 常常返回完全相同的 IP（尤其大厂域名用 anycast），
  // 若按来源逐个测速，同一个 IP 会被重复测量多次，纯属浪费。
  // 这里把「所有 DoH + 系统 DNS」合并到一个 Set，保证每个 IP 只进候选一次。
  const ipsFromDoh = new Set<string>()
  const ips6FromDoh = new Set<string>()
  let rawCount = 0
  for (const r of dohResults) {
    rawCount += r.ips.length
    for (const ip of r.ips) ipsFromDoh.add(ip)
    for (const ip of r.ips6 || []) ips6FromDoh.add(ip)
    rawCount += (r.ips6 || []).length
  }
  rawCount += systemIps.length

  result.totalResolvedEntries = rawCount

  // 各 DoH 之间的结果差异（只比 IPv4，避免 AAAA 缺失造成噪声）
  const nonEmpty = dohResults.filter((r) => r.ips.length > 0)
  if (nonEmpty.length > 1) {
    const first = [...nonEmpty[0].ips].sort().join(",")
    result.inconsistent = nonEmpty.some(
      (r) => [...r.ips].sort().join(",") !== first
    )
  }

  // 「本机解析结果与 DoH 不一致」有两种含义，必须区分：
  //   A. hosts 已生效且指向正确 IP  -> 这是正常状态，不该报「被篡改」
  //   B. hosts 未生效，或指向错误 IP -> 这才是需要警示的情况
  // 判据：看 upstream（绕过 hosts 的上游结果）是否也与 DoH 不同。
  // 若 upstream 与 DoH 一致、只有 lookup 不同，说明问题已被 hosts 修复。
  if (systemIps.length > 0 && ipsFromDoh.size > 0) {
    const dohSet = ipsFromDoh
    result.systemDiffers = systemIps.some((ip) => !dohSet.has(ip))
  }

  const allCandidates = new Set<string>([
    ...ipsFromDoh,
    ...systemIps,
    ...ips6FromDoh,
    ...sysDns.lookup6,
  ])
  result.uniqueIpCount = allCandidates.size
  result.v4Count = [...allCandidates].filter((ip) => ipFamily(ip) === "v4").length
  result.v6Count = [...allCandidates].filter((ip) => ipFamily(ip) === "v6").length

  if (allCandidates.size === 0) {
    result.error = IPV6_ENABLED
      ? "所有 DNS 源均未返回 A 或 AAAA 记录"
      : "所有 DNS 源均未返回 A 记录"
    return result
  }

  const candidates = [...allCandidates]

  // 先批量取缓存：一次读完，避免逐个 await 造成 IO 开销。
  // key 是 ip|domain，因为 TLS 结果与 SNI 相关，不能跨域名复用。
  const cacheHit = options.useCache === false
    ? new Map()
    : await getCachedMany(candidates.map((ip) => ({ ip, domain })))

  let cachedCount = 0

  /**
   * 一次探测同时拿到 TCP 与 TLS 结果。
   * 缓存命中则完全跳过网络请求——这是提速的主要来源。
   */
  const probed = await mapLimit(candidates, CANDIDATE_CONCURRENCY, async (ip) => {
    const family = (ipFamily(ip) ?? "v4") as IpFamily
    const cached = cacheHit.get(cacheKey(ip, domain))

    if (cached) {
      cachedCount++
      return {
        ip,
        family,
        latency: cached.latency,
        tlsOk: cached.tlsOk,
        tlsMs: cached.tlsMs,
        tlsError: cached.tlsError,
      } as ProbeCandidate
    }

    // TCP 不通就没必要做 TLS
    const latency = await measureTcp(ip)
    if (latency === null) {
      const item: ProbeCandidate = {
        ip,
        family,
        latency: null,
        tlsOk: false,
        tlsMs: null,
        tlsError: "TCP 不可达",
      }
      await setCached(ip, domain, {
        latency: null,
        tlsOk: false,
        tlsMs: null,
        tlsError: "TCP 不可达",
      })
      return item
    }

    const t = await checkTlsHandshake(domain, ip)
    const item: ProbeCandidate = {
      ip,
      family,
      latency,
      tlsOk: t.ok,
      tlsMs: t.ok ? t.ms : null,
      tlsError: t.error,
    }
    await setCached(ip, domain, {
      latency,
      tlsOk: t.ok,
      tlsMs: t.ok ? t.ms : null,
      tlsError: t.error,
    })
    return item
  })

  result.cacheHits = cachedCount

  // TCP 不通的也保留在列表里，让用户看到「解析出了这些 IP 但都用不了」；
  // 但它们 tlsOk=false，不会被选为 bestIp，也不会写进 hosts。
  const measured: ProbeCandidate[] = [...probed]

  // 多轮质量测量：TLS 成功过的候选再各跑几轮完整 HTTPS 计时。
  // 只有一次握手成功不代表稳定——33% 成功率的 IP 即使更快也不该写进 hosts。
  // 延迟诊断页 (/local/compare) 自己已经做了多轮，传 qualityRounds:1 关掉这里避免重复。
  let qualityRank = new Map<string, number>()
  const rounds = options.qualityRounds ?? 3
  if (rounds > 1) {
    const usable = measured.filter((m) => m.tlsOk && m.latency !== null)
    if (usable.length > 1) {
      const quality = await measureQuality(domain, usable, { rounds })
      result.quality = quality
      qualityRank = new Map(quality.map((q, i) => [q.ip, i]))
    }
  }

  // 排序：TLS 成功的排前面。有质量数据时按成功率优先，
  // 否则退化为原来的 TCP 延迟升序。TLS 失败的永远在最后。
  measured.sort((a, b) => {
    if (a.tlsOk !== b.tlsOk) return a.tlsOk ? -1 : 1
    const ra = qualityRank.get(a.ip)
    const rb = qualityRank.get(b.ip)
    if (ra !== undefined || rb !== undefined) return (ra ?? Infinity) - (rb ?? Infinity)
    if (a.latency === null && b.latency === null) return 0
    if (a.latency === null) return 1
    if (b.latency === null) return -1
    return a.latency - b.latency
  })

  result.candidates = measured
  result.tlsOkCount = measured.filter((m) => m.tlsOk).length

  // 只从 TLS 握手成功的候选里挑最优，顺序已经按多轮成功率优先。
  const usable = measured.filter((m) => m.tlsOk && m.latency !== null)
  // 双栈：v4 / v6 各取本族最优。两族都没有 SNI 阻断时同时写入 hosts，
  // 让客户端按自己的网络能力选路；只有一族可用时就只写那一族。
  const bestV4 = usable.find((m) => m.family === "v4") ?? null
  const bestV6 = usable.find((m) => m.family === "v6") ?? null
  result.bestIpV4 = bestV4?.ip ?? null
  result.bestIpV6 = bestV6?.ip ?? null
  const primary = bestV4 ?? bestV6
  if (primary) {
    result.bestIp = primary.ip
    // 记录完整耗时（TCP+TLS）更能反映真实建立连接的代价
    result.latency = primary.latency
    result.tlsMs = primary.tlsMs
  } else {
    // 没有任何 IP 能握手成功：不设 bestIp，让上层跳过这条记录，
    // 而不是塞一个坏地址进 hosts。
    result.bestIp = null
    result.latency = null
  }

  // SNI 检测：对 TLS 失败的候选才有归因价值；
  // 若已有 TLS 成功的候选，说明不存在 SNI 阻断，做一次确认即可。
  if (options.checkSni) {
    // 优先用 TLS 成功的 IP；否则退回到任一 TCP 可达的 IP 做归因分析。
    // 若所有 IP 连 TCP 都不通，说明是 IP 层封锁，测 SNI 没有意义。
    const probeTarget =
      result.bestIp ?? measured.find((m) => m.latency !== null)?.ip
    if (probeTarget) {
      const known = measured.find((m) => m.ip === probeTarget)?.latency ?? null
      result.sni = await checkSniBlock(domain, probeTarget, 6000, known)
    } else if (measured.length > 0) {
      // 全部 IP 的 TCP 都不可达：直接给出 IP 层封锁的结论，
      // 不必再走 SNI 对照（TCP 都建不起来，无法区分是否按域名切断）。
      result.sni = {
        verdict: "tcp-blocked",
        withSni: { ok: false, ms: null, error: "TCP 不可达" },
        withoutSni: { ok: false, ms: null, error: "TCP 不可达" },
        explanation:
          `解析出 ${measured.length} 个 IP，但全部无法建立 TCP 连接，` +
          `属于 IP 层封锁或地址已失效，与 SNI 无关。改 hosts 无效。`,
      }
    }
  }

  return result
}
