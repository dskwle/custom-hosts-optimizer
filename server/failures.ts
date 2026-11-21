/**
 * 探测失败计数（持久化）。
 *
 * 为什么需要它：早期只要探测失败一次、且判为 SNI 阻断，就直接写进排除清单，
 * 之后每轮刷新都跳过。但失败可能只是网络抖动、目标临时限流、本机连接数压力。
 * 误封的代价是永久的——该域名再也不会被优化。
 *
 * 现在改成：失败只累加计数，连续失败达到阈值（默认 60 次）才真正入清单。
 * 后台每分钟重试一批，也就是说一个域名要连续失败约一小时才会被判死。
 * 任何一次成功都会把计数清零（见 clearFailure）。
 *
 * 计数单独存一个文件，不塞进 blocked-domains.json：
 * 后者是「已判定阻断」的结论，前者是「还没定论」的过程数据，
 * 混在一起会让清单接口的输出含义变模糊。
 */
import { promises as fs } from "node:fs"
import path from "node:path"

const FILE = path.resolve(process.cwd(), "data/probe-failures.json")

/** 连续失败多少次才判定为 SNI 阻断并写入排除清单 */
export const FAILURE_THRESHOLD = 60

export interface FailureEntry {
  domain: string
  /** 连续失败次数，成功一次即清零 */
  consecutive: number
  /** 首次失败时间，用于观察「失败持续了多久」 */
  firstFailedAt: string
  /** 最近一次失败时间 */
  lastFailedAt: string
  /** 最近一次失败原因，便于人工判断 */
  lastError?: string
  /** 最近一次失败时的 SNI 结论，只有 sni-blocked 才可能最终入清单 */
  lastVerdict?: string
}

interface FailureFile {
  entries: FailureEntry[]
  updatedAt: string
}

let cache: Map<string, FailureEntry> | null = null

async function load(): Promise<Map<string, FailureEntry>> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(FILE, "utf8")
    const parsed = JSON.parse(raw) as FailureFile
    cache = new Map((Array.isArray(parsed.entries) ? parsed.entries : []).map((e) => [e.domain, e]))
  } catch (err: any) {
    if (err.code !== "ENOENT") {
      console.error("[failures] 读取失败，按空计数处理", err.message)
    }
    cache = new Map()
  }
  return cache
}

async function save(map: Map<string, FailureEntry>): Promise<void> {
  cache = map
  await fs.mkdir(path.dirname(FILE), { recursive: true })
  const payload: FailureFile = {
    entries: [...map.values()].sort((a, b) => b.consecutive - a.consecutive),
    updatedAt: new Date().toISOString(),
  }
  // 先写临时文件再 rename：进程在写一半时被杀掉也不会留下半截 JSON
  const tmp = `${FILE}.tmp`
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8")
  await fs.rename(tmp, FILE)
}

/**
 * 记录一次失败，返回累加后的连续失败次数。
 *
 * 只有 SNI 类失败才值得累计到「判死」——TCP 不通、DNS 解析失败这类
 * 是环境问题，不该让某个域名背锅。调用方负责只把该累计的传进来。
 */
export async function recordFailure(
  domain: string,
  detail: { error?: string; verdict?: string } = {},
): Promise<number> {
  const map = await load()
  const now = new Date().toISOString()
  const existing = map.get(domain)
  if (existing) {
    existing.consecutive += 1
    existing.lastFailedAt = now
    existing.lastError = detail.error
    existing.lastVerdict = detail.verdict
  } else {
    map.set(domain, {
      domain,
      consecutive: 1,
      firstFailedAt: now,
      lastFailedAt: now,
      lastError: detail.error,
      lastVerdict: detail.verdict,
    })
  }
  await save(map)
  return map.get(domain)!.consecutive
}

/** 探测成功：清掉该域名的失败计数 */
export async function clearFailure(domain: string): Promise<void> {
  const map = await load()
  if (!map.delete(domain)) return
  await save(map)
}

/** 当前所有未判定域名的失败计数，供排障面板/接口使用 */
export async function listFailures(): Promise<FailureEntry[]> {
  return [...(await load()).values()].sort((a, b) => b.consecutive - a.consecutive)
}

/** 达到阈值的域名，调用方据此写入排除清单 */
export async function listExhausted(threshold = FAILURE_THRESHOLD): Promise<FailureEntry[]> {
  return (await listFailures()).filter((e) => e.consecutive >= threshold)
}

/** 清空计数（用户手动重置时用） */
export async function clearAllFailures(): Promise<void> {
  await save(new Map())
}
