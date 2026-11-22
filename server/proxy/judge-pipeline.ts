/**
 * 代理流量的识别编排（三层，前一层命中就不往下走）。
 *
 * 为什么分层而不是全交给模型：
 *   - 977 条广告规则库是人工维护的实测结果，比 4B 模型可靠
 *   - 内置服务商表（友盟/TalkingData 等）归属确定，问模型纯浪费算力
 *   - 模型只用来补"没见过但语义明显"的域名
 *
 * 反过来也成立：模型判 normal 不能推翻规则库判的 ad。
 * 所以这里只有"命中即定"和"未命中才问"，没有互相覆盖。
 *
 * 与浏览器抓包的差异：代理模式拿不到 URL 路径，也判不了一方/第三方，
 * 所以 ad-detect 的路径特征和第三方逻辑在这里实际不生效，
 * 只用到它的规则库匹配与域名特征部分。
 */
import { detectAd } from '../capture/ad-detect.ts'
import { AiJudge, type AiCategory, type AiVerdict } from './ai-judge.ts'
import type { HostStat } from './aggregate.ts'

/** 识别来源，界面上用来解释结论从哪来 */
export type JudgeSource = 'rule' | 'vendor' | 'pattern' | 'ai' | 'none'

export interface HostAdVerdict {
  host: string
  /** 是否建议屏蔽 */
  isAd: boolean
  strength: 'high' | 'medium' | 'low'
  source: JudgeSource
  /** 人话依据 */
  signals: string[]
  /** 仅 AI 判定有 */
  confidence?: number
  /** AI 给的原始分类，便于区分广告 / 追踪 / 普通 SDK */
  category?: AiCategory
}

/** AI 置信度低于这个值只展示不建议屏蔽 */
export const AI_MIN_CONFIDENCE = 0.8

/** 从广告规则清单文本里抽域名集合 */
export function parseAdRuleDomains(content: string): Set<string> {
  const out = new Set<string>()
  for (const line of (content || '').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    // hosts 写法「0.0.0.0 域名」，取最后一列
    const parts = t.split(/\s+/)
    const d = parts[parts.length - 1]?.toLowerCase()
    if (!d) continue
    if (d === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(d)) continue
    out.add(d)
  }
  return out
}

/**
 * 对单个域名做判定（不调 AI 的部分）。
 *
 * 返回 null 表示"本地证据不足，需要交给模型"。
 */
export function judgeLocal(host: string, knownAds: ReadonlySet<string>): HostAdVerdict | null {
  const r = detectAd({
    host,
    // 代理模式拿不到 URL，也判不了一方/第三方
    url: undefined,
    thirdParty: true,
    knownAds,
  })
  if (!r.strength) return null

  // 区分来源：规则库命中 vs 内置表/域名特征
  const fromRule = r.signals.some((s) => s.includes('广告规则'))
  const source: JudgeSource = fromRule ? 'rule' : 'vendor'

  if (r.isAd) {
    return {
      host,
      isAd: true,
      strength: r.strength === 'high' ? 'high' : 'medium',
      source,
      signals: r.signals,
    }
  }
  // 有线索但不足（如只有路径特征）——代理模式下基本不会走到这
  return {
    host,
    isAd: false,
    strength: 'low',
    source: 'pattern',
    signals: r.signals,
  }
}

/** 把 AI 结果转成统一结构 */
export function fromAi(v: AiVerdict): HostAdVerdict {
  const isAdLike = v.category === 'ad' || v.category === 'track'
  const strong = v.confidence >= AI_MIN_CONFIDENCE
  return {
    host: v.domain,
    isAd: isAdLike && strong,
    strength: isAdLike ? (strong ? 'medium' : 'low') : 'low',
    source: 'ai',
    confidence: v.confidence,
    category: v.category,
    signals: [
      `AI 判定为${v.category === 'ad' ? '广告' : v.category === 'track' ? '追踪' : v.category === 'sdk' ? '第三方 SDK' : '正常'}` +
        `（置信度 ${v.confidence.toFixed(2)}）` +
        (isAdLike && !strong ? '，低于阈值仅供参考' : ''),
    ],
  }
}

export interface JudgeOptions {
  /** 是否启用 AI 兜底 */
  useAi: boolean
  /** 只判这些域名（默认全部） */
  limit?: number
}

export interface JudgeSummary {
  /** 域名 → 结论 */
  verdicts: Map<string, HostAdVerdict>
  /** 各来源命中数 */
  stats: { rule: number; vendor: number; ai: number; none: number }
  /** AI 调用是否成功；失败时界面要提示"仅规则判定" */
  aiUsed: boolean
  aiError: string | null
}

/**
 * 跑完整流水线。
 *
 * @param hosts 待判域名
 * @param knownAds 广告规则域名集合
 * @param ai AI 客户端（useAi=false 时不会调用）
 */
export async function judgeHosts(
  hosts: readonly string[],
  knownAds: ReadonlySet<string>,
  ai: AiJudge | null,
  options: JudgeOptions = { useAi: false },
): Promise<JudgeSummary> {
  const verdicts = new Map<string, HostAdVerdict>()
  const stats = { rule: 0, vendor: 0, ai: 0, none: 0 }

  const targets = options.limit ? hosts.slice(0, options.limit) : hosts
  const needAi: string[] = []

  // 第一、二层：本地证据
  for (const host of targets) {
    const local = judgeLocal(host, knownAds)
    if (local) {
      verdicts.set(host, local)
      if (local.source === 'rule') stats.rule += 1
      else stats.vendor += 1
    } else {
      needAi.push(host)
    }
  }

  let aiUsed = false
  let aiError: string | null = null

  // 第三层：AI 兜底（只问本地判不出的）
  if (options.useAi && ai && needAi.length) {
    try {
      const aiMap = await ai.judge(needAi)
      if (aiMap.size) aiUsed = true
      for (const [host, v] of aiMap) {
        verdicts.set(host, fromAi(v))
        stats.ai += 1
      }
      aiError = ai.lastError ?? null
    } catch (err) {
      aiError = err instanceof Error ? err.message : String(err)
    }
  }

  // 没有任何结论的
  for (const host of targets) {
    if (!verdicts.has(host)) {
      stats.none += 1
      verdicts.set(host, {
        host,
        isAd: false,
        strength: 'low',
        source: 'none',
        signals: [options.useAi ? '本地与 AI 均未给出明确结论' : '仅做了本地判定，未启用 AI'],
      })
    }
  }

  return { verdicts, stats, aiUsed, aiError }
}

/** 把结论合并回聚合行，供界面直接渲染 */
export function mergeVerdicts(
  stats: readonly HostStat[],
  verdicts: Map<string, HostAdVerdict>,
): Array<HostStat & { ad?: HostAdVerdict }> {
  return stats.map((s) => {
    const v = verdicts.get(s.host)
    return v ? { ...s, ad: v } : { ...s }
  })
}
