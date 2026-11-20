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
  /** 最优 IP */
  bestIp: string | null
  /** 最优 IP 的 TCP 握手延迟（ms） */
  latency: number | null
  /** 全部候选 IP 及其延迟，按延迟升序。同一 IP 无论被几家 DNS 返回，只测一次 */
  candidates: { ip: string; latency: number | null }[]
  /** 每家 DoH 分别返回了什么，按配置顺序 */
  providers: DohProviderResult[]
  /** 系统 DNS 解析出的 IP，用于判断本地是否被污染 */
  systemIps: string[]
  /** 去重后的候选 IP 总数 */
  uniqueIpCount: number
  /** 各 DNS 源返回的原始条目数之和（含重复），用于说明去重效果 */
  totalResolvedEntries: number
  /** 多个 DoH 结果不一致，说明可能存在地域性解析差异 */
  inconsistent: boolean
  /** 系统 DNS 与 DoH 结果不同，强烈提示本地被污染 */
  systemDiffers: boolean
  /** SNI 阻断检测结果 */
  sni: SniCheckResult | null
  error?: string
}

const DOH_PROVIDERS = [
  {
    name: "Cloudflare",
    url: (d: string) => `https://1.1.1.1/dns-query?name=${d}&type=A`,
    headers: { accept: "application/dns-json" },
  },
  {
    name: "Google",
    url: (d: string) => `https://dns.google/resolve?name=${d}&type=A`,
    headers: { accept: "application/dns-json" },
  },
  {
    name: "AliDNS",
    url: (d: string) => `https://dns.alidns.com/resolve?name=${d}&type=A`,
    headers: { accept: "application/dns-json" },
  },
  {
    name: "DNSPod",
    url: (d: string) => `https://doh.pub/dns-query?name=${d}&type=A`,
    headers: { accept: "application/dns-json" },
  },
]

interface DohAnswer {
  type: number
  data: string
}

/** 向单家 DoH 查询 A 记录，连同耗时和错误一起返回 */
async function queryDoh(
  domain: string,
  provider: (typeof DOH_PROVIDERS)[number],
  timeoutMs = 5000
): Promise<DohProviderResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const t0 = Date.now()

  try {
    const res = await fetch(provider.url(domain), {
      headers: provider.headers,
      signal: controller.signal,
    })
    const ms = Date.now() - t0
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
    const ms = Date.now() - t0
    const msg =
      (err as Error).name === "AbortError"
        ? `超时（>${timeoutMs}ms）`
        : (err as Error).message
    return { name: provider.name, ips: [], ms: null, error: msg }
  } finally {
    clearTimeout(timer)
  }
}

/** 系统 DNS 解析，用于比对污染情况 */
async function querySystemDns(domain: string): Promise<string[]> {
  try {
    // 部分环境（如公司路由器）会返回伪造记录，这里只做参考
    const res = await dns.resolve4(domain)
    return res.filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip))
  } catch {
    return []
  }
}

/** TCP 443 握手测速 */
function measureTcp(ip: string, port = 443, timeoutMs = 3000): Promise<number | null> {
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
  const handshake = (servername: string) =>
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
          host: ip,
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

  const withSni = await handshake(domain)
  if (withSni.ok) {
    return {
      verdict: "ok",
      withSni,
      withoutSni: { ok: true, ms: null },
      explanation: `使用真实 SNI（${domain}）TLS 握手成功，耗时 ${withSni.ms}ms，不存在 SNI 阻断。`,
    }
  }

  // 真实 SNI 失败，用无关域名做对照
  const control = await handshake("example.com")

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
      `TCP 可连接（${tcpMs}ms），但两种 SNI 都无法完成握手（真实 SNI：${withSni.error}；` +
      `对照 SNI：${control.error}）。无法归因为 SNI 阻断，可能是该 IP 上的服务异常或限流。`,
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
    candidates: [],
    providers: [],
    systemIps: [],
    uniqueIpCount: 0,
    totalResolvedEntries: 0,
    inconsistent: false,
    systemDiffers: false,
    sni: null,
  }

  const [dohResults, systemIps] = await Promise.all([
    Promise.all(DOH_PROVIDERS.map((p) => queryDoh(domain, p))),
    querySystemDns(domain),
  ])

  // 保留每家 DoH 的明细，前端可以逐条展示
  result.providers = dohResults
  result.systemIps = systemIps

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

  // 系统 DNS 与 DoH 的差异——这是本地被污染最直接的证据
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
  // 去重后的每个 IP 只测一次，结果写入 measured 后复用
  const measured = await Promise.all(
    candidates.map(async (ip) => ({ ip, latency: await measureTcp(ip) }))
  )

  measured.sort((a, b) => {
    if (a.latency === null && b.latency === null) return 0
    if (a.latency === null) return 1
    if (b.latency === null) return -1
    return a.latency - b.latency
  })

  result.candidates = measured
  const fastest = measured.find((m) => m.latency !== null)
  if (fastest) {
    result.bestIp = fastest.ip
    result.latency = fastest.latency
  } else {
    // 全都不通时保留一个 IP，避免 hosts 条目消失
    result.bestIp = candidates[0]
  }

  // SNI 检测开销较大（多次 TLS 握手），仅在显式要求时执行。
  // 把上面已测出的 TCP 延迟传进去，避免对同一个 IP 再握手一次。
  if (options.checkSni && result.bestIp) {
    const known = measured.find((m) => m.ip === result.bestIp)?.latency ?? null
    result.sni = await checkSniBlock(domain, result.bestIp, 6000, known)
  }

  return result
}
