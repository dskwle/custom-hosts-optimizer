/**
 * 档位 A：从抓包会话里发现「值得加速」的域名，只出建议、不自动写入。
 *
 * 为什么要从抓包挖：DNS 污染只能对已知域名判，候选来源才是瓶颈。
 * 公共清单（gfwlist / china-list）方向都不对——前者多为 SNI 阻断、
 * 后者本来就直连良好，实测抽 3 个样本全部「本来就能通」。
 * 而抓包记录的是真实访问过的域名，是唯一贴近实际需求的来源。
 *
 * 流程：
 *   1. 把一个会话里的所有 host 去重，剔除已处理的（已加速/已屏蔽/proxy）
 *   2. 逐批探测（复用 probeDomain，含多轮质量测量与 SNI 对照）
 *   3. 按 discover-judge 的规则判定
 *   4. 结果写进 data/discover/{sessionId}.json，供前端展示与「一键采纳」
 *
 * 整个过程不碰 hosts、不碰自定义域名——采纳才写，由前端显式调用已有接口。
 */
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { probeDomain } from './probe.js'
import { judgeCandidate, type CandidateResult } from './discover-judge.js'
import { resolveAndMeasure } from './timing.js'
import { loadSession } from './capture/store.ts'
import { normalizeHost } from './capture/aggregate.ts'
import { ALL_DOMAINS } from '../src/constants.js'
import { getCustomDomains } from '../src/services/hosts.ts'
import { getBlocklist } from '../src/services/blocklist.ts'
import { getBlockedDomains } from './blocked.js'

/** 单个会话最多分析多少个域名，避免大站点把一轮拖成半小时 */
export const MAX_DOMAINS_PER_RUN = 40
/** 探测并发：与刷新保持一致，压太高压低都会失真 */
const PROBE_CONCURRENCY = 5

export interface DiscoverItem {
  domain: string
  verdict: CandidateResult['verdict']
  reason: string
  gainMs: number | null
  /** 建议写入的 IP（recommend 时有值），仅仅是建议，采纳前不生效 */
  suggestedIp: string | null
  /** 探测细节，便于用户核对 */
  detail: {
    systemIps: string[]
    systemBestMs: number | null
    bestIpMs: number | null
    candidateCount: number
    tlsOkCount: number
    inconsistent: boolean
    systemDiffers: boolean
    sniVerdict: string | null
  }
}

export interface DiscoverReport {
  sessionId: string
  sessionUrl: string
  createdAt: string
  /** 会话里总共多少个 host */
  totalHosts: number
  /** 因超过上限没分析的个数 */
  skippedByLimit: number
  /** 已处理的（已加速/已屏蔽/proxy），不重复分析 */
  skippedHandled: number
  items: DiscoverItem[]
  /** 各结论的计数，前端直接展示 */
  counts: Record<string, number>
}

function dir(): string {
  return path.resolve(process.cwd(), 'data/discover')
}

function fileOf(sessionId: string): string | null {
  // 会话 id 由服务端生成（capture-<ts>-<hex>），这里再校验一次防路径穿越
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sessionId)) return null
  return path.resolve(dir(), `${sessionId}.json`)
}

export async function loadReport(sessionId: string): Promise<DiscoverReport | null> {
  const file = fileOf(sessionId)
  if (!file) return null
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as DiscoverReport
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    console.error('[discover] 读取报告失败', sessionId, err)
    return null
  }
}

async function saveReport(report: DiscoverReport): Promise<void> {
  const file = fileOf(report.sessionId)
  if (!file) throw new Error('非法的会话 id')
  await fs.mkdir(dir(), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(report, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

/** 取出会话里出现过的所有 host（已归一化、去重、排除本机地址） */
export function extractHosts(requests: readonly { url?: string; host?: string }[]): string[] {
  const set = new Set<string>()
  for (const r of requests) {
    let host = r.host ? normalizeHost(r.host) : ''
    if (!host && r.url) {
      try {
        host = normalizeHost(new URL(r.url).hostname)
      } catch {
        host = ''
      }
    }
    if (!host) continue
    // 本机/局域网地址没有加速意义
    if (host === 'localhost' || host.endsWith('.localhost')) continue
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) continue
    if (host.includes(':')) continue
    set.add(host)
  }
  return [...set].sort()
}

/**
 * 测「系统当前解析到的地址」到底能不能用、多快。
 *
 * 这是收益判断的基准：只有系统解析不可用或明显更慢，加速才有意义。
 * 用 resolveAndMeasure 而不是 probeDomain，因为它会走系统 DNS（不传 ip），
 * 拿到的就是用户此刻真实的访问体验。
 */
async function measureSystem(domain: string): Promise<{ ips: string[]; bestMs: number | null }> {
  try {
    const r = await resolveAndMeasure(domain)
    const ips = r.ip ? [r.ip] : []
    return { ips, bestMs: r.ok && r.totalMs !== null ? r.totalMs : null }
  } catch {
    return { ips: [], bestMs: null }
  }
}

export interface DiscoverOptions {
  /** 覆盖单轮上限（测试用） */
  maxDomains?: number
  /** 覆盖并发（测试用） */
  concurrency?: number
}

/**
 * 分析一个抓包会话。幂等：同一会话重复分析会覆盖旧报告。
 */
export async function analyzeSession(
  env: any,
  sessionId: string,
  options: DiscoverOptions = {},
): Promise<DiscoverReport | null> {
  const stored = await loadSession(sessionId)
  if (!stored) return null

  const maxDomains = options.maxDomains ?? MAX_DOMAINS_PER_RUN
  const concurrency = Math.max(1, options.concurrency ?? PROBE_CONCURRENCY)

  const allHosts = extractHosts(stored.requests)

  // 已处理的域名不必再分析：结论确定，分析了也不会给建议
  const [customs, blocklist, sniBlocked] = await Promise.all([
    getCustomDomains(env),
    getBlocklist(env),
    getBlockedDomains(),
  ])
  const accelerated = new Set(allHosts.length ? ALL_DOMAINS.map((d) => d.toLowerCase()) : [])
  for (const c of customs) accelerated.add(c.domain.toLowerCase())
  const blocked = new Set(blocklist.map((b) => b.domain.toLowerCase()))

  const pending: string[] = []
  let skippedHandled = 0
  for (const host of allHosts) {
    if (accelerated.has(host) || blocked.has(host)) {
      skippedHandled += 1
      continue
    }
    pending.push(host)
  }

  const budget = pending.slice(0, maxDomains)
  const skippedByLimit = Math.max(0, pending.length - budget.length)

  const items: DiscoverItem[] = []
  let cursor = 0
  const worker = async () => {
    while (cursor < budget.length) {
      const domain = budget[cursor]
      cursor += 1
      try {
        // 两个测量并行：一个看系统当前体验，一个找候选里的最优
        const [sys, probe] = await Promise.all([
          measureSystem(domain),
          probeDomain(domain, { checkSni: true, useCache: false, qualityRounds: 2 }),
        ])
        const best = probe.candidates.find((c) => c.ip === probe.bestIp)
        const judge = judgeCandidate({
          domain,
          systemIps: sys.ips,
          systemBestMs: sys.bestMs,
          bestIpMs: best?.latency ?? null,
          inconsistent: probe.inconsistent,
          systemDiffers: probe.systemDiffers,
          alreadyAccelerated: accelerated.has(domain),
          alreadyBlocked: blocked.has(domain),
          sniBlocked: probe.sni?.verdict === 'sni-blocked',
        })
        items.push({
          domain,
          verdict: judge.verdict,
          reason: judge.reason,
          gainMs: judge.gainMs,
          // 只给建议，不写入；采纳时前端调用 /local/custom-add
          suggestedIp: judge.verdict === 'recommend' ? probe.bestIp : null,
          detail: {
            systemIps: sys.ips,
            systemBestMs: sys.bestMs,
            bestIpMs: best?.latency ?? null,
            candidateCount: probe.uniqueIpCount,
            tlsOkCount: probe.tlsOkCount,
            inconsistent: probe.inconsistent,
            systemDiffers: probe.systemDiffers,
            sniVerdict: probe.sni?.verdict ?? null,
          },
        })
      } catch (err) {
        items.push({
          domain,
          verdict: 'unclear',
          reason: `探测异常：${err instanceof Error ? err.message : String(err)}`,
          gainMs: null,
          suggestedIp: null,
          detail: {
            systemIps: [],
            systemBestMs: null,
            bestIpMs: null,
            candidateCount: 0,
            tlsOkCount: 0,
            inconsistent: false,
            systemDiffers: false,
            sniVerdict: null,
          },
        })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, budget.length) }, worker))

  // 建议优先排前面，其次按收益降序，便于用户直接看重点
  const order: Record<string, number> = {
    recommend: 0,
    unclear: 1,
    noop: 2,
    unusable: 3,
    handled: 4,
  }
  items.sort(
    (a, b) =>
      (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9) ||
      (b.gainMs ?? -1) - (a.gainMs ?? -1) ||
      a.domain.localeCompare(b.domain),
  )

  const counts: Record<string, number> = {}
  for (const it of items) counts[it.verdict] = (counts[it.verdict] ?? 0) + 1

  const report: DiscoverReport = {
    sessionId,
    sessionUrl: stored.session.url,
    createdAt: new Date().toISOString(),
    totalHosts: allHosts.length,
    skippedByLimit,
    skippedHandled,
    items,
    counts,
  }
  await saveReport(report)
  return report
}
