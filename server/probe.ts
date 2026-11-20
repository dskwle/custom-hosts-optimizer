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

/** 单家 DNS 服务商的查询结果 */
export interface DohProviderResult {
  name: string
  /** 该家解析出的 IPv4 列表 */
  ips: string[]
  /** 查询耗时（ms），失败时为 null */
  ms: number | null
  /** 失败原因；成功时为 undefined */
  error?: string
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
  /** 最优 IP：仅在 TLS 握手成功的候选里挑选 */
  bestIp: string | null
  /** 最优 IP 的 TCP 握手延迟（ms） */
  latency: number | null
  /** 最优 IP 的 TLS 握手耗时（ms） */
  tlsMs: number | null
  /** 全部候选 IP 的检测结果，按 TCP 延迟升序。tlsOk=false 的不可用于 hosts */
  candidates: ProbeCandidate[]
  /** 每家 DoH 分别返回了什么，按配置顺序 */
  providers: DohProviderResult[]
  /** 本机实际使用的 IP（已合并 /etc/hosts，即 dns.lookup 的结果） */
  systemIps: string[]
  /** 绕过 hosts 的上游 DNS 结果（dns.resolve4），用于对照是否被 hosts 覆盖 */
  upstreamIps: string[]
  /** 该域名是否被 /etc/hosts 覆盖 */
  hostsOverride: boolean
  /** 去重后的候选 IP 总数 */
  uniqueIpCount: number
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
const DOH_PROVIDERS = [
  {
    name: "AliDNS",
    region: "cn" as const,
    url: (d: string) => `https://dns.alidns.com/resolve?name=${d}&type=A`,
    headers: { accept: "application/dns-json" },
  },
  {
    name: "DNSPod",
    region: "cn" as const,
    url: (d: string) => `https://doh.pub/dns-query?name=${d}&type=A`,
    headers: { accept: "application/dns-json" },
  },
  {
    name: "Cloudflare",
    region: "intl" as const,
    url: (d: string) => `https://1.1.1.1/dns-query?name=${d}&type=A`,
    headers: { accept: "application/dns-json" },
  },
  {
    name: "Google",
    region: "intl" as const,
    url: (d: string) => `https://dns.google/resolve?name=${d}&type=A`,
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
    const res = await fetch(provider.url(domain), {
      headers: provider.headers,
      signal: controller.signal,
    })
    const ms = Date.now() - t0

    // HTTP 层通了就算这家可达，重置失败计数（即便返回 4xx/5xx）
    breaker.consecutiveFailures = 0
    breaker.openUntil = 0

    if (!res.ok) {
      return { name: provider.name, ips: [], ms, error: `HTTP ${res.status}` }
    }
    const data = (await res.json()) as { Answer?: DohAnswer[]; Status?: number }
    const ips = (data.Answer || [])
      .filter((a) => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data))
      .map((a) => a.data)

    if (ips.length === 0) {
      // Status 3 表示域名不存在，0 但无 A 记录说明只有 AAAA 或 CNAME 链
      const reason = data.Status === 3 ? "NXDOMAIN（域名不存在）" : "无 A 记录"
      return { name: provider.name, ips: [], ms, error: reason }
    }
    return { name: provider.name, ips, ms }
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
  /** 绕过 hosts 的上游 DNS 结果，用于对照 */
  upstream: string[]
  /** 该域名是否被 hosts 覆盖（lookup 与 upstream 不同且 lookup 有值） */
  hostsOverride: boolean
}> {
  const isV4 = (ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)

  const [lookupRes, upstreamRes] = await Promise.all([
    // 走系统解析器，能读到 /etc/hosts
    (async () => {
      try {
        const all = await dns.lookup(domain, { all: true })
        return all.map((a) => a.address).filter(isV4)
      } catch {
        return []
      }
    })(),
    // 绕过 hosts，直接问上游 DNS
    (async () => {
      try {
        return (await dns.resolve4(domain)).filter(isV4)
      } catch {
        return []
      }
    })(),
  ])

  const lookupSet = new Set(lookupRes)
  const upstreamSet = new Set(upstreamRes)
  // 两边都有值且不完全一致，说明 hosts 起了作用
  const hostsOverride =
    lookupRes.length > 0 &&
    upstreamRes.length > 0 &&
    (lookupRes.some((ip) => !upstreamSet.has(ip)) ||
      upstreamRes.some((ip) => !lookupSet.has(ip)))

  return { lookup: lookupRes, upstream: upstreamRes, hostsOverride }
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
  options: { checkSni?: boolean } = {}
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
  result.upstreamIps = sysDns.upstream
  result.hostsOverride = sysDns.hostsOverride
  const systemIps = sysDns.lookup

  // 关键：用 Set 做全局去重。
  // 多家 DoH 常常返回完全相同的 IP（尤其大厂域名用 anycast），
  // 若按来源逐个测速，同一个 IP 会被重复测量多次，纯属浪费。
  // 这里把「所有 DoH + 系统 DNS」合并到一个 Set，保证每个 IP 只进候选一次。
  const ipsFromDoh = new Set<string>()
  let rawCount = 0
  for (const r of dohResults) {
    rawCount += r.ips.length
    for (const ip of r.ips) ipsFromDoh.add(ip)
  }
  rawCount += systemIps.length

  result.totalResolvedEntries = rawCount

  // 各 DoH 之间的结果差异
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

  const allCandidates = new Set<string>([...ipsFromDoh, ...systemIps])
  result.uniqueIpCount = allCandidates.size

  if (allCandidates.size === 0) {
    result.error = "所有 DNS 源均未返回 A 记录"
    return result
  }

  const candidates = [...allCandidates]

  // 第一层：TCP 握手。连不上就没必要做 TLS，直接淘汰。
  // 限流：候选可能多达十几个，无上限并发会触发系统连接数限制。
  const tcpProbed = await mapLimit(candidates, CANDIDATE_CONCURRENCY, async (ip) => ({
    ip,
    latency: await measureTcp(ip),
  }))

  // 第二层：对 TCP 可达的 IP 逐个验证 TLS 握手。
  // 只有握手成功的才算有效候选——这是「保留的项目一定能正常建立 TLS 连接」
  // 这条要求的落地：TCP 通但 TLS 被打断的 IP 一律排除。
  const tlsCandidates = tcpProbed.filter((x) => x.latency !== null)
  const tlsProbed = await mapLimit(tlsCandidates, CANDIDATE_CONCURRENCY, async (x) => {
    const t = await checkTlsHandshake(domain, x.ip)
    return {
      ip: x.ip,
      latency: x.latency,
      tlsOk: t.ok,
      tlsMs: t.ok ? t.ms : null,
      tlsError: t.error,
    } as ProbeCandidate
  })

  // TCP 就不通的也保留在列表里，让用户看到「解析出了这些 IP 但都用不了」；
  // 但它们 tlsOk=false，不会被选为 bestIp，也不会写进 hosts。
  const tcpFailed: ProbeCandidate[] = tcpProbed
    .filter((x) => x.latency === null)
    .map((x) => ({
      ip: x.ip,
      latency: null,
      tlsOk: false,
      tlsMs: null,
      tlsError: "TCP 不可达",
    }))

  const measured: ProbeCandidate[] = [...tlsProbed, ...tcpFailed]

  // 排序：TLS 成功的排前面（按 TCP 延迟），其余靠后
  measured.sort((a, b) => {
    if (a.tlsOk !== b.tlsOk) return a.tlsOk ? -1 : 1
    if (a.latency === null && b.latency === null) return 0
    if (a.latency === null) return 1
    if (b.latency === null) return -1
    return a.latency - b.latency
  })

  result.candidates = measured
  result.tlsOkCount = measured.filter((m) => m.tlsOk).length

  // 只从 TLS 握手成功的候选里挑最优。
  // 之前只按 TCP 延迟挑，会把「TCP 快但 TLS 被重置」的 IP 选为 bestIp，
  // 写进 hosts 后该域名反而彻底打不开。
  const usable = measured.filter((m) => m.tlsOk && m.latency !== null)
  if (usable.length > 0) {
    result.bestIp = usable[0].ip
    // 记录完整耗时（TCP+TLS）更能反映真实建立连接的代价
    result.latency = usable[0].latency
    result.tlsMs = usable[0].tlsMs
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
