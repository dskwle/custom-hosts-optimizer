/**
 * SNI 阻断域名清单。
 *
 * 为什么要单独维护：这类域名的阻断发生在 TLS 握手的 SNI 阶段，
 * 由中间设备按域名匹配切断连接。改 hosts 完全无效，必须走代理。
 *
 * 但它们每轮刷新仍会被完整探测一遍（DNS + TCP + 多次 TLS 握手），
 * 纯属浪费——一个域名最坏要花十几秒。实测 131 个域名里有 8 个属于此类，
 * 约占 6%，把它们排除后刷新能快不少。
 *
 * 只排除 sni-blocked，不排除 tcp-blocked：
 * 后者是 IP 层封锁，换到别的 IP 可能就好了，仍值得定期重测。
 *
 * 另一条硬规则：**握手指向超时的不入清单**。
 * 超时可能只是网络慢/丢包/本机连接数压力，与域名匹配无关；
 * 一旦误封，该域名后续每轮刷新都会被跳过，永久失去优化机会。
 * 判定逻辑见 server/sni-judge.ts，两边保持一致。
 */
import { promises as fs } from "node:fs"
import path from "node:path"

const FILE = path.resolve(process.cwd(), "data/blocked-domains.json")

export interface BlockedEntry {
  domain: string
  /** 判定为 SNI 阻断的时间 */
  blockedAt: string
  /** 判定依据的说明，便于人工复核 */
  reason: string
  /** 命中时的证据：真实 SNI 失败原因、对照 SNI 耗时 */
  withSniError?: string
  withoutSniMs?: number | null
  /** 累计被判定次数，长期稳定命中说明是持续的阻断 */
  hitCount: number
}

interface BlockedFile {
  entries: BlockedEntry[]
  updatedAt: string
}

let cache: BlockedEntry[] | null = null

async function load(): Promise<BlockedEntry[]> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(FILE, "utf8")
    const parsed = JSON.parse(raw) as BlockedFile
    cache = Array.isArray(parsed.entries) ? parsed.entries : []
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error("[blocked] 读取失败，按空清单处理", err.message)
    }
    cache = []
  }
  return cache
}

async function save(entries: BlockedEntry[]): Promise<void> {
  cache = entries
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  const payload: BlockedFile = {
    entries,
    updatedAt: new Date().toISOString(),
  }
  await fs.writeFile(FILE, JSON.stringify(payload, null, 2), "utf8")
}

/** 当前生效的排除域名集合 */
export async function getBlockedDomains(): Promise<Set<string>> {
  const entries = await load()
  return new Set(entries.map((e) => e.domain))
}

/** 完整清单，供前端展示 */
export async function listBlocked(): Promise<BlockedEntry[]> {
  return [...(await load())].sort((a, b) => b.blockedAt.localeCompare(a.blockedAt))
}

/**
 * 记录一次 SNI 阻断判定。已存在则累加计数并更新证据，
 * 不重复添加，避免清单无限增长。
 */
export async function markBlocked(
  domain: string,
  detail: {
    reason: string
    withSniError?: string
    withoutSniMs?: number | null
  }
): Promise<void> {
  const entries = await load()
  const existing = entries.find((e) => e.domain === domain)

  if (existing) {
    existing.hitCount += 1
    existing.reason = detail.reason
    existing.withSniError = detail.withSniError
    existing.withoutSniMs = detail.withoutSniMs ?? null
    existing.blockedAt = new Date().toISOString()
  } else {
    entries.push({
      domain,
      blockedAt: new Date().toISOString(),
      reason: detail.reason,
      withSniError: detail.withSniError,
      withoutSniMs: detail.withoutSniMs ?? null,
      hitCount: 1,
    })
  }

  await save(entries)
}

/** 从清单移除（复核后确认已恢复，或用户手动解除） */
export async function unmarkBlocked(domain: string): Promise<boolean> {
  const entries = await load()
  const next = entries.filter((e) => e.domain !== domain)
  if (next.length === entries.length) return false
  await save(next)
  return true
}

export async function clearBlocked(): Promise<number> {
  const entries = await load()
  await save([])
  return entries.length
}

/** 过滤掉被排除的域名，保持原有顺序 */
export async function filterBlocked(domains: string[]): Promise<{
  allowed: string[]
  skipped: string[]
}> {
  const blocked = await getBlockedDomains()
  const allowed: string[] = []
  const skipped: string[] = []
  for (const d of domains) {
    if (blocked.has(d)) skipped.push(d)
    else allowed.push(d)
  }
  return { allowed, skipped }
}
