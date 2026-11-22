/**
 * 代理观察路由。
 *
 * 与 /local/capture/* 完全独立：那条线是浏览器 CDP 抓包（能拿到 URL 与路径），
 * 这条线是 mihomo 代理连接（只有域名，覆盖 App / 客户端 / 小程序）。
 *
 * 所有接口默认只读或产出建议，写入屏蔽必须显式调用 /block。
 */
import { Hono } from 'hono'
import type { Bindings } from '../../src/types.ts'
import { addBlocked, getBlocklist } from '../../src/services/blocklist.ts'
import { getAdsRules, getAdsEnabled } from '../../src/services/ads.ts'
import { ProxyCollector, createCollectorFromEnv } from '../proxy/collector.ts'
import { AiJudge } from '../proxy/ai-judge.ts'
import {
  judgeHosts,
  mergeVerdicts,
  parseAdRuleDomains,
  type HostAdVerdict,
} from '../proxy/judge-pipeline.ts'

export interface ProxyRouteDeps {
  env: () => Bindings
}

/** 单例：路由注册时创建，进程内共享采集状态 */
let collector: ProxyCollector | null = null
let aiJudge: AiJudge | null = null
/** 最近一次识别结果：域名 → 结论。不落盘，重启即失（结论可随时重算） */
let lastVerdicts = new Map<string, HostAdVerdict>()
let lastJudgeAt: string | null = null

function getCollector(): ProxyCollector {
  if (!collector) collector = createCollectorFromEnv()
  return collector
}

function getAi(): AiJudge {
  if (!aiJudge) {
    aiJudge = new AiJudge({
      baseUrl: process.env.AI_BASE_URL || 'http://192.168.6.195:8080',
      model: process.env.AI_MODEL || 'qwen35-4b',
      batchSize: Number(process.env.AI_BATCH_SIZE || 8) || 8,
      concurrency: Number(process.env.AI_CONCURRENCY || 2) || 2,
    })
  }
  return aiJudge
}

/** 读已启用的广告规则域名集合 */
async function readKnownAds(env: Bindings): Promise<Set<string>> {
  try {
    if (!(await getAdsEnabled(env))) return new Set()
    const meta = await getAdsRules(env)
    return meta?.content ? parseAdRuleDomains(meta.content) : new Set()
  } catch (err) {
    console.error('[proxy] 读取广告规则失败', err)
    return new Set()
  }
}

export function createProxyRoutes(deps: ProxyRouteDeps) {
  const routes = new Hono()

  /** 环境探测：mihomo 与 AI 服务是否可用 */
  routes.get('/env', async (c) => {
    const col = getCollector()
    const [mihomo, ai] = await Promise.all([col.ping(), getAi().ping()])
    return c.json({ mihomo, ai })
  })

  /** 开始采集 */
  routes.post('/start', (c) => {
    const st = getCollector().start()
    return c.json({ ok: true, session: st })
  })

  /** 停止采集（已采到的数据保留） */
  routes.post('/stop', (c) => {
    const st = getCollector().stop()
    return c.json({ ok: true, session: st })
  })

  /** 清空累积数据（运行状态不变） */
  routes.post('/clear', (c) => {
    getCollector().clear()
    lastVerdicts = new Map()
    lastJudgeAt = null
    return c.json({ ok: true })
  })

  /** 采集状态 */
  routes.get('/status', (c) => {
    const col = getCollector()
    return c.json({
      session: col.status(),
      judgeAt: lastJudgeAt,
      judged: lastVerdicts.size,
    })
  })

  /** 聚合后的域名列表（带上次识别结论） */
  routes.get('/hosts', async (c) => {
    const col = getCollector()
    const stats = col.hosts()

    // 已屏蔽的标出来，避免用户重复操作
    let blocked = new Set<string>()
    try {
      blocked = new Set((await getBlocklist(deps.env())).map((b) => b.domain.toLowerCase()))
    } catch {
      // 清单读不到不影响展示
    }

    const merged = mergeVerdicts(stats, lastVerdicts).map((row) => ({
      ...row,
      blocked: blocked.has(row.host),
    }))
    c.header('Cache-Control', 'no-store')
    return c.json({ hosts: merged, judgeAt: lastJudgeAt })
  })

  /**
   * 触发识别。
   *
   * AI 是显式动作而不是采集时自动跑：用户可能只是开着代理看流量，
   * 不该因为采样就悄悄消耗算力。
   */
  routes.post('/judge', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { useAi?: boolean; limit?: number }
      | null
    const col = getCollector()
    const hosts = col.hostNames()
    if (!hosts.length) {
      return c.json({ ok: false, error: '还没有采集到域名，先开始采集并让设备产生流量' }, 400)
    }

    const useAi = body?.useAi === true
    const limit = Number(body?.limit)
    const knownAds = await readKnownAds(deps.env())

    const summary = await judgeHosts(hosts, knownAds, useAi ? getAi() : null, {
      useAi,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : undefined,
    })

    // 合并进已有结果（分次识别时不要丢掉上次的）
    for (const [k, v] of summary.verdicts) lastVerdicts.set(k, v)
    lastJudgeAt = new Date().toISOString()

    const adCount = [...summary.verdicts.values()].filter((v) => v.isAd).length
    return c.json({
      ok: true,
      judged: summary.verdicts.size,
      recommended: adCount,
      stats: summary.stats,
      aiUsed: summary.aiUsed,
      aiError: summary.aiError,
    })
  })

  /**
   * 加入屏蔽。
   *
   * 只接受显式传入的域名列表，不提供"全部广告一键屏蔽"——
   * 代理模式下封错一个域名可能导致 App 登录失败，必须让人过一遍。
   */
  routes.post('/block', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { hosts?: unknown } | null
    const hosts = Array.isArray(body?.hosts)
      ? body.hosts.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
      : []
    if (!hosts.length) return c.json({ ok: false, error: 'hosts 为空' }, 400)
    if (hosts.length > 200) return c.json({ ok: false, error: '一次最多屏蔽 200 个' }, 400)

    try {
      const r = await addBlocked(deps.env(), hosts)
      return c.json({
        ok: true,
        added: r.added,
        existed: r.existed,
        builtin: r.builtin,
        invalid: r.invalid,
      })
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : '写入失败' }, 500)
    }
  })

  /** 重置单例（测试用） */
  routes.post('/__reset', (c) => {
    collector?.stop()
    collector = null
    aiJudge = null
    lastVerdicts = new Map()
    lastJudgeAt = null
    return c.json({ ok: true })
  })

  return routes
}
