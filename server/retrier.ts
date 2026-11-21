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
import { markBlocked, getBlockedDomains, listBlocked, unmarkBlocked } from './blocked.js'
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
  /** 已排除域名的复查间隔，默认 30 分钟 */
  blockedIntervalMs?: number
}

export interface RetrierStats {
  rounds: number
  examined: number
  recovered: number
  blocklisted: number
  /** 从排除清单里复查的数量 */
  rechecked: number
  /** 复查后确认恢复、已移出清单的数量 */
  recheckRecovered: number
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
  rechecked: 0,
  recheckRecovered: 0,
  lastRunAt: null,
  running: false,
}

export function retrierStats(): RetrierStats {
  return { ...stats }
}

/**
 * 是否该把这次失败计入「连续失败」。
 *
 * 计入的条件是「探测确实跑到了 SNI 判定阶段」：
 *   - sni-blocked：真实阻断，累计（到阈值才判死）
 *   - unknown：含超时，同样没测通，累计但永不判死（见 shouldBlocklist）
 *
 * 不计入的是「压根没连上目标」的情况：DNS 解析不出（uniqueIpCount === 0）、
 * 全部候选 TCP 不通（tcp-blocked）。这类是环境或域名本身的问题，
 * 让它累计只会把 DNS 失效的域名也拖进队列、每分钟白测一次。
 */
function shouldCountFailure(verdict: string | undefined, uniqueIpCount: number): boolean {
  if (verdict === 'sni-blocked' || verdict === 'unknown') return true
  // 有候选 IP 但都没有 SNI 结论（极少见），说明跑过了探测，按 unknown 处理
  return verdict === undefined && uniqueIpCount > 0
}

/**
 * 跑一轮。导出出来便于手动触发（排障接口）与单测。
 */
export interface RoundResult {
  examined: number
  recovered: number
  blocklisted: number
  rechecked: number
  recheckRecovered: number
}

const EMPTY_ROUND: RoundResult = {
  examined: 0,
  recovered: 0,
  blocklisted: 0,
  rechecked: 0,
  recheckRecovered: 0,
}

export async function runRetryRound(
  env: any,
  options: RetrierOptions = {},
): Promise<RoundResult> {
  const batchLimit = options.batchLimit ?? 20
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const threshold = options.threshold ?? FAILURE_THRESHOLD

  const [failures, blockedEntries] = await Promise.all([listFailures(), listBlocked()])
  if (!failures.length && !blockedEntries.length) return EMPTY_ROUND

  const plan = planRetry({
    failures,
    // 已排除域名也参与，但走更长的复查间隔：
    // SNI 阻断可能解除，只靠用户手点「重新检测」不现实。
    blocked: blockedEntries.map((e) => ({ domain: e.domain, blockedAt: e.blockedAt })),
    limit: batchLimit,
    now: Date.now(),
    intervalMs: options.intervalMs ?? 60_000,
    blockedIntervalMs: options.blockedIntervalMs ?? 30 * 60_000,
  })
  if (!plan.due.length && !plan.recheck.length) return EMPTY_ROUND

  stats.rounds += 1
  stats.running = true

  let recovered = 0
  let blocklisted = 0
  let recheckRecovered = 0
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

        if (!shouldCountFailure(verdict, probe.uniqueIpCount)) {
          // DNS 解析不出 / TCP 全不通：属于环境或域名本身的问题，
          // 不累计也不判死；清掉已有计数，避免这类域名长期占着队列被反复白测。
          await clearFailure(domain)
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

  // 复查已排除域名：通了就自动移出清单，让用户不必手动点「重新检测」
  let recheckCursor = 0
  if (plan.recheck.length) {
    const recheckWorker = async () => {
      while (recheckCursor < plan.recheck.length) {
        const domain = plan.recheck[recheckCursor]
        recheckCursor += 1
        try {
          // 复查用 useCache:false：缓存命中的是旧结论，复查就失去意义
          const probe = await probeDomain(domain, { checkSni: true, useCache: false })
          if (probe.bestIp) {
            await unmarkBlocked(domain)
            recheckRecovered += 1
            console.log(`[retrier] ${domain} 复查已恢复，移出 SNI 阻断清单`)
          }
        } catch (err) {
          console.error(`[retrier] ${domain} 复查异常`, err)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, plan.recheck.length) }, recheckWorker),
    )
  }

  stats.examined += plan.due.length
  stats.recovered += recovered
  stats.blocklisted += blocklisted
  stats.rechecked += plan.recheck.length
  stats.recheckRecovered += recheckRecovered
  stats.lastRunAt = new Date().toISOString()
  stats.running = false

  if (recovered || blocklisted || recheckRecovered) {
    console.log(
      `[retrier] 本轮重试 ${plan.due.length} 个（恢复 ${recovered}，判定阻断 ${blocklisted}），` +
        `复查已排除 ${plan.recheck.length} 个（恢复 ${recheckRecovered}）`,
    )
  }
  return {
    examined: plan.due.length,
    recovered,
    blocklisted,
    rechecked: plan.recheck.length,
    recheckRecovered,
  }
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
