/**
 * 代理连接的聚合逻辑（纯函数，零 IO）。
 *
 * 与网页抓包的根本区别：mihomo 的 /connections 是**当前活跃连接快照**，
 * 连接一断开就从列表里消失。所以要理解成"每分钟采样一次照片"，
 * 而不是"一条一条事件流"——同一个域名会在多张照片里反复出现，
 * 累加时必须去重，否则连接数会被轮询次数放大。
 *
 * 因此用 connection.id 去重：mihomo 给每个连接一个 UUID，
 * 只有没见过的 id 才计入新增。
 */

/** mihomo /connections 里单条连接的必要字段 */
export interface RawConnection {
  id: string
  metadata?: {
    network?: string
    type?: string
    host?: string
    destinationIP?: string
    destinationPort?: string
    sourceIP?: string
    inboundName?: string
    sniffHost?: string
    process?: string
    processPath?: string
  }
  upload?: number
  download?: number
  start?: string
  chains?: string[]
  rule?: string
  rulePayload?: string
}

/** 按域名聚合后的一行 */
export interface HostStat {
  host: string
  /** 累计出现过的独立连接数（按 id 去重） */
  connections: number
  upload: number
  download: number
  /** 走过的链路，去重后保留（DIRECT / 代理组名） */
  chains: string[]
  /** 命中的规则类型，去重 */
  rules: string[]
  /** 连接类型（HTTPS / HTTP / TCP），去重 */
  types: string[]
  firstSeen: string
  lastSeen: string
  /** 来源 IP，去重（便于判断是哪台设备） */
  sources: string[]
}

/**
 * 判断一个 host 是否值得统计。
 *
 * 跳过：空 host（纯 IP 连接）、内网/回环、mihomo 自己的控制端口。
 * 这些对广告识别没有意义，留在列表里只会干扰判断。
 */
export function shouldTrackHost(host: string | undefined | null): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  if (!h) return false
  if (h.length > 253) return false
  // 纯 IP 没有域名语义，判不了广告
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return false
  if (h.includes(':') && /^[0-9a-f:]+$/.test(h)) return false
  if (h === 'localhost' || h.endsWith('.localhost')) return false
  if (h.endsWith('.local') || h.endsWith('.internal')) return false
  // 常见内网后缀
  if (/^(10|127)\./.test(h)) return false
  if (/^192\.168\./.test(h)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
  return true
}

/** 域名归一化：小写、去端口、去尾部点 */
export function normalizeProxyHost(raw: string): string {
  let h = (raw || '').trim().toLowerCase()
  if (!h) return ''
  // host:port
  const colon = h.lastIndexOf(':')
  if (colon > 0 && !h.includes(']')) {
    const maybePort = h.slice(colon + 1)
    if (/^\d+$/.test(maybePort)) h = h.slice(0, colon)
  }
  h = h.replace(/\.$/, '')
  return h
}

/**
 * 聚合器：跨多次轮询累积。
 *
 * 用 Set 记已见过的连接 id —— 这是"不重复计数"的关键。
 * 只保留 id 而不再保留整条连接，内存占用可控（1 万条 id 约几百 KB）。
 */
export class ProxyAggregator {
  private readonly stats = new Map<string, HostStat>()
  private readonly seen = new Set<string>()
  /** 见过的连接总数（含被过滤掉的） */
  private totalSeen = 0

  /** 单次上限：超过就停止累积，防止长期运行把内存吃满 */
  private readonly maxHosts: number

  constructor(maxHosts = 5000) {
    this.maxHosts = maxHosts
  }

  /**
   * 吸收一次快照。返回本次新增的独立连接数。
   *
   * 注意：上传/下载要**覆盖**而不是累加同一连接的字节。
   * mihomo 给的是连接累计值，同一连接在后续快照里数值会变大，
   * 若累加会把流量算重好几倍。
   */
  ingest(connections: readonly RawConnection[]): number {
    let added = 0
    for (const c of connections) {
      if (!c || typeof c.id !== 'string') continue
      const rawHost = c.metadata?.host || c.metadata?.sniffHost || ''
      const host = normalizeProxyHost(rawHost)
      if (!shouldTrackHost(host)) continue

      const up = Math.max(0, Number(c.upload) || 0)
      const down = Math.max(0, Number(c.download) || 0)
      const now = c.start || new Date().toISOString()

      let s = this.stats.get(host)
      if (!s) {
        if (this.stats.size >= this.maxHosts) continue
        s = {
          host,
          connections: 0,
          upload: 0,
          download: 0,
          chains: [],
          rules: [],
          types: [],
          firstSeen: now,
          lastSeen: now,
          sources: [],
        }
        this.stats.set(host, s)
      }

      this.totalSeen += 1

      if (!this.seen.has(c.id)) {
        this.seen.add(c.id)
        s.connections += 1
        added += 1
        // 新连接才累加字节（同一连接后续快照的数值是累计值，不能重复加）
        s.upload += up
        s.download += down
      }

      // 时间戳向前兼容：取更早的 firstSeen、更晚的 lastSeen
      if (now < s.firstSeen) s.firstSeen = now
      if (now > s.lastSeen) s.lastSeen = now

      for (const ch of c.chains || []) {
        if (ch && !s.chains.includes(ch)) s.chains.push(ch)
      }
      const rule = c.rule || ''
      if (rule && !s.rules.includes(rule)) s.rules.push(rule)
      const t = c.metadata?.type || c.metadata?.network || ''
      if (t && !s.types.includes(t)) s.types.push(t)
      const src = c.metadata?.sourceIP || ''
      if (src && !s.sources.includes(src)) s.sources.push(src)
    }
    return added
  }

  /** 按连接数降序返回快照 */
  list(): HostStat[] {
    return [...this.stats.values()]
      .map((s) => ({ ...s, chains: [...s.chains], rules: [...s.rules], types: [...s.types], sources: [...s.sources] }))
      .sort((a, b) => b.connections - a.connections || a.host.localeCompare(b.host))
  }

  /** 取出若干域名（给识别流水线用） */
  hosts(): string[] {
    return [...this.stats.keys()]
  }

  get size(): number {
    return this.stats.size
  }

  get totalConnections(): number {
    return this.totalSeen
  }

  clear(): void {
    this.stats.clear()
    this.seen.clear()
    this.totalSeen = 0
  }
}
