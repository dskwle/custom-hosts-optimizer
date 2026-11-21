/**
 * `/local/capture/*` 抓包诊断接口（除 GET /env 之外的全部端点）。
 *
 * 挂载方式（由主 agent 在 server/index.ts 里加，本文件不自己挂）：
 *
 *   root.route("/local/capture", createCaptureRoutes(() => env as any, () => resolveCdpUrl()))
 *
 * 为什么是工厂函数：`env`（KV）与 CDP 地址都由挂载方决定，这里不读 process.env、
 * 也不 import server/index.ts，便于单独起一个假 KV 做联调。
 *
 * 鉴权由外层中间件负责：/local/* 不在公开白名单里，未登录会先被 401 拦掉，
 * 所以这里不做任何二次校验。
 */

import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Bindings } from '../../src/types.ts'
import { CaptureHttpError, CaptureManager } from '../capture/session.ts'
import type { CaptureFrame } from '../capture/stream.ts'
import { probeDomain } from '../probe.ts'
import { ALL_DOMAINS } from '../../src/constants.ts'
import { addCustomDomain, getCustomDomains, removeCustomDomain } from '../../src/services/hosts.ts'
import { addBlocked, getBlocklist, normalizeDomain } from '../../src/services/blocklist.ts'

/**
 * 单次 apply 最多处理多少个域名。
 *
 * 每个域名都要现场 probe（DNS + TCP + 多次 TLS 握手，秒级），
 * 4 并发下 50 个已经要十几秒。再多就不该同步等在这个接口里了，
 * 与其悄悄截断让用户以为全处理了，不如明确报错让他分批。
 */
const APPLY_MAX_HOSTS = 50
/** probe 并发。4 与 /local/refresh 的默认并发 8 相比更保守：这里通常是交互式等待，稳比快重要 */
const PROBE_CONCURRENCY = 4

export interface ApplyResult {
  added: string[]
  skipped: Array<{ domain: string; reason: string }>
  failed: Array<{ domain: string; error: string }>
}

/**
 * 会话管理器在模块级共享。
 *
 * "单会话"约束要求全进程只有一份 live 表；如果每次 createCaptureRoutes 都 new 一个，
 * 重复挂载（比如将来把 /local/capture 拆成两个子路由）会让约束失效。
 */
let sharedManager: CaptureManager | null = null

export function createCaptureRoutes(getEnv: () => Bindings, getCdpUrl: () => string): Hono {
  const routes = new Hono()
  if (!sharedManager) sharedManager = new CaptureManager(getCdpUrl)
  const manager = sharedManager

  // ---------------------------------------------------------------- 会话生命周期

  routes.post('/start', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as
        | { url?: unknown; storeUrls?: unknown }
        | null
      const session = await manager.start({ url: body?.url, storeUrls: body?.storeUrls })
      return c.json({ session })
    } catch (err) {
      return fail(c, err)
    }
  })

  routes.get('/', async (c) => {
    const limit = Number(c.req.query('limit') || 20)
    const sessions = await manager.list(Number.isFinite(limit) ? limit : 20)
    c.header('Cache-Control', 'no-store')
    return c.json({ sessions })
  })

  routes.get('/:id', async (c) => {
    const detail = await manager.detail(c.req.param('id'))
    if (!detail) return c.json({ error: 'session not found' }, 404)
    c.header('Cache-Control', 'no-store')
    return c.json({ session: detail.session, requests: detail.requests })
  })

  routes.get('/:id/summary', async (c) => {
    const id = c.req.param('id')
    const hosts = await manager.summary(id)
    if (!hosts) return c.json({ error: 'session not found' }, 404)
    c.header('Cache-Control', 'no-store')
    return c.json({ sessionId: id, hosts })
  })

  routes.post('/:id/stop', async (c) => {
    try {
      const session = await manager.stop(c.req.param('id'))
      return c.json({ session })
    } catch (err) {
      return fail(c, err)
    }
  })

  /**
   * SSE。契约 §3：四种帧（state/request/error/end），15s 一条 `: ping` 保活。
   *
   * 重连语义：连上先补一帧当前 state，**不重放历史**（一次抓包上千条请求，
   * 重放既慢又会让前端出现重复行）；明细由前端调 /:id 与 /summary 补全。
   */
  routes.get('/:id/stream', async (c) => {
    const id = c.req.param('id')
    const detail = await manager.detail(id)
    if (!detail) return c.json({ error: 'session not found' }, 404)
    const initial = detail.session

    return streamSSE(c, async (stream) => {
      let finished = false
      let unsubscribe: () => void = () => {}
      let ping: ReturnType<typeof setInterval> | null = null
      let resolveDone: () => void = () => {}

      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })

      const send = (frame: CaptureFrame) => {
        if (finished) return
        // 写失败说明连接已经断了，hono 内部会吞掉错误，这里不需要额外处理
        void stream.write(`data: ${JSON.stringify(frame)}\n\n`)
      }

      const finish = () => {
        if (finished) return
        finished = true
        unsubscribe()
        if (ping) clearInterval(ping)
        resolveDone()
      }

      send({ type: 'state', session: initial })

      unsubscribe = manager.streams.subscribe(id, (frame) => {
        send(frame)
        if (frame.type === 'end') finish()
      })

      // 反代与浏览器都会掐掉长时间静默的连接，15s 一条注释行是 SSE 的常规做法
      ping = setInterval(() => {
        if (!finished) void stream.write(': ping\n\n')
      }, 15_000)

      // 历史会话或已经结束的会话：补一帧 end 立刻断开，别让前端挂着一个永远没数据的连接
      if (initial.status === 'stopped' || initial.status === 'failed') {
        send({ type: 'end', sessionId: id })
        finish()
      }

      // 客户端断开（关页面、刷新）必须退订，否则 publish 会一直往死连接写
      stream.onAbort(finish)
      c.req.raw.signal.addEventListener('abort', finish)

      await done
    })
  })

  // ---------------------------------------------------------------- 应用动作

  routes.post('/apply', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { hosts?: unknown; action?: unknown }
      | null
    const rawHosts = Array.isArray(body?.hosts) ? body!.hosts.map((h) => String(h ?? '')) : []
    const hosts = [...new Set(rawHosts.map((h) => h.trim()).filter(Boolean))]
    const action = body?.action

    if (!hosts.length) return c.json({ error: 'hosts 为空' }, 400)
    if (hosts.length > APPLY_MAX_HOSTS) {
      return c.json({ error: `单次最多 ${APPLY_MAX_HOSTS} 个域名，请分批提交` }, 400)
    }
    if (action !== 'accel' && action !== 'block') {
      return c.json({ error: 'action 必须是 accel 或 block' }, 400)
    }

    try {
      const env = getEnv()
      const result = action === 'accel' ? await applyAccel(env, hosts) : await applyBlock(env, hosts)
      return c.json(result)
    } catch (err) {
      return fail(c, err)
    }
  })

  return routes
}

/**
 * 进程退出前调用：释放浏览器标签页。
 *
 * 不接这个钩子也不会崩，但 noVNC 里会留下一个个 about:blank 页签。
 * 挂载方加一行即可（本 lane 不改 server/index.ts）：
 *   process.on('SIGINT', () => { void shutdownCaptureSessions().finally(() => process.exit(0)) })
 */
export async function shutdownCaptureSessions(): Promise<void> {
  await sharedManager?.shutdown()
}

// ---------------------------------------------------------------- apply 实现

/**
 * 加速：探测最优 IP 后写自定义域名。
 *
 * skip 语义与 /local/adopt 完全一致：已内置、已在自定义、已屏蔽都不算失败。
 * 这里额外多做一步 SNI 判定——probe 结果里 sni.verdict 为 sni-blocked 时**不能**
 * 写 hosts（改了也没用，还会让用户以为修好了），记为 failed 并给出可读原因。
 */
async function applyAccel(env: Bindings, hosts: string[]): Promise<ApplyResult> {
  const result: ApplyResult = { added: [], skipped: [], failed: [] }

  const builtinSet = new Set(ALL_DOMAINS.map((d) => d.toLowerCase()))
  const customSet = new Set((await getCustomDomains(env)).map((d) => d.domain.toLowerCase()))
  const blockedSet = new Set((await getBlocklist(env)).map((b) => b.domain.toLowerCase()))

  const pending: string[] = []
  for (const raw of hosts) {
    const domain = normalizeDomain(raw)
    if (!domain) {
      result.failed.push({ domain: raw, error: '域名非法（不支持 IP 或非法字符）' })
      continue
    }
    if (builtinSet.has(domain)) {
      result.skipped.push({ domain, reason: '内置加速' })
      continue
    }
    if (customSet.has(domain)) {
      result.skipped.push({ domain, reason: '已在自定义域名' })
      continue
    }
    if (blockedSet.has(domain)) {
      result.skipped.push({ domain, reason: '已屏蔽' })
      continue
    }
    // 同一批里重复出现只探一次
    customSet.add(domain)
    pending.push(domain)
  }

  await pool(pending, PROBE_CONCURRENCY, async (domain) => {
    try {
      const probe = await probeDomain(domain, { checkSni: true })
      if (probe.sni?.verdict === 'sni-blocked') {
        result.failed.push({ domain, error: '疑似 SNI 阻断，改 hosts 无效，建议走代理' })
        return
      }
      if (!probe.bestIp) {
        result.failed.push({ domain, error: '没有 TLS 握手成功的 IP' })
        return
      }
      const saved = await addCustomDomain(env, domain, probe.bestIp)
      if (!saved) {
        result.failed.push({ domain, error: '写入自定义域名失败' })
        return
      }
      result.added.push(domain)
    } catch (err) {
      result.failed.push({ domain, error: err instanceof Error ? err.message : String(err) })
    }
  })

  return result
}

/**
 * 屏蔽：指向 0.0.0.0 / ::。
 *
 * 与 POST /local/blocklist 保持一致——新加的屏蔽域名要从自定义域名里摘掉，
 * 否则 hosts 里会同时出现"指向优选 IP"和"指向 0.0.0.0"两条互相矛盾的记录。
 */
async function applyBlock(env: Bindings, hosts: string[]): Promise<ApplyResult> {
  const result: ApplyResult = { added: [], skipped: [], failed: [] }
  const r = await addBlocked(env, hosts)

  result.added.push(...r.added)
  for (const domain of r.existed) result.skipped.push({ domain, reason: '已屏蔽' })
  for (const domain of r.builtin) result.skipped.push({ domain, reason: '内置屏蔽' })
  for (const domain of r.invalid) result.failed.push({ domain, error: '域名非法' })

  for (const domain of r.added) {
    try {
      await removeCustomDomain(env, domain)
    } catch {
      /* 不在自定义域名里就忽略 */
    }
  }
  return result
}

/** 小并发池：probe 是秒级网络 IO，串行跑 10 个域名会让按钮转半分钟 */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await fn(item)
    }
  })
  await Promise.all(workers)
}

// ---------------------------------------------------------------- 错误映射

function fail(c: Context, err: unknown): Response {
  if (err instanceof CaptureHttpError) {
    return c.json({ error: err.message }, err.status as 500)
  }
  console.error('[capture] 未预期错误', err)
  return c.json({ error: err instanceof Error ? err.message : '内部错误' }, 500)
}
