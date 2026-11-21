/**
 * 后台重试器：每分钟把失败过的域名重新探一遍。
 *
 * 与 scheduler(2 小时全量刷新) 的分工：
 *   - 全量刷新：定期把所有域名探一遍，产出 hosts 数据
 *   - 本模块：只盯「探测失败的」域名，更高频地重试，直到连续失败达到阈值才判死
 *
 * 这样偶发失败能在几分钟内自愈，而不是等到下一轮全量刷新（最长 2 小时）；
 * 真正被阻断的域名则在约一小时后自动进入排除清单，不再拖慢刷新。
 *
 * 单轮并发刻意压低（默认 4）：这是后台任务，不该抢占全量刷新或用户手动操作的带宽。
 */

import { probeDomain } from './probe.js'
import { clearFailure, listExhausted, listFailures, recordFailure, FAILURE_THRESHOLD } from './failures.js'
import { planRetry, shouldBlocklist } from './retry-plan.js'
import { markBlocked, getBlockedDomains } from './blocked.js'
import { addCustomDomain, getCustomDomains } from '../src/services/hosts.js'
import { ALL_DOMAINS } from '../src/constants.js'

export interface RetrierOptions {
  /** 检查间隔，默认 60s */
  intervalMs?: number
  /** 单轮最多测多少域名，默认 20 */
  batchLimit?: number
  /** 单轮并发，默认 4 */
  concurrency?: number
  /** 连续失败阈值，默认 60 */
  threshold?: number
}

export interface RetrierStats {
  rounds: number
  examined: number
  recovered: number
  blocklisted: number
  lastRunAt: string | null
  running: boolean
}

let timer: NodeJS.Timeout | null = null
let busy = false
const stats: RetrierStats = {
  rounds: 0,
  examined: 0,
  recovered: 0,
  blocklisted: 0,
  lastRunAt: null,
  running: false,
}

export function retrierStats(): RetrierStats {
  return { ...stats }
}

/** 是否该把这次失败计入「连续失败」：只有 SNI 类失败才值得累计 */
function countsAsSniFailure(verdict?: string): boolean {
  // sni-blocked 之外，unknown（含超时）也累计：
  // 它同样是"没测通"，只是暂时不能据此判死；判死还要看 shouldBlocklist 的
  // verdict === 'sni-blocked' 条件，所以这里放宽不会误封。
  return verdict === 'sni-blocked' || verdict === 'unknown'
}

/**
 * 跑一轮。导出出来便于手动触发（排障接口）与单测。
 */
export async function runRetryRound(
  env: any,
  options: RetrierOptions = {},
): Promise<{ examined: number; recovered: number; blocklisted: number }> {
  const batchLimit = options.batchLimit ?? 20
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const threshold = options.threshold ?? FAILURE_THRESHOLD

  const [failures, blockedSet] = await Promise.all([listFailures(), getBlockedDomains()])
  if (!failures.length) return { examined: 0, recovered: 0, blocklisted: 0 }

  const plan = planRetry({
    failures,
    blocked: blockedSet,
    limit: batchLimit,
    now: Date.now(),
    intervalMs: options.intervalMs ?? 60_000,
  })
  if (!plan.due.length) return { examined: 0, recovered: 0, blocklisted: 0 }

  stats.rounds += 1
  stats.running = true

  let recovered = 0
  let blocklisted = 0
  let cursor = 0

  const worker = async () => {
    while (cursor < plan.due.length) {
      const domain = plan.due[cursor]
      cursor += 1
      try {
        const probe = await probeDomain(domain, { checkSni: true, useCache: false })
        const ok = !!probe.bestIp
        const verdict = probe.sni?.verdict

        if (ok) {
          // 通了：计数清零，顺手确认自定义域名里的地址是否还可用
          await clearFailure(domain)
          recovered += 1
          continue
        }

        if (!countsAsSniFailure(verdict)) {
          // TCP 不通 / DNS 失败属于环境问题，不该让域名背锅：既不累计也不判死
          continue
        }

        const consecutive = await recordFailure(domain, {
          error: probe.sni?.withSni?.error ?? probe.sni?.explanation,
          verdict,
        })

        if (shouldBlocklist({ ok: false, verdict, consecutive, threshold })) {
          await markBlocked(domain, {
            reason:
              `连续 ${consecutive} 次探测失败（每分钟重试一次，约 ${Math.round(consecutive / 60)} 小时），` +
              (probe.sni?.explanation ?? '真实 SNI 握手持续被切断。'),
            withSniError: probe.sni?.withSni?.error,
            withoutSniMs: probe.sni?.withoutSni?.ms,
          })
          await clearFailure(domain)
          blocklisted += 1
          console.log(`[retrier] ${domain} 连续失败 ${consecutive} 次，已列入 SNI 阻断清单`)
        }
      } catch (err) {
        console.error(`[retrier] ${domain} 重试异常`, err)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, plan.due.length) }, worker))

  stats.examined += plan.due.length
  stats.recovered += recovered
  stats.blocklisted += blocklisted
  stats.lastRunAt = new Date().toISOString()
  stats.running = false

  if (recovered || blocklisted) {
    console.log(`[retrier] 本轮测 ${plan.due.length} 个，恢复 ${recovered}，判定阻断 ${blocklisted}`)
  }
  return { examined: plan.due.length, recovered, blocklisted }
}

/**
 * 启动后台重试。重复调用无副作用。
 *
 * 启动后先延迟 30s 再跑第一轮：避开进程刚起来时的初始化高峰
 * （KV 加载、首轮 hosts 生成都在这个窗口）。
 */
export function startRetrier(env: any, options: RetrierOptions = {}): void {
  if (timer) return
  const interval = options.intervalMs ?? 60_000

  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await runRetryRound(env, options)
    } catch (err) {
      console.error('[retrier] 本轮失败', err)
    } finally {
      busy = false
    }
  }

  setTimeout(() => void tick(), 30_000)
  timer = setInterval(() => void tick(), interval)
  // 后台任务不该阻止进程退出
  timer.unref?.()
  console.log(`[retrier] 已启动：每 ${Math.round(interval / 1000)}s 重试失败域名，连续失败 ${options.threshold ?? FAILURE_THRESHOLD} 次判定阻断`)
}

export function stopRetrier(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}
