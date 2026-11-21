/**
 * 后台重试调度（纯逻辑部分）。
 *
 * 需求：探测失败的域名每分钟重试一次；连续失败超过阈值才判死。
 *
 * 这里只管「这一轮该测哪些域名」这个决策，真正的探测与写清单由调用方注入，
 * 这样调度逻辑可以单测，不必起真网络。
 */

export interface RetryCandidate {
  domain: string
  consecutive: number
  lastFailedAt: string
}

export interface BlockedCandidate {
  domain: string
  /** 判定时间（ISO），用于按"最久没复查"排序 */
  blockedAt: string
}

export interface PlanInput {
  /** 全部失败计数记录 */
  failures: readonly RetryCandidate[]
  /**
   * 已在排除清单里的域名。
   *
   * 这些域名不是"永不重试"，而是走更长的复查间隔：
   * SNI 阻断可能解除（中间设备策略调整、换了出口线路），
   * 只靠用户手动点「重新检测」是不现实的——实际没人会天天点。
   */
  blocked?: readonly BlockedCandidate[]
  /** 单轮最多测多少个，避免一轮打满占满整分钟 */
  limit: number
  /** 现在的时间戳（ms），用于判断是否到期 */
  now: number
  /** 重试间隔（ms），默认 60000 */
  intervalMs?: number
  /** 已排除域名的复查间隔（ms），默认 30 分钟 */
  blockedIntervalMs?: number
}

export interface PlanResult {
  /** 本轮要重试的失败域名，按「最早到期的优先」排序 */
  due: string[]
  /** 本轮要复查的已排除域名，按「最久没复查」排序 */
  recheck: string[]
  /** 还有多少未到期的失败域名，供日志说明 */
  waiting: number
}

/**
 * 选出本轮要处理的两类域名。
 *
 * 失败域名（走短间隔，默认 1 分钟）：
 *   1. 距上次失败不足 intervalMs 的跳过
 *   2. 按 lastFailedAt 升序（最早失败的先测），避免总是同一批排在前面饿死后面的
 *
 * 已排除域名（走长间隔，默认 30 分钟）：
 *   3. 距判定时间不足 blockedIntervalMs 的跳过
 *   4. 按 blockedAt 升序（最久没复查的先测）
 *
 * 两类合起来受 limit 约束，但失败域名优先：
 * 它们还有机会"自愈"回正常状态，收益比复查已判死的域名高。
 */
export function planRetry(input: PlanInput): PlanResult {
  const interval = input.intervalMs ?? 60_000
  const blockedInterval = input.blockedIntervalMs ?? 30 * 60_000

  const blockedMap = new Map<string, BlockedCandidate>()
  for (const b of input.blocked ?? []) {
    blockedMap.set(String(b.domain).toLowerCase(), b)
  }

  const ready: RetryCandidate[] = []
  let waiting = 0
  for (const f of input.failures) {
    // 已经判死的域名交给下面的复查逻辑，不能又当"失败重试"跑一遍
    if (blockedMap.has(f.domain.toLowerCase())) continue
    const last = Date.parse(f.lastFailedAt)
    // 时间戳解析失败时当作早就到期，宁可多测一次也不要卡住
    if (Number.isFinite(last) && input.now - last < interval) {
      waiting += 1
      continue
    }
    ready.push(f)
  }

  ready.sort((a, b) => {
    const ta = Date.parse(a.lastFailedAt)
    const tb = Date.parse(b.lastFailedAt)
    return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0)
  })

  const limit = Math.max(0, input.limit)
  const due = ready.slice(0, limit).map((f) => f.domain)

  // 失败域名优先占额度；剩余额度给到期的已排除域名
  const remaining = limit - due.length
  let recheck: string[] = []
  if (remaining > 0) {
    const stale: BlockedCandidate[] = []
    for (const b of blockedMap.values()) {
      const at = Date.parse(b.blockedAt)
      if (Number.isFinite(at) && input.now - at < blockedInterval) continue
      stale.push(b)
    }
    stale.sort((a, b) => {
      const ta = Date.parse(a.blockedAt)
      const tb = Date.parse(b.blockedAt)
      return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0)
    })
    recheck = stale.slice(0, remaining).map((b) => b.domain)
  }

  return { due, recheck, waiting }
}

/**
 * 判断一次重试结果是否应把域名写入排除清单。
 *
 * 三个条件同时满足才判死：
 *   1. 本次仍失败
 *   2. SNI 结论是 sni-blocked（超时/unknown 一律不算）
 *   3. 连续失败次数达到阈值
 */
export function shouldBlocklist(result: {
  ok: boolean
  verdict?: string
  consecutive: number
  threshold: number
}): boolean {
  if (result.ok) return false
  if (result.verdict !== 'sni-blocked') return false
  return result.consecutive >= result.threshold
}
