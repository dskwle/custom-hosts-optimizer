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

export interface ProbeResult {
  domain: string
  /** 最优 IP */
  bestIp: string | null
  /** 最优 IP 的 TCP 握手延迟（ms） */
  latency: number | null
  /** 全部候选 IP 及其延迟，按延迟升序 */
  candidates: { ip: string; latency: number | null }[]
  /** 系统 DNS 解析出的 IP，用于判断本地是否被污染 */
  systemIps: string[]
  /** 多个 DoH 结果不一致，说明可能存在地域性解析差异 */
  inconsistent: boolean
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

/** 向单家 DoH 查询 A 记录，返回 IPv4 列表 */
async function queryDoh(
  domain: string,
  provider: (typeof DOH_PROVIDERS)[number],
  timeoutMs = 5000
): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(provider.url(domain), {
      headers: provider.headers,
      signal: controller.signal,
    })
    if (!res.ok) return []
    const data = (await res.json()) as { Answer?: DohAnswer[] }
    return (data.Answer || [])
      .filter((a) => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data))
      .map((a) => a.data)
  } catch {
    return []
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
 * 完整探测一个域名：多源解析 -> 候选去重 -> 逐个测速 -> 取最优。
 * 相比 Cloudflare 版「解析出一个 IP 就用」的做法，这里才真正做了优选。
 */
export async function probeDomain(domain: string): Promise<ProbeResult> {
  const result: ProbeResult = {
    domain,
    bestIp: null,
    latency: null,
    candidates: [],
    systemIps: [],
    inconsistent: false,
  }

  const [dohResults, systemIps] = await Promise.all([
    Promise.all(DOH_PROVIDERS.map((p) => queryDoh(domain, p))),
    querySystemDns(domain),
  ])

  result.systemIps = systemIps

  const ipsFromDoh = new Set<string>()
  for (const list of dohResults) {
    for (const ip of list) ipsFromDoh.add(ip)
  }

  // 各 DoH 结果存在差异，说明解析受地域/运营商影响
  const nonEmpty = dohResults.filter((l) => l.length > 0)
  if (nonEmpty.length > 1) {
    const first = [...nonEmpty[0]].sort().join(",")
    result.inconsistent = nonEmpty.some((l) => [...l].sort().join(",") !== first)
  }

  const allCandidates = new Set<string>([...ipsFromDoh, ...systemIps])

  if (allCandidates.size === 0) {
    result.error = "all DNS sources failed"
    return result
  }

  const candidates = [...allCandidates]
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

  return result
}
