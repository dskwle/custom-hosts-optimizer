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

/**
 * 哪些域名值得做联网重判。
 *
 * 只挑「判为正常/SDK 但可能漏」的和「本地完全没结论」的：
 * 每个域名约 5s，全量跑不现实，也没必要——已经判成广告的无需再查。
 */
export function pickDeepCandidates(
  verdicts: Map<string, HostAdVerdict>,
): string[] {
  const out: string[] = []
  for (const [host, v] of verdicts) {
    if (v.isAd) continue // 已经是广告，不用再查
    if (v.source === 'none') {
      out.push(host)
      continue
    }
    // AI 判成 normal/sdk 且没到"非常确信"的程度 —— 这类最容易漏。
    // 边界取 <=0.95 而不是 <0.95：实测模型对 adjoe.io 就是给 0.95 却判错，
    // 过度自信的错判恰恰是联网核查最该抓的。
    if (v.source === 'ai' && (v.confidence ?? 0) <= 0.95) out.push(host)
  }
  return out
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
        `（置信度 ${v.confidence.toFixed(2)}${v.searched ? '，已联网核实' : ''}）` +
        (isAdLike && !strong ? '，低于阈值仅供参考' : ''),
    ],
  }
}

export interface JudgeOptions {
  /** 是否启用 AI 兜底 */
  useAi: boolean
  /** 只判这些域名（默认全部） */
  limit?: number
  /**
   * 是否对可疑域名做联网深度重判。
   *
   * 实测：批量开检索是纯浪费（7.5s→12.9s，结果零变化），
   * 只有逐个用域名检索才有效（adjoe.io: normal→ad）。
   * 所以这里限制成"只查 pickDeepCandidates 挑出来的那几个"。
   */
  deep?: boolean
}

export interface JudgeSummary {
  /** 域名 → 结论 */
  verdicts: Map<string, HostAdVerdict>
  /** 各来源命中数 */
  stats: { rule: number; vendor: number; ai: number; none: number }
  /** AI 调用是否成功；失败时界面要提示"仅规则判定" */
  aiUsed: boolean
  aiError: string | null
  /** 联网深度重判的域名数 */
  deepCount?: number
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

  // 第四层：联网深度重判（只针对可疑的少数）
  let deepCount = 0
  if (options.deep && ai) {
    // 注意要补上"还没有任何结论"的域名：
    // 它们此刻还不在 verdicts 里（"无结论"填充在下面），但恰恰最需要联网核实。
    // 早先只用 pickDeepCandidates(verdicts) 会把这类整体漏掉。
    const unresolved = targets.filter((h) => !verdicts.has(h))
    const candidates = [...new Set([...pickDeepCandidates(verdicts), ...unresolved])]
    if (candidates.length) {
      try {
        const deepMap = await ai.judgeDeep(candidates)
        deepCount = deepMap.size
        for (const [host, v] of deepMap) {
          const updated = fromAi(v)
          verdicts.set(host, updated)
          // 原来记在 ai 的数要去掉，改记 deep（避免重复计）
          if (stats.ai > 0) stats.ai -= 1
          stats.ai += 1
        }
      } catch (err) {
        aiError = err instanceof Error ? err.message : String(err)
      }
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

  return { verdicts, stats, aiUsed, aiError, deepCount }
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
