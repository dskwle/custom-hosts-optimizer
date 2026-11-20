import { Bindings } from "./types"
import { ALL_DOMAINS } from "./constants"
import { fetchLatestHostsData, storeData } from "./services/hosts"

// 每片处理的域名数。
// 单域名最多 2 次 DNS + 2 次 TCP = 4 个 subrequest，
// 8 个域名约 32 个，安全落在免费版 50 个/请求的限制内。
const CHUNK_SIZE = 8

// 单轮刷新总预算。超出后主动停止后续分片，避免撞上 cron 执行上限
// 导致「前半成功、后半静默丢弃」。
const BUDGET_MS = 240_000

/**
 * 定时任务：按片刷新全部域名。
 *
 * 之所以拆片而不是一次跑完：Cloudflare 每个请求最多 50 个 subrequest，
 * 130+ 个域名需要 500+ 次外部调用，单请求必然中途抛错。
 * 这里串行发起内部请求，每片独立计数，同时避免并发写 KV 造成数据互相覆盖。
 */
export async function handleSchedule(
  event: ScheduledEvent,
  env: Bindings
): Promise<void> {
  const total = ALL_DOMAINS.length
  console.log(`Scheduled refresh start: ${total} domains, chunk ${CHUNK_SIZE}`)

  const baseUrl = env.WORKER_URL || ""

  // 未配置 WORKER_URL 时退化为单次全量（会超出 subrequest 上限，仅作兜底）
  if (!baseUrl) {
    console.warn("WORKER_URL 未配置，降级为单次全量抓取，可能中断")
    try {
      const resolved = await fetchLatestHostsData()
      await storeData(env, resolved)
      console.log(`Fallback refresh done: ${resolved.length}/${total}`)
    } catch (error) {
      console.error("Fallback refresh failed:", error)
    }
    return
  }

  const offsets: number[] = []
  for (let i = 0; i < total; i += CHUNK_SIZE) {
    offsets.push(i)
  }

  let ok = 0
  let failed = 0
  let skipped = 0
  const startedAt = Date.now()

  for (const offset of offsets) {
    if (Date.now() - startedAt > BUDGET_MS) {
      skipped = offsets.length - ok - failed
      console.warn(`budget exceeded (${BUDGET_MS}ms), skip ${skipped} remaining chunks`)
      break
    }

    try {
      const res = await fetch(
        `${baseUrl}/internal/refresh?offset=${offset}&limit=${CHUNK_SIZE}`,
        {
          method: "POST",
          headers: { "x-internal-token": env.INTERNAL_TOKEN || "" },
        }
      )

      if (res.ok) {
        const body = (await res.json()) as { resolved?: number }
        ok++
        console.log(`chunk ${offset}: ${body.resolved ?? 0} resolved`)
      } else {
        failed++
        console.error(`chunk ${offset}: HTTP ${res.status}`)
      }
    } catch (error) {
      failed++
      console.error(`chunk ${offset} failed:`, error)
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(
    `Scheduled refresh finished in ${elapsed}s: ${ok} ok / ${failed} failed / ${skipped} skipped (${total} domains)`
  )
}
