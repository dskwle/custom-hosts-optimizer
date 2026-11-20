/**
 * IP 延迟缓存。
 *
 * 为什么要按 IP 而不是按域名缓存：同一个 IP 会被多个域名共用
 * （CDN 场景极常见），按域名缓存会重复测量同一个地址。
 * 按 IP 缓存后，一轮刷新里不同域名命中同一 IP 时可直接复用。
 *
 * 缓存内容不只是延迟，还包括 TLS 握手结果——因为「能否握手」
 * 同样是个稳定属性，没必要每次重测。但要注意 TLS 结果可能因
 * SNI 不同而不同，因此缓存 key 用 `ip|domain` 的组合，
 * 避免把 A 域名的握手成功误用到 B 域名上。
 */
import { promises as fs } from "node:fs"
import path from "node:path"

const FILE = path.resolve(process.cwd(), "data/ip-cache.json")

/**
 * 缓存有效期 2 小时。
 *
 * 取 2 小时而非更短，是因为实测同一 IP 在几十秒内就会有 12~30% 波动，
 * 把 TTL 压到几分钟并不能让数据更准，只会增加探测成本。
 * 真正需要立刻失效的场景是「换了网络」，那个由 netcheck 单独处理，
 * 不必靠缩短 TTL 来实现。
 */
export const CACHE_TTL_MS = 2 * 60 * 60 * 1000

export interface CachedEntry {
  /** TCP 握手耗时；null 表示当时不可达 */
  latency: number | null
  /** TLS 是否握手成功 */
  tlsOk: boolean
  /** TLS 握手耗时 */
  tlsMs: number | null
  /** TLS 失败原因 */
  tlsError?: string
  /** 测量时间戳 */
  at: number
}

interface CacheFile {
  /** key 形如 "1.2.3.4|github.com" */
  entries: Record<string, CachedEntry>
  updatedAt: string
}

let cache: Record<string, CachedEntry> | null = null
let dirty = false
let saveTimer: NodeJS.Timeout | null = null

/** 缓存 key：IP + 域名，因为 TLS 结果与 SNI 相关 */
export function cacheKey(ip: string, domain: string): string {
  return `${ip}|${domain}`
}

async function load(): Promise<Record<string, CachedEntry>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(FILE, "utf8")
    const parsed = JSON.parse(raw) as CacheFile
    cache = parsed.entries || {}
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error("[ipcache] 读取失败，按空缓存处理", err.message)
    }
    cache = {}
  }
  return cache
}

/** 合并写入磁盘。用节流避免每次测量都写文件 */
async function scheduleFlush(): Promise<void> {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    if (!dirty || !cache) return
    dirty = false
    try {
      await fs.mkdir(path.dirname(FILE), { recursive: true })
      const payload: CacheFile = {
        entries: cache,
        updatedAt: new Date().toISOString(),
      }
      await fs.writeFile(FILE, JSON.stringify(payload), "utf8")
    } catch (err) {
      console.error("[ipcache] 写入失败", (err as Error).message)
    }
  }, 2000)
  // 不阻塞调用方
  saveTimer.unref?.()
}

/** 批量读取，用于在探测前一次性取出所有可用缓存 */
export async function getCachedMany(
  items: { ip: string; domain: string }[]
): Promise<Map<string, CachedEntry>> {
  const all = await load()
  const now = Date.now()
  const out = new Map<string, CachedEntry>()
  for (const { ip, domain } of items) {
    const k = cacheKey(ip, domain)
    const e = all[k]
    if (e && now - e.at <= CACHE_TTL_MS) out.set(k, e)
  }
  return out
}

/** 写入一条测量结果 */
export async function setCached(
  ip: string,
  domain: string,
  entry: Omit<CachedEntry, "at">
): Promise<void> {
  const all = await load()
  all[cacheKey(ip, domain)] = { ...entry, at: Date.now() }
  await scheduleFlush()
}

/** 清空缓存 */
export async function clearCache(): Promise<number> {
  const all = await load()
  const n = Object.keys(all).length
  cache = {}
  dirty = true
  await scheduleFlush()
  return n
}

/** 统计信息，供接口展示 */
export async function cacheStats(): Promise<{
  total: number
  fresh: number
  stale: number
  ttlMs: number
}> {
  const all = await load()
  const now = Date.now()
  let fresh = 0
  let stale = 0
  for (const e of Object.values(all)) {
    if (now - e.at <= CACHE_TTL_MS) fresh++
    else stale++
  }
  return { total: fresh + stale, fresh, stale, ttlMs: CACHE_TTL_MS }
}
