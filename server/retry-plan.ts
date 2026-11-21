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

export interface PlanInput {
  /** 全部失败计数记录 */
  failures: readonly RetryCandidate[]
  /** 已在排除清单里的域名（这些不再重试，除非被显式复核） */
  blocked: Iterable<string>
  /** 单轮最多测多少个，避免一轮打满占满整分钟 */
  limit: number
  /** 现在的时间戳（ms），用于判断是否到期 */
  now: number
  /** 重试间隔（ms），默认 60000 */
  intervalMs?: number
}

export interface PlanResult {
  /** 本轮要重试的域名，按「最早到期的优先」排序 */
  due: string[]
  /** 还有多少未到期的，供日志说明 */
  waiting: number
}

/**
 * 选出本轮到期需要重试的域名。
 *
 * 规则：
 *   1. 已在排除清单的跳过——已经判死，再测就是浪费（复核走单独接口）
 *   2. 距上次失败不足 intervalMs 的跳过——没到重试时间
 *   3. 按 lastFailedAt 升序（最早失败的先测），避免总是同一批排在前面饿死后面的
 *   4. 截断到 limit
 */
export function planRetry(input: PlanInput): PlanResult {
  const blocked = new Set<string>()
  for (const d of input.blocked) blocked.add(String(d).toLowerCase())

  const interval = input.intervalMs ?? 60_000

  const ready: RetryCandidate[] = []
  let waiting = 0
  for (const f of input.failures) {
    if (blocked.has(f.domain.toLowerCase())) continue
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

  return {
    due: ready.slice(0, Math.max(0, input.limit)).map((f) => f.domain),
    waiting,
  }
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
