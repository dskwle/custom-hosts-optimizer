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
import { clearStoredSessions, deleteSession, listStoredSessions } from '../capture/store.ts'
import { markExisting, type ExistingSets } from '../capture/existing.ts'
import { detectAd } from '../capture/ad-detect.ts'
import { getAdsRules, getAdsEnabled } from '../../src/services/ads.ts'
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
/** end 帧之后保持连接的时长（方案 A）：给前端留时间收完最后一帧再断 */
const END_LINGER_MS = 5_000

/**
 * 当前生效的三类规则集合，用于给抓包结果打「已有规则」标签。
 * 读失败（KV 未就绪）时返回空集合：最多少几个标签，不能让整个 summary 接口挂掉。
 */
async function readExistingSets(env: Bindings): Promise<ExistingSets> {
  let customAccel = new Set<string>()
  let blocked = new Set<string>()
  try {
    customAccel = new Set((await getCustomDomains(env)).map((d) => d.domain.trim().toLowerCase()))
  } catch (err) {
    console.error('[capture] 读取自定义域名失败', err)
  }
  try {
    blocked = new Set((await getBlocklist(env)).map((b) => b.domain.trim().toLowerCase()))
  } catch (err) {
    console.error('[capture] 读取屏蔽清单失败', err)
  }
  return {
    builtin: new Set(ALL_DOMAINS.map((d) => d.trim().toLowerCase())),
    customAccel,
    blocked,
  }
}

/**
 * 读已启用的广告规则，抽成域名集合，供抓包结果做广告识别。
 * 未启用或还没抓到规则时返回空集合：识别退化为仅靠域名特征，不影响接口可用。
 */
async function readAdRuleSet(env: Bindings): Promise<Set<string>> {
  const out = new Set<string>()
  try {
    if (!(await getAdsEnabled(env))) return out
    const meta = await getAdsRules(env)
    if (!meta?.content) return out
    for (const line of meta.content.split('\n')) {
      const parts = line.trim().split(/\s+/)
      // hosts 写法是「0.0.0.0 域名」，取最后一列
      const d = parts[parts.length - 1]?.toLowerCase()
      if (d && !d.startsWith('#')) out.add(d)
    }
  } catch (err) {
    console.error('[capture] 读取广告规则失败', err)
  }
  return out
}

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
    // 已有规则的域名不再默认勾选，并带上归类标签供前端单独列一列
    const marked = markExisting(hosts, await readExistingSets(getEnv()))
    // 广告识别：规则集合为主线，域名特征作补充，结果只用于"建议屏蔽"
    const adRules = await readAdRuleSet(getEnv())
    // 已屏蔽的域名同样要判：结果显示"广告"能说明当初为什么屏蔽它，
    // 否则用户只看到一行「已屏蔽」，无从复核这个决定对不对。
    const withAds = marked.map((h) => {
      const v = detectAd({
        host: h.host,
        url: undefined, // summary 不带完整 URL，路径特征留给详情页
        thirdParty: h.thirdParty,
        knownAds: adRules,
      })
      return v.strength ? { ...h, ad: { isAd: v.isAd, strength: v.strength, signals: v.signals } } : h
    })
    c.header('Cache-Control', 'no-store')
    return c.json({ sessionId: id, hosts: withAds })
  })

  /**
   * 预览：把候选 IP 映射进抓包浏览器，只影响该标签页。
   *
   * 这是「先试后写」的关键一步——系统 hosts 完全不动，
   * 页面按新映射重载后，用真实抓包数字判断这个 IP 到底值不值得写。
   */
  routes.post('/:id/preview', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { mappings?: Record<string, string> | Array<{ domain: string; ip: string }> }
      | null

    // 两种入参都收：前端从表格勾选时是数组，手填时是对象
    const mappings: Record<string, string> = {}
    if (Array.isArray(body?.mappings)) {
      for (const m of body.mappings) {
        if (m && typeof m.domain === 'string' && typeof m.ip === 'string') {
          mappings[m.domain] = m.ip
        }
      }
    } else if (body?.mappings && typeof body.mappings === 'object') {
      Object.assign(mappings, body.mappings)
    }
    if (!Object.keys(mappings).length) {
      return c.json({ error: 'mappings 为空' }, 400)
    }

    try {
      const preview = await manager.applyPreview(c.req.param('id'), mappings)
      return c.json({ ok: true, preview })
    } catch (err) {
      return fail(c, err)
    }
  })

  /**
   * 探测 + 应用预览：一步到位。
   *
   * 用户勾选的通常是一批域名，前端如果自己先逐个 probe 再调 preview，
   * 要写两套轮询逻辑。这里合并：后端探出每个域名的最优 IP，直接映射进去。
   *
   * 只映射「能握手成功」的，探不通的直接跳过并在 skipped 里说明，
   * 避免把一个不可用的 IP 映射进去让页面白屏。
   */
  routes.post('/:id/preview/probe', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { hosts?: unknown } | null
    const hosts = Array.isArray(body?.hosts)
      ? body.hosts.map((x) => String(x).trim().toLowerCase()).filter(Boolean)
      : []
    if (!hosts.length) return c.json({ error: 'hosts 为空' }, 400)
    if (hosts.length > APPLY_MAX_HOSTS) {
      return c.json({ error: `一次最多预览 ${APPLY_MAX_HOSTS} 个域名` }, 400)
    }

    const env = getEnv()
    const mappings: Record<string, string> = {}
    const skipped: Array<{ domain: string; reason: string }> = []

    await pool(hosts, PROBE_CONCURRENCY, async (domain) => {
      try {
        const probe = await probeDomain(domain, { checkSni: true, qualityRounds: 2 })
        if (probe.sni?.verdict === 'sni-blocked') {
          skipped.push({ domain, reason: 'SNI 阻断，改 hosts 无效' })
          return
        }
        if (!probe.bestIp) {
          skipped.push({ domain, reason: '没有能完成 TLS 握手的 IP' })
          return
        }
        mappings[domain] = probe.bestIp
      } catch (err) {
        skipped.push({ domain, reason: `探测失败：${(err as Error).message}` })
      }
    })

    if (!Object.keys(mappings).length) {
      return c.json({ error: '勾选的域名全部无法探测到可用 IP', skipped }, 400)
    }

    try {
      const preview = await manager.applyPreview(c.req.param('id'), mappings)
      return c.json({ ok: true, preview, mappings, skipped })
    } catch (err) {
      return fail(c, err)
    }
  })

  /** 预览对比：同一域名在映射前后的耗时并排比 */
  routes.get('/:id/preview', async (c) => {
    const r = await manager.previewCompare(c.req.param('id'))
    if (!r) return c.json({ ok: false, error: '当前没有进行中的预览' }, 404)
    c.header('Cache-Control', 'no-store')
    return c.json({ ok: true, ...r })
  })

  /** 撤销预览，恢复正常解析 */
  routes.delete('/:id/preview', async (c) => {
    const ok = await manager.clearPreview(c.req.param('id'))
    return c.json({ ok })
  })

  routes.post('/:id/stop', async (c) => {
    try {
      const session = await manager.stop(c.req.param('id'))
      return c.json({ session })
    } catch (err) {
      return fail(c, err)
    }
  })

  // ---------------------------------------------------------------- 会话清理

  /**
   * 清空/批量清理。放在 `/:id` 之前无所谓（方法不同），但语义上属于"会话集合"。
   *
   * 正在抓包的会话一律拒绝：它还在往磁盘写，删了会让 stop 之后的落盘把文件又写回来，
   * 用户看到"删了又出现"。让调用方先停再删，行为可预期。
   */
  routes.post('/purge', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { ids?: unknown; all?: unknown }
      | null
    const wantAll = body?.all === true
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((x): x is string => typeof x === 'string')
      : []

    if (!wantAll && ids.length === 0) {
      return c.json({ error: '请指定要清理的会话（ids），或传 all=true 清空全部' }, 400)
    }

    // 运行中的会话集合：manager.list 会把 live 与磁盘合并，status=running 即 live
    const running = new Set(
      (await manager.list(1000)).filter((s) => s.status === 'running').map((s) => s.id),
    )

    const deleted: string[] = []
    const failed: Array<{ id: string; reason: string }> = []

    if (wantAll) {
      // 一次扫目录按文件名删，保留运行中的，损坏文件也一并清掉
      const keep = running
      const storedIds = new Set(
        (await listStoredSessions(Number.MAX_SAFE_INTEGER)).map((s) => s.id),
      )
      const removed = await clearStoredSessions(keep)
      for (const id of storedIds) {
        if (!keep.has(id)) deleted.push(id)
      }
      // removed 可能比 deleted 多（损坏文件没有 id 可报），差额记在 failed 之外不体现
      for (const id of keep) failed.push({ id, reason: '正在抓包，请先停止' })
      c.header('Cache-Control', 'no-store')
      return c.json({ deleted, failed, removed })
    } else {
      for (const id of ids) {
        if (running.has(id)) {
          failed.push({ id, reason: '正在抓包，请先停止' })
          continue
        }
        try {
          if (await deleteSession(id)) deleted.push(id)
          else failed.push({ id, reason: '会话不存在' })
        } catch (err) {
          failed.push({ id, reason: err instanceof Error ? err.message : String(err) })
        }
      }
    }

    c.header('Cache-Control', 'no-store')
    return c.json({ deleted, failed })
  })

  /** 删除单个会话。路径参数直接进文件名，store 里已做 id 白名单校验 */
  routes.delete('/:id', async (c) => {
    const id = c.req.param('id')
    const running = (await manager.list(1000)).some((s) => s.id === id && s.status === 'running')
    if (running) return c.json({ error: '该会话正在抓包，请先停止再清理' }, 409)
    try {
      const ok = await deleteSession(id)
      if (!ok) return c.json({ error: 'session not found' }, 404)
      c.header('Cache-Control', 'no-store')
      return c.json({ deleted: [id], failed: [] })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
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
      let lingering = false
      let unsubscribe: () => void = () => {}
      let ping: ReturnType<typeof setInterval> | null = null
      let lingerTimer: ReturnType<typeof setTimeout> | null = null
      let resolveDone: () => void = () => {}

      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })

      const send = (frame: CaptureFrame) => {
        if (finished) return
        // 写失败说明连接已经断了，hono 内部会吞掉错误，这里不需要额外处理
        void stream.write(`data: ${JSON.stringify(frame)}\n\n`)
      }

      const teardown = () => {
        if (finished) return
        finished = true
        if (lingerTimer) clearTimeout(lingerTimer)
        lingerTimer = null
        unsubscribe()
        if (ping) clearInterval(ping)
        resolveDone()
      }

      /**
       * end 帧之后**保持 5 秒**再关连接（主 agent 选定的方案 A）。
       *
       * 立刻关会有个实际窗口：前端刚收到 end 就断线，浏览器把这次断线当成
       * "网络抖动"触发重连，于是又多一次 /summary 请求。留 5s 足够 TCP/代理
       * 把最后一帧送出去，重连时再补一句 end 直接关。
       */
      const closeAfterLinger = () => {
        if (finished || lingering) return
        lingering = true
        lingerTimer = setTimeout(teardown, END_LINGER_MS)
      }

      send({ type: 'state', session: initial })

      unsubscribe = manager.streams.subscribe(id, (frame) => {
        send(frame)
        if (frame.type === 'end') closeAfterLinger()
      })

      // 反代与浏览器都会掐掉长时间静默的连接，15s 一条注释行是 SSE 的常规做法
      ping = setInterval(() => {
        if (!finished) void stream.write(': ping\n\n')
      }, 15_000)

      // 重连到一个已经结束的会话：补 state + end 后直接关，不留 5s（不会再有数据了）
      if (initial.status === 'stopped' || initial.status === 'failed') {
        // 用 await 保证两帧真的写出去再关：立刻 close 会把排队中的数据丢掉
        await stream.write(`data: ${JSON.stringify({ type: 'state', session: initial })}\n\n`)
        await stream.write(`data: ${JSON.stringify({ type: 'end', sessionId: id })}\n\n`)
        teardown()
        return
      }

      // 客户端断开（关页面、刷新）必须退订，否则 publish 会一直往死连接写
      stream.onAbort(teardown)
      c.req.raw.signal.addEventListener('abort', teardown)

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
      // 交互式批量（最多 50 个域名），用 2 轮质量测量区分稳定与否；
      // 批量刷新那一路走默认 3 轮。都不再是"一次握手成功就算可用"。
      const probe = await probeDomain(domain, { checkSni: true, qualityRounds: 2 })
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
  // 内置项也报"已屏蔽"：前端按关键字映射标签（内置/屏蔽/存在），
  // 自创"内置屏蔽"虽然含"屏蔽"能匹配上，但会让三处文案不统一
  for (const domain of r.builtin) result.skipped.push({ domain, reason: '已屏蔽' })
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
